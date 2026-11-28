import { Decimal } from 'decimal.js';
import type { GateCredentials } from '../credential-vault.js';
import type { FundingPredictionRecorded, FundingSettledRecorded, RecordedMarketEvent } from '../phase1/types.js';
import {
  NativeDualMarketAdapter,
  type NativeMarketHealthReport,
} from './native-market-adapter.js';
import {
  buildCrossExShadowOrderIntent,
  type ShadowOrderIntent,
  type SimulatedCrossExGateway,
} from './shadow-gateway.js';
import type { SharedMarginCoordinator } from './shared-margin-coordinator.js';

export interface MakerTakerShadowMetrics {
  signalsEvaluated: number;
  makerQuotesPosted: number;
  makerZeroFillExpired: number;
  makerFullFillWithHedge: number;
  makerPartialFillWithHedge: number;
  makerLateFillDuringCancel: number;
  hedgeZeroOrPartialFailures: number;
  residualExposureCount: number;
  cumulativeHedgeSlippageBps: string;
  scenarioNetPnlUsd: string;
  makerLegNotGuaranteedNote: string;
}

export interface FundingStrategyShadowState {
  hasOpenPosition: boolean;
  direction: 'LONG_BN_SHORT_HL' | 'LONG_HL_SHORT_BN' | null;
  entryTs: number | null;
  qtyEth: string;
  entrySpreadCostUsd: string;
  predictedAnnualizedAtEntryPct: string | null;
  settledFundingUsd: string;
  decisionHistory: Array<{
    ts: number;
    action: 'ENTER' | 'HOLD' | 'EXIT';
    reason: string;
    predictedNetNextPeriodUsd: string;
    exitNetAfterCloseUsd: string;
  }>;
}

const SHADOW_CREDENTIALS: GateCredentials = {
  apiKey: 'shadow-only-no-live-key',
  apiSecret: 'shadow-only-no-live-secret',
};

/**
 * Shadow dual-leg fault & strategy coordinator: validates native direct market health, checks shared
 * margin reservations (enforcing zero live open limit when live cap is zero), generates protective
 * LIMIT+IOC / POC CrossEx payloads, exercises repair on partial/zero/late fills, and logs telemetry.
 */
export class Phase2ShadowCoordinator {
  readonly adapter: NativeDualMarketAdapter;
  readonly margin: SharedMarginCoordinator;
  readonly gateway: SimulatedCrossExGateway;

  constructor(params: {
    adapter: NativeDualMarketAdapter;
    margin: SharedMarginCoordinator;
    gateway: SimulatedCrossExGateway;
  }) {
    this.adapter = params.adapter;
    this.margin = params.margin;
    this.gateway = params.gateway;
  }

  /**
   * Evaluate one native dual-leg clip and generate shadow intents (never submitting real money orders).
   * If execution in simulator is requested (for fault injection testing), runs full order lifecycle
   * against SimulatedCrossExGateway including protective repair on hedge shortfalls.
   */
  async runShadowEntryClip(params: {
    clipId: string;
    strategyId: string;
    direction: 'LONG_BN_SHORT_HL' | 'LONG_HL_SHORT_BN';
    qtyEth: string;
    atMs: number;
    mode: 'TAKER_TAKER' | 'MAKER_TAKER';
    makerLeg?: 'BINANCE' | 'HYPERLIQUID';
    protectiveSlippageBps?: string;
    accountAvailableMarginUsd?: string;
    executeOnSimulator?: boolean;
  }): Promise<{
    admitted: boolean;
    blockReason: string | null;
    health: NativeMarketHealthReport;
    intents: ShadowOrderIntent[];
    residualExposureEth: string;
    settledReservationMarginUsd: string | null;
  }> {
    const health = this.adapter.evaluateHealth(params.atMs, params.qtyEth);
    if (!health.valid || !health.bnView || !health.hlView) {
      return {
        admitted: false,
        blockReason: `MARKET_INVALID:${health.reasons.join('|')}`,
        health,
        intents: [],
        residualExposureEth: '0',
        settledReservationMarginUsd: null,
      };
    }

    const catalog = this.adapter.getCatalog();
    if (!catalog) {
      return {
        admitted: false,
        blockReason: 'CATALOG_METADATA_MISSING',
        health,
        intents: [],
        residualExposureEth: '0',
        settledReservationMarginUsd: null,
      };
    }

    const longVenue = params.direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
    const shortVenue = longVenue === 'BINANCE' ? 'HYPERLIQUID' : 'BINANCE';
    const longBook = longVenue === 'BINANCE' ? health.bnView : health.hlView;
    const shortBook = shortVenue === 'BINANCE' ? health.bnView : health.hlView;
    const longPrice = longBook.bestAsk![0];
    const shortPrice = shortBook.bestBid![0];
    const longNotionalUsdt = new Decimal(params.qtyEth)
      .mul(longPrice)
      .mul(longVenue === 'BINANCE' ? 1 : health.fxRate)
      .toDecimalPlaces(6)
      .toString();

    const reservationRes = this.margin.tryReserve({
      reservationId: params.clipId,
      strategyId: params.strategyId,
      mode: 'SHADOW',
      leverage: '5',
      perLegNotionalUsd: longNotionalUsdt,
      atMs: params.atMs,
      accountAvailableMarginUsd: params.accountAvailableMarginUsd,
    });
    if (!reservationRes.ok) {
      return {
        admitted: false,
        blockReason: reservationRes.reason,
        health,
        intents: [],
        residualExposureEth: '0',
        settledReservationMarginUsd: null,
      };
    }

    const intents: ShadowOrderIntent[] = [];
    const buildForLeg = (
      venue: 'BINANCE' | 'HYPERLIQUID',
      side: 'BUY' | 'SELL',
      refPrice: string,
      isMaker: boolean,
    ): ShadowOrderIntent => buildCrossExShadowOrderIntent({
      intentId: `${params.clipId}-${venue.toLowerCase()}`,
      symbol: venue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
      side,
      semantics: isMaker ? 'MAKER_POC' : 'PROTECTIVE_LIMIT_IOC',
      qtyEth: params.qtyEth,
      referencePrice: refPrice,
      ...(params.protectiveSlippageBps ? { protectiveSlippageBps: params.protectiveSlippageBps } : {}),
      reduceOnly: false,
      catalog,
      decisionTs: params.atMs,
    });

    const makerVenue = params.mode === 'MAKER_TAKER' ? (params.makerLeg ?? longVenue) : null;
    const primaryIsLong = makerVenue ? makerVenue === longVenue : true;

    const firstIntent = primaryIsLong
      ? buildForLeg(longVenue, 'BUY', makerVenue ? longBook.bestBid![0] : longPrice, Boolean(makerVenue))
      : buildForLeg(shortVenue, 'SELL', makerVenue ? shortBook.bestAsk![0] : shortPrice, Boolean(makerVenue));
    const hedgeIntent = primaryIsLong
      ? buildForLeg(shortVenue, 'SELL', shortPrice, false)
      : buildForLeg(longVenue, 'BUY', longPrice, false);
    intents.push(firstIntent, hedgeIntent);

    if (!params.executeOnSimulator) {
      const settled = this.margin.settleReservation(params.clipId, '1');
      return {
        admitted: true,
        blockReason: null,
        health,
        intents,
        residualExposureEth: '0',
        settledReservationMarginUsd: settled?.reservedMarginUsd ?? null,
      };
    }

    // Execute primary + hedge + repair cleanly against SimulatedCrossExGateway.
    const leg1Res = await this.gateway.createOrder(SHADOW_CREDENTIALS, firstIntent.request);
    let leg1Order = await this.gateway.queryOrder(SHADOW_CREDENTIALS, leg1Res.order_id);
    if (leg1Order.state === 'OPEN') {
      // Simulate timeout -> cancel -> check for late fill during cancellation!
      await this.gateway.cancelOrder(SHADOW_CREDENTIALS, leg1Res.order_id);
      leg1Order = await this.gateway.queryOrder(SHADOW_CREDENTIALS, leg1Res.order_id);
    }

    const leg1Filled = new Decimal(leg1Order.executed_qty || '0');
    if (leg1Filled.lte(0)) {
      this.margin.releaseReservation(params.clipId);
      return {
        admitted: true,
        blockReason: null,
        health,
        intents,
        residualExposureEth: '0',
        settledReservationMarginUsd: '0',
      };
    }

    // Hedge ONLY confirmed executed quantity of leg1 (with protective LIMIT+IOC)!
    const hedgeReq = {
      ...hedgeIntent.request,
      qty: leg1Filled.toString(),
    };
    const hedgeRes = await this.gateway.createOrder(SHADOW_CREDENTIALS, hedgeReq);
    const hedgeOrder = await this.gateway.queryOrder(SHADOW_CREDENTIALS, hedgeRes.order_id);
    const leg2Filled = new Decimal(hedgeOrder.executed_qty || '0');
    const netResidual = leg1Filled.minus(leg2Filled);

    if (netResidual.gt(0)) {
      // Protective IOC failed/partial: repair residual via risk-reducing IOC flatten on leg1 side!
      const flattenSide = firstIntent.request.side === 'BUY' ? 'SELL' : 'BUY';
      const flattenIntent = buildCrossExShadowOrderIntent({
        intentId: `${params.clipId}-flatten`,
        symbol: firstIntent.symbol as 'BINANCE_FUTURE_ETH_USDT' | 'HYPERLIQUID_FUTURE_ETH_USDC',
        side: flattenSide,
        semantics: 'PROTECTIVE_LIMIT_IOC',
        qtyEth: netResidual.toString(),
        referencePrice: flattenSide === 'SELL'
          ? (firstIntent.venue === 'BINANCE' ? health.bnView.bestBid![0] : health.hlView.bestBid![0])
          : (firstIntent.venue === 'BINANCE' ? health.bnView.bestAsk![0] : health.hlView.bestAsk![0]),
        protectiveSlippageBps: params.protectiveSlippageBps ?? '25',
        reduceOnly: true,
        catalog,
        decisionTs: params.atMs,
      });
      intents.push(flattenIntent);
      await this.gateway.createOrder(SHADOW_CREDENTIALS, flattenIntent.request);
    }

    const filledRatio = leg2Filled.div(params.qtyEth).toDecimalPlaces(8).toString();
    const settled = this.margin.settleReservation(params.clipId, filledRatio);

    return {
      admitted: true,
      blockReason: null,
      health,
      intents,
      residualExposureEth: '0',
      settledReservationMarginUsd: settled?.reservedMarginUsd ?? '0',
    };
  }
}

/**
 * Independent funding-rate shadow simulator per Section 1.2 & Section 21.4: enters & exits using
 * only point-in-time visible predicted funding rates (`funding_pred`) and compares holding-to-next
 * settlement EV vs immediate close EV, while settling realized cashflows strictly from actual
 * `funding_settled` records.
 */
export function evaluateFundingStrategyPathComparison(params: {
  qtyEth: string;
  direction: 'LONG_BN_SHORT_HL' | 'LONG_HL_SHORT_BN';
  bnPred: FundingPredictionRecorded;
  hlPred: FundingPredictionRecorded;
  fxRate: string;
  currentCloseSpreadCostUsd: string;
  projectedNextCloseSpreadCostUsd: string;
  borrowingCostPerHourUsd: string;
  settledDuringHold?: readonly FundingSettledRecorded[];
}): {
  predictedNetNextPeriodUsd: string;
  holdEvUsd: string;
  closeNowEvUsd: string;
  decision: 'HOLD' | 'EXIT';
  realizedSettledFundingUsd: string;
} {
  const qty = new Decimal(params.qtyEth);
  const bnIsLong = params.direction === 'LONG_BN_SHORT_HL';
  const bnSign = bnIsLong ? -1 : 1;
  const hlSign = bnIsLong ? 1 : -1;

  // Hourly pro-rated comparison or next single settlement comparison:
  const bnInterval = params.bnPred.intervalHours ?? 8;
  const bnHourlyUsd = qty
    .mul(params.bnPred.markPrice)
    .mul(params.bnPred.fundingRate)
    .div(bnInterval)
    .mul(bnSign);
  const hlHourlyUsd = qty
    .mul(params.hlPred.indexOrOraclePrice)
    .mul(params.hlPred.fundingRate)
    .mul(params.fxRate)
    .mul(hlSign);

  const predictedNetNextHour = bnHourlyUsd.plus(hlHourlyUsd).minus(params.borrowingCostPerHourUsd);
  const closeNowEv = new Decimal(params.currentCloseSpreadCostUsd).negated();
  const holdEv = predictedNetNextHour.minus(params.projectedNextCloseSpreadCostUsd);

  let settledSum = new Decimal(0);
  for (const s of params.settledDuringHold ?? []) {
    if (s.isHistoricalBackfill) continue;
    if (s.venue === 'BINANCE') {
      settledSum = settledSum.plus(
        qty.mul(s.markPrice ?? params.bnPred.markPrice).mul(s.fundingRate).mul(bnSign),
      );
    } else {
      settledSum = settledSum.plus(
        qty
          .mul(s.nearestOraclePriceUsdc ?? params.hlPred.indexOrOraclePrice)
          .mul(s.fundingRate)
          .mul(s.nearestFxUsdcUsdt ?? params.fxRate)
          .mul(hlSign),
      );
    }
  }

  return {
    predictedNetNextPeriodUsd: predictedNetNextHour.toDecimalPlaces(8).toString(),
    holdEvUsd: holdEv.toDecimalPlaces(8).toString(),
    closeNowEvUsd: closeNowEv.toDecimalPlaces(8).toString(),
    decision: holdEv.gt(closeNowEv) ? 'HOLD' : 'EXIT',
    realizedSettledFundingUsd: settledSum.toDecimalPlaces(8).toString(),
  };
}

export function extractLatestComparableFromCxRaw(ev: RecordedMarketEvent): {
  symbol: string;
  bidPrice: string | null;
  askPrice: string | null;
  recvTs: number;
} | null {
  if (ev.type !== 'cx_raw' || ev.channel !== 'ticker') return null;
  const bid = typeof ev.payload.highest_bid === 'string' ? ev.payload.highest_bid : null;
  const ask = typeof ev.payload.lowest_ask === 'string' ? ev.payload.lowest_ask : null;
  return { symbol: ev.symbol, bidPrice: bid, askPrice: ask, recvTs: ev.recvTs };
}
