import { Decimal } from 'decimal.js';
import {
  BinanceOrderBookStateMachine,
  HyperliquidOrderBookStateMachine,
  type OrderBookView,
} from '../phase1/orderbook-state.js';
import { evaluateBookValidity, type LegAgeConfig } from '../phase1/replay.js';
import type { CaptureCatalogMeta, FxRateRecorded } from '../phase1/types.js';

export interface CrossExComparableQuote {
  symbol: string;
  bidPrice: string | null;
  askPrice: string | null;
  sourceTs: number | null;
  recvTs: number;
}

export interface NativeMarketHealthReport {
  valid: boolean;
  allowNewRisk: boolean;
  reasons: string[];
  bnStatus: string;
  hlStatus: string;
  bnView: OrderBookView | null;
  hlView: OrderBookView | null;
  fxRate: string;
  fxSource: FxRateRecorded['source'];
  fxAgeMs: number;
  crossexComparison: {
    bnDeviationBps: string | null;
    hlDeviationBps: string | null;
    bnCrossExAgeMs: number | null;
    hlCrossExAgeMs: number | null;
  };
}

export interface NativeMarketAdapterConfig {
  expectedBnSymbol: string;
  expectedHlSymbol: string;
  bnAge: LegAgeConfig;
  hlAge: LegAgeConfig;
  maxFxAgeMs: number;
  maxCrossExDeviationBps: string | null;
  allowParityFallbackFx: boolean;
}

export const DEFAULT_NATIVE_ADAPTER_CONFIG: NativeMarketAdapterConfig = {
  expectedBnSymbol: 'BINANCE_FUTURE_ETH_USDT',
  expectedHlSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
  bnAge: { maxRecvAgeMs: 15_000, maxSourceAgeMs: 15_000, futureSourceToleranceMs: 2_000 },
  hlAge: { maxRecvAgeMs: 15_000, maxSourceAgeMs: 15_000, futureSourceToleranceMs: 2_000 },
  maxFxAgeMs: 120_000,
  maxCrossExDeviationBps: '50',
  allowParityFallbackFx: true,
};

function computeMidpoint(bid: string, ask: string): Decimal {
  return new Decimal(bid).plus(ask).div(2);
}

/**
 * Phase 2 native direct market adapter combining Binance USD-M and Hyperliquid order book
 * state machines with explicit contract identity, connection generation health, dual timestamp
 * freshness, depth sufficiency, FX validity, and CrossEx comparable deviation telemetry.
 */
export class NativeDualMarketAdapter {
  readonly bnMachine = new BinanceOrderBookStateMachine();
  readonly hlMachine = new HyperliquidOrderBookStateMachine();

  private catalog: CaptureCatalogMeta | null = null;
  private lastFx: { rate: string; ts: number; source: FxRateRecorded['source'] } = {
    rate: '1',
    ts: 0,
    source: 'parity_fallback',
  };
  private cxQuotes = new Map<string, CrossExComparableQuote>();
  private bnInGapRecovery = false;

  constructor(private readonly config: NativeMarketAdapterConfig = DEFAULT_NATIVE_ADAPTER_CONFIG) {}

  setCatalog(catalog: CaptureCatalogMeta): void {
    this.catalog = catalog;
  }

  getCatalog(): CaptureCatalogMeta | null {
    return this.catalog;
  }

  onFxRate(rate: string, recvTs: number, source: FxRateRecorded['source']): void {
    this.lastFx = { rate, ts: recvTs, source };
  }

  onCrossExComparableQuote(quote: CrossExComparableQuote): void {
    this.cxQuotes.set(quote.symbol, quote);
  }

  onBinanceGapDetected(): void {
    this.bnInGapRecovery = true;
    this.bnMachine.markGapResyncing();
  }

  clearBinanceGapRecovery(): void {
    this.bnInGapRecovery = false;
  }

  effectiveBnStatus(): string {
    const raw = this.bnMachine.getState();
    return this.bnInGapRecovery && raw !== 'SYNCED' ? 'INVALID_GAP' : raw;
  }

  /**
   * Validate contract identity against catalog metadata, native dual books, FX freshness,
   * and optional CrossEx comparable divergence. Stops new risk whenever any check fails.
   */
  evaluateHealth(atTs: number, requiredQtyEth?: string): NativeMarketHealthReport {
    const reasons: string[] = [];

    if (this.catalog) {
      const hasBn = this.catalog.crossexRules.some(
        (r) => r.symbol === this.config.expectedBnSymbol && r.state === 'live',
      );
      const hasHl = this.catalog.crossexRules.some(
        (r) => r.symbol === this.config.expectedHlSymbol && r.state === 'live',
      );
      if (!hasBn) reasons.push(`CATALOG_CONTRACT_MISSING_OR_INACTIVE_${this.config.expectedBnSymbol}`);
      if (!hasHl) reasons.push(`CATALOG_CONTRACT_MISSING_OR_INACTIVE_${this.config.expectedHlSymbol}`);
    }

    const bnView = this.bnMachine.view();
    const hlView = this.hlMachine.view();
    const bnStatus = this.effectiveBnStatus();
    const hlStatus = this.hlMachine.getState();

    const bnCheck = evaluateBookValidity(bnView, atTs, this.config.bnAge, bnStatus);
    const hlCheck = evaluateBookValidity(hlView, atTs, this.config.hlAge, hlStatus);
    if (!bnCheck.valid) reasons.push(`BN_${bnCheck.reason}`);
    if (!hlCheck.valid) reasons.push(`HL_${hlCheck.reason}`);

    if (requiredQtyEth) {
      if (bnCheck.valid) {
        if (!bnCheck.view.walkBids(requiredQtyEth).fillable || !bnCheck.view.walkAsks(requiredQtyEth).fillable) {
          reasons.push('BN_INSUFFICIENT_VISIBLE_DEPTH');
        }
      }
      if (hlCheck.valid) {
        if (!hlCheck.view.walkBids(requiredQtyEth).fillable || !hlCheck.view.walkAsks(requiredQtyEth).fillable) {
          reasons.push('HL_INSUFFICIENT_VISIBLE_DEPTH');
        }
      }
    }

    const fxAgeMs = this.lastFx.ts > 0 ? Math.max(0, atTs - this.lastFx.ts) : Number.POSITIVE_INFINITY;
    if (!this.config.allowParityFallbackFx && this.lastFx.source === 'parity_fallback') {
      reasons.push('FX_PARITY_FALLBACK_DISALLOWED');
    } else if (this.lastFx.ts > 0 && fxAgeMs > this.config.maxFxAgeMs) {
      reasons.push('FX_STALE');
    }

    const cxBn = this.cxQuotes.get(this.config.expectedBnSymbol);
    const cxHl = this.cxQuotes.get(this.config.expectedHlSymbol);
    let bnDeviationBps: string | null = null;
    let hlDeviationBps: string | null = null;

    if (bnCheck.valid && bnCheck.view.bestBid && bnCheck.view.bestAsk && cxBn?.bidPrice && cxBn?.askPrice) {
      const nativeMid = computeMidpoint(bnCheck.view.bestBid[0], bnCheck.view.bestAsk[0]);
      const cxMid = computeMidpoint(cxBn.bidPrice, cxBn.askPrice);
      bnDeviationBps = nativeMid.minus(cxMid).div(nativeMid).mul(10_000).toDecimalPlaces(4).toString();
      if (
        this.config.maxCrossExDeviationBps !== null
        && new Decimal(bnDeviationBps).abs().gt(this.config.maxCrossExDeviationBps)
      ) {
        reasons.push('BN_CROSSEX_DEVIATION_EXCEEDED');
      }
    }

    if (hlCheck.valid && hlCheck.view.bestBid && hlCheck.view.bestAsk && cxHl?.bidPrice && cxHl?.askPrice) {
      const nativeMid = computeMidpoint(hlCheck.view.bestBid[0], hlCheck.view.bestAsk[0]);
      const cxMid = computeMidpoint(cxHl.bidPrice, cxHl.askPrice);
      hlDeviationBps = nativeMid.minus(cxMid).div(nativeMid).mul(10_000).toDecimalPlaces(4).toString();
      if (
        this.config.maxCrossExDeviationBps !== null
        && new Decimal(hlDeviationBps).abs().gt(this.config.maxCrossExDeviationBps)
      ) {
        reasons.push('HL_CROSSEX_DEVIATION_EXCEEDED');
      }
    }

    const valid = reasons.length === 0;
    return {
      valid,
      allowNewRisk: valid,
      reasons,
      bnStatus,
      hlStatus,
      bnView: bnCheck.valid ? bnCheck.view : null,
      hlView: hlCheck.valid ? hlCheck.view : null,
      fxRate: this.lastFx.rate,
      fxSource: this.lastFx.source,
      fxAgeMs: Number.isFinite(fxAgeMs) ? fxAgeMs : -1,
      crossexComparison: {
        bnDeviationBps,
        hlDeviationBps,
        bnCrossExAgeMs: cxBn ? Math.max(0, atTs - cxBn.recvTs) : null,
        hlCrossExAgeMs: cxHl ? Math.max(0, atTs - cxHl.recvTs) : null,
      },
    };
  }
}
