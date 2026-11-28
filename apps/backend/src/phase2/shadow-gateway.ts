import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { GateCredentials } from '../credential-vault.js';
import {
  CrossExOrderRequestSchema,
  GateApiError,
  type CrossExOrderRequest,
  type GateCrossExAccount,
  type GateCrossExOrder,
  type GateCrossExPortfolio,
  type GateCrossExPosition,
  type GateCrossExRiskLimit,
  type GateCrossExSymbol,
  type GateCrossExTrade,
  type GateFeeRate,
  type GateLeverageResponse,
  type GateOrderActionResponse,
  type TradingCrossExGateway,
} from '../crossex-client.js';
import type { CaptureCatalogMeta } from '../phase1/types.js';

export type ShadowOrderSemantics = 'PROTECTIVE_LIMIT_IOC' | 'MAKER_POC' | 'MARKET_IOC';

export interface ShadowOrderIntent {
  intentId: string;
  semantics: ShadowOrderSemantics;
  request: CrossExOrderRequest;
  symbol: string;
  venue: 'BINANCE' | 'HYPERLIQUID';
  lotSize: string;
  tickSize: string;
  unboundedPriceRisk: boolean;
  protectiveCapBps: string | null;
  referenceBookPrice: string;
  decisionTs: number;
}

export interface OrderLifecycleTimestamps {
  orderId: string;
  decisionTs: number;
  queuedTs: number;
  dispatchedTs: number;
  ackedTs: number | null;
  firstFillTs: number | null;
  terminalFillTs: number | null;
  cancelRequestedTs: number | null;
  cancelConfirmedTs: number | null;
}

export function roundDecimalToStep(value: Decimal, step: string, mode: 'up' | 'down'): Decimal {
  const s = new Decimal(step);
  if (!s.gt(0)) return value;
  return value.div(s).toDecimalPlaces(0, mode === 'up' ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR).mul(s);
}

/**
 * Construct and schema-validate a CrossEx order payload for ETH contracts against official
 * catalog step/tick/minNotional rules, separating capped PROTECTIVE_LIMIT_IOC, MAKER_POC,
 * and unbounded MARKET_IOC validation.
 */
export function buildCrossExShadowOrderIntent(params: {
  intentId: string;
  symbol: 'BINANCE_FUTURE_ETH_USDT' | 'HYPERLIQUID_FUTURE_ETH_USDC';
  side: 'BUY' | 'SELL';
  semantics: ShadowOrderSemantics;
  qtyEth: string;
  referencePrice: string;
  protectiveSlippageBps?: string;
  reduceOnly: boolean;
  positionSide?: 'NONE' | 'LONG' | 'SHORT';
  catalog: CaptureCatalogMeta;
  decisionTs: number;
}): ShadowOrderIntent {
  const rule = params.catalog.crossexRules.find((r) => r.symbol === params.symbol);
  if (!rule || rule.state !== 'live') {
    throw new Error(`Contract ${params.symbol} not live in CrossEx catalog`);
  }
  const qty = roundDecimalToStep(new Decimal(params.qtyEth), rule.lotSize, 'down');
  if (qty.lt(rule.minSize)) {
    throw new Error(`Rounded qty ${qty.toString()} < minSize ${rule.minSize} for ${params.symbol}`);
  }
  const refPrice = new Decimal(params.referencePrice);
  const notional = qty.mul(refPrice);
  if (rule.minNotional && notional.lt(rule.minNotional)) {
    throw new Error(`Order notional ${notional.toString()} < minNotional ${rule.minNotional} for ${params.symbol}`);
  }

  let type: 'LIMIT' | 'MARKET' = 'LIMIT';
  let timeInForce: 'IOC' | 'POC' = 'IOC';
  let price: string | undefined;
  let protectiveCapBps: string | null = null;
  let unboundedPriceRisk = false;

  if (params.semantics === 'PROTECTIVE_LIMIT_IOC') {
    type = 'LIMIT';
    timeInForce = 'IOC';
    const capBps = new Decimal(params.protectiveSlippageBps ?? '10');
    protectiveCapBps = capBps.toString();
    const rawLimit = params.side === 'BUY'
      ? refPrice.mul(new Decimal(1).plus(capBps.div(10_000)))
      : refPrice.mul(new Decimal(1).minus(capBps.div(10_000)));
    price = roundDecimalToStep(rawLimit, rule.tickSize, params.side === 'BUY' ? 'up' : 'down').toString();
  } else if (params.semantics === 'MAKER_POC') {
    type = 'LIMIT';
    timeInForce = 'POC';
    price = roundDecimalToStep(refPrice, rule.tickSize, params.side === 'BUY' ? 'down' : 'up').toString();
  } else {
    type = 'MARKET';
    timeInForce = 'IOC';
    unboundedPriceRisk = true;
  }

  const request = CrossExOrderRequestSchema.parse({
    text: params.intentId.slice(0, 64),
    symbol: params.symbol,
    side: params.side,
    type,
    time_in_force: timeInForce,
    qty: qty.toString(),
    ...(price !== undefined ? { price } : {}),
    reduce_only: params.reduceOnly ? 'true' : 'false',
    position_side: params.positionSide ?? 'NONE',
  });

  return {
    intentId: params.intentId,
    semantics: params.semantics,
    request,
    symbol: params.symbol,
    venue: params.symbol.startsWith('BINANCE') ? 'BINANCE' : 'HYPERLIQUID',
    lotSize: rule.lotSize,
    tickSize: rule.tickSize,
    unboundedPriceRisk,
    protectiveCapBps,
    referenceBookPrice: params.referencePrice,
    decisionTs: params.decisionTs,
  };
}

export type FaultScriptAction =
  | { kind: 'FILL'; fillQty?: string; fillPrice?: string }
  | { kind: 'ZERO_FILL_IOC' }
  | { kind: 'PARTIAL_FILL_IOC'; fillQty: string; fillPrice: string }
  | { kind: 'RESTING_POC'; lateFillOnCancelQty?: string; lateFillPrice?: string }
  | { kind: 'AMBIGUOUS_SUBMIT_THEN_FILLED'; fillQty?: string; fillPrice?: string }
  | { kind: 'REJECT_4XX'; label: string };

/**
 * Deterministic in-memory CrossEx gateway simulator implementing TradingCrossExGateway for
 * Phase 2 shadow testing and TradingRuntime recovery regressions (zero real network I/O).
 */
export class SimulatedCrossExGateway implements TradingCrossExGateway {
  readonly orders = new Map<string, GateCrossExOrder>();
  readonly orderTimestamps = new Map<string, OrderLifecycleTimestamps>();
  readonly trades: GateCrossExTrade[] = [];
  readonly submittedRequests: CrossExOrderRequest[] = [];
  readonly positions = new Map<string, GateCrossExPosition>();
  readonly cancelBehavior = new Map<string, { lateFillQty: string; lateFillPrice: string }>();

  private nextClockMs: () => number;
  private faultScripts: FaultScriptAction[] = [];
  private accountState: GateCrossExAccount;
  private feeRates: GateFeeRate[] = [];
  private symbols: GateCrossExSymbol[] = [];
  private riskLimits: GateCrossExRiskLimit[] = [];
  private tradeSeq = 0;

  constructor(options: {
    nowMs?: () => number;
    account?: GateCrossExAccount;
    feeRates?: GateFeeRate[];
    symbols?: GateCrossExSymbol[];
    riskLimits?: GateCrossExRiskLimit[];
  } = {}) {
    this.nextClockMs = options.nowMs ?? (() => Date.now());
    this.accountState = options.account ?? {
      available_margin: '2000',
      margin_balance: '2000',
      initial_margin: '0',
      maintenance_margin: '0',
      initial_margin_rate: '0',
      maintenance_margin_rate: '0',
      position_mode: 'ONE_WAY',
      account_mode: 'CROSS_EXCHANGE',
      exchange_type: 'ALL',
      update_time: String(this.nextClockMs()),
      assets: [
        {
          exchange_type: 'BINANCE',
          coin: 'USDT',
          balance: '1000',
          upnl: '0',
          equity: '1000',
          futures_initial_margin: '0',
          futures_maintenance_margin: '0',
          borrowing_initial_margin: '0',
          borrowing_maintenance_margin: '0',
          available_balance: '1000',
          liability: '0',
        },
        {
          exchange_type: 'HYPERLIQUID',
          coin: 'USDC',
          balance: '1000',
          upnl: '0',
          equity: '1000',
          futures_initial_margin: '0',
          futures_maintenance_margin: '0',
          borrowing_initial_margin: '0',
          borrowing_maintenance_margin: '0',
          available_balance: '1000',
          liability: '0',
        },
      ],
    };
    this.feeRates = options.feeRates ?? [];
    this.symbols = options.symbols ?? [];
    this.riskLimits = options.riskLimits ?? [];
  }

  enqueueFaultScript(...actions: FaultScriptAction[]): void {
    this.faultScripts.push(...actions);
  }

  private applyTradeToPosition(symbol: string, side: string, qty: Decimal, price: Decimal): void {
    const existing = this.positions.get(symbol);
    let netSigned = existing
      ? (existing.position_side.toUpperCase() === 'SHORT'
          ? new Decimal(existing.position_qty).abs().negated()
          : new Decimal(existing.position_qty).abs())
      : new Decimal(0);
    netSigned = netSigned.plus(side === 'BUY' ? qty : qty.negated());

    const absQty = netSigned.abs();
    const posSide = absQty.eq(0) ? 'NONE' : netSigned.gt(0) ? 'LONG' : 'SHORT';
    this.positions.set(symbol, {
      position_id: existing?.position_id ?? `pos-${symbol}`,
      symbol,
      position_side: posSide,
      initial_margin: absQty.mul(price).div(5).toFixed(4),
      maintenance_margin: absQty.mul(price).mul('0.01').toFixed(4),
      position_qty: absQty.toString(),
      position_value: absQty.mul(price).toFixed(4),
      upnl: '0',
      upnl_rate: '0',
      entry_price: price.toString(),
      mark_price: price.toString(),
      leverage: '5',
      max_leverage: '25',
      risk_limit: '1000000',
      fee: '0',
      funding_fee: '0',
      funding_time: String(this.nextClockMs()),
      create_time: existing?.create_time ?? String(this.nextClockMs()),
      update_time: String(this.nextClockMs()),
      closed_pnl: '0',
    });
  }

  private recordFill(order: GateCrossExOrder, qty: Decimal, price: Decimal, role: 'MAKER' | 'TAKER'): void {
    this.tradeSeq += 1;
    const prevQty = new Decimal(order.executed_qty || '0');
    const totalQty = prevQty.plus(qty);
    const prevAvg = new Decimal(order.executed_avg_price || '0');
    const nextAvg = totalQty.gt(0)
      ? prevQty.mul(prevAvg).plus(qty.mul(price)).div(totalQty).toDecimalPlaces(8)
      : new Decimal(0);
    order.executed_qty = totalQty.toString();
    order.executed_avg_price = nextAvg.toString();
    order.executed_amount = totalQty.mul(nextAvg).toDecimalPlaces(8).toString();
    order.last_executed_qty = qty.toString();
    order.last_executed_price = price.toString();
    order.last_executed_amount = qty.mul(price).toDecimalPlaces(8).toString();
    order.update_time = String(this.nextClockMs());

    const planned = new Decimal(order.qty);
    order.state = totalQty.gte(planned) ? 'FILLED' : 'PARTIALLY_FILLED';

    this.applyTradeToPosition(order.symbol, order.side, qty, price);
    this.trades.push({
      transaction_id: `tx-${this.tradeSeq}`,
      order_id: order.order_id,
      text: order.text ?? order.order_id,
      symbol: order.symbol,
      exchange_type: order.exchange_type,
      business_type: 'FUTURE',
      side: order.side,
      qty: qty.toString(),
      price: price.toString(),
      fee: qty.mul(price).mul('0.0005').toDecimalPlaces(8).toString(),
      fee_coin: order.symbol.endsWith('USDC') ? 'USDC' : 'USDT',
      fee_rate: '0.0005',
      match_role: role,
      rpnl: '0',
      position_mode: 'ONE_WAY',
      position_side: order.side === 'BUY' ? 'LONG' : 'SHORT',
      create_time: String(this.nextClockMs()),
    });
  }

  async createOrder(_credentials: GateCredentials, rawOrder: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    const orderReq = CrossExOrderRequestSchema.parse(rawOrder);
    this.submittedRequests.push(orderReq);
    const dispatchTs = this.nextClockMs();
    const script = this.faultScripts.shift() ?? { kind: 'FILL' };

    if (script.kind === 'REJECT_4XX') {
      throw new GateApiError(400, script.label);
    }

    const orderId = `sim-ord-${randomUUID().slice(0, 8)}`;
    const venue = orderReq.symbol.split('_', 1)[0] ?? 'UNKNOWN';
    const qty = new Decimal(orderReq.qty ?? '0');
    const refPrice = new Decimal(orderReq.price ?? '1700');

    const remoteOrder: GateCrossExOrder = {
      order_id: orderId,
      text: orderReq.text ?? orderId,
      client_order_id: orderReq.text ?? orderId,
      state: 'NEW',
      symbol: orderReq.symbol,
      side: orderReq.side,
      type: orderReq.type,
      attribute: '',
      exchange_type: venue,
      business_type: 'FUTURE',
      qty: qty.toString(),
      quote_qty: orderReq.quote_qty ?? '',
      price: orderReq.price ?? '',
      time_in_force: orderReq.time_in_force,
      executed_qty: '0',
      executed_amount: '0',
      executed_avg_price: '0',
      fee_coin: orderReq.symbol.endsWith('USDC') ? 'USDC' : 'USDT',
      fee: '0',
      reduce_only: orderReq.reduce_only ?? 'false',
      leverage: '5',
      reason: '',
      last_executed_qty: '0',
      last_executed_price: '0',
      last_executed_amount: '0',
      position_side: orderReq.position_side ?? 'NONE',
      create_time: String(dispatchTs),
      update_time: String(dispatchTs),
    };
    this.orders.set(orderId, remoteOrder);
    if (orderReq.text) this.orders.set(orderReq.text, remoteOrder);

    const ackTs = this.nextClockMs();
    const tsRecord: OrderLifecycleTimestamps = {
      orderId,
      decisionTs: dispatchTs,
      queuedTs: dispatchTs,
      dispatchedTs: dispatchTs,
      ackedTs: ackTs,
      firstFillTs: null,
      terminalFillTs: null,
      cancelRequestedTs: null,
      cancelConfirmedTs: null,
    };
    this.orderTimestamps.set(orderId, tsRecord);

    if (script.kind === 'FILL') {
      const fQty = new Decimal(script.fillQty ?? qty);
      const fPrice = new Decimal(script.fillPrice ?? refPrice);
      this.recordFill(remoteOrder, fQty, fPrice, orderReq.time_in_force === 'POC' ? 'MAKER' : 'TAKER');
      tsRecord.firstFillTs = this.nextClockMs();
      tsRecord.terminalFillTs = tsRecord.firstFillTs;
    } else if (script.kind === 'ZERO_FILL_IOC') {
      remoteOrder.state = 'CANCELLED';
      remoteOrder.reason = 'IOC_ZERO_FILL';
      tsRecord.cancelConfirmedTs = this.nextClockMs();
    } else if (script.kind === 'PARTIAL_FILL_IOC') {
      const fQty = new Decimal(script.fillQty);
      const fPrice = new Decimal(script.fillPrice);
      this.recordFill(remoteOrder, fQty, fPrice, 'TAKER');
      // Remainder of an IOC order cancels immediately on venue.
      remoteOrder.state = 'CANCELLED';
      remoteOrder.reason = 'IOC_PARTIAL_FILL_REMAINDER_CANCELLED';
      tsRecord.firstFillTs = this.nextClockMs();
      tsRecord.cancelConfirmedTs = tsRecord.firstFillTs;
    } else if (script.kind === 'RESTING_POC') {
      remoteOrder.state = 'OPEN';
      if (script.lateFillOnCancelQty) {
        this.cancelBehavior.set(orderId, {
          lateFillQty: script.lateFillOnCancelQty,
          lateFillPrice: script.lateFillPrice ?? refPrice.toString(),
        });
      }
    } else if (script.kind === 'AMBIGUOUS_SUBMIT_THEN_FILLED') {
      const fQty = new Decimal(script.fillQty ?? qty);
      const fPrice = new Decimal(script.fillPrice ?? refPrice);
      this.recordFill(remoteOrder, fQty, fPrice, 'TAKER');
      tsRecord.firstFillTs = this.nextClockMs();
      tsRecord.terminalFillTs = tsRecord.firstFillTs;
      throw new GateApiError(504, 'UPSTREAM_GATEWAY_TIMEOUT');
    }

    return { order_id: orderId, text: remoteOrder.text ?? orderId };
  }

  async cancelOrder(_credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    const order = this.orders.get(orderId);
    if (!order) throw new GateApiError(404, 'TRADE_ORDER_NOT_FOUND_ERROR');
    const tsRecord = this.orderTimestamps.get(order.order_id);
    if (tsRecord) tsRecord.cancelRequestedTs = this.nextClockMs();

    const late = this.cancelBehavior.get(order.order_id);
    if (late) {
      this.cancelBehavior.delete(order.order_id);
      this.recordFill(order, new Decimal(late.lateFillQty), new Decimal(late.lateFillPrice), 'MAKER');
      if (tsRecord) {
        tsRecord.firstFillTs = tsRecord.firstFillTs ?? this.nextClockMs();
        tsRecord.terminalFillTs = tsRecord.firstFillTs;
      }
    }
    if (order.state !== 'FILLED') {
      order.state = 'CANCELLED';
    }
    order.update_time = String(this.nextClockMs());
    if (tsRecord) tsRecord.cancelConfirmedTs = this.nextClockMs();
    return { order_id: order.order_id, text: order.text ?? order.order_id };
  }

  async queryOrder(_credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    const found = this.orders.get(orderId);
    if (!found) throw new GateApiError(404, 'TRADE_ORDER_NOT_FOUND_ERROR');
    return { ...found };
  }

  async queryOpenOrders(): Promise<GateCrossExOrder[]> {
    const unique = new Map<string, GateCrossExOrder>();
    for (const o of this.orders.values()) {
      if (['NEW', 'OPEN', 'PARTIALLY_FILLED'].includes(o.state)) {
        unique.set(o.order_id, { ...o });
      }
    }
    return [...unique.values()];
  }

  async queryAccount(): Promise<GateCrossExAccount> {
    return { ...this.accountState };
  }

  async querySymbols(): Promise<GateCrossExSymbol[]> {
    return this.symbols;
  }

  async queryRiskLimits(): Promise<GateCrossExRiskLimit[]> {
    return this.riskLimits;
  }

  async queryPositions(): Promise<GateCrossExPosition[]> {
    return [...this.positions.values()].filter((p) => new Decimal(p.position_qty || '0').gt(0));
  }

  async queryPortfolio(): Promise<GateCrossExPortfolio> {
    return {
      account: await this.queryAccount(),
      positions: await this.queryPositions(),
      marginPositions: [],
      openOrders: await this.queryOpenOrders(),
      recentTrades: [...this.trades],
    };
  }

  async queryLeverages(_credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(symbols.map((s) => [s, '5']));
  }

  async setLeverage(_credentials: GateCredentials, symbol: string, leverage: string): Promise<GateLeverageResponse> {
    return { symbol, leverage };
  }

  async queryFeeRates(): Promise<GateFeeRate[]> {
    return this.feeRates;
  }
}
