import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Decimal } from 'decimal.js';
import {
  BinanceOrderBookStateMachine,
  HyperliquidOrderBookStateMachine,
  type BinanceBookCheckpoint,
  type BinanceBridgeProof,
  type HyperliquidBookCheckpoint,
  type OrderBookView,
} from './orderbook-state.js';
import type {
  CaptureCatalogMeta,
  FundingSettledRecorded,
  FxRateRecorded,
  RecordedMarketEvent,
  SessionMetaEvent,
} from './types.js';

export type StrategyVersion = 'bbo_v1' | 'vwap_taker_v2';
export type Direction = 'LONG_BN_SHORT_HL' | 'LONG_HL_SHORT_BN';

export interface FeeScheduleAssumption {
  source: 'account_api' | 'vip0_fallback';
  binanceContract: string;
  binanceRole: 'TAKER';
  binanceTakerFeeRate: string;
  hyperliquidContract: string;
  hyperliquidRole: 'TAKER';
  hyperliquidTakerFeeRate: string;
  note: string;
}

export const DEFAULT_VIP0_FEES: FeeScheduleAssumption = {
  source: 'vip0_fallback',
  binanceContract: 'BINANCE_FUTURE_ETH_USDT (ETHUSDT)',
  binanceRole: 'TAKER',
  binanceTakerFeeRate: '0.0005',
  hyperliquidContract: 'HYPERLIQUID_FUTURE_ETH_USDC (ETH)',
  hyperliquidRole: 'TAKER',
  hyperliquidTakerFeeRate: '0.00045',
  note: 'Native venue fallback fees (not CrossEx account-tier rates): Binance USD-M VIP0 Taker (5 bps) and Hyperliquid Tier-0 Taker (4.5 bps)',
};

export interface LegAgeConfig {
  maxRecvAgeMs: number;
  maxSourceAgeMs: number;
  futureSourceToleranceMs: number;
}

export interface AgeTierConfig {
  label: string;
  bn: LegAgeConfig;
  hl: LegAgeConfig;
}

export interface ReplayConfig {
  budgetUsdt: string;
  plannedQtyEth: string;
  assumedLeverage: string;
  entryBpsList: string[];
  takeProfitBps: string;
  scenarioExitDepthBufferBps: string;
  minNetEntryBps: string;
  bnMaxRecvAgeMs: number;
  bnMaxSourceAgeMs: number;
  hlMaxAgeMsList: number[];
  futureSourceToleranceMs: number;
  delaysMs: number[];
  cooldownBetweenRejectsMs: number;
  fees: FeeScheduleAssumption;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  budgetUsdt: '2000',
  plannedQtyEth: '0.500',
  assumedLeverage: '5',
  entryBpsList: ['2', '1'],
  takeProfitBps: '0',
  scenarioExitDepthBufferBps: '1',
  minNetEntryBps: '0',
  bnMaxRecvAgeMs: 15_000,
  bnMaxSourceAgeMs: 15_000,
  hlMaxAgeMsList: [15_000, 10_000, 5_000],
  futureSourceToleranceMs: 2_000,
  delaysMs: [0, 100],
  cooldownBetweenRejectsMs: 1_000,
  fees: DEFAULT_VIP0_FEES,
};

export interface LegFillDetail {
  venue: 'BINANCE' | 'HYPERLIQUID';
  symbol: string;
  side: 'BUY' | 'SELL';
  qtyEth: string;
  avgPriceNative: string;
  priceCurrency: 'USDT' | 'USDC';
  fxAtExec: string;
  fxSource: string;
  avgPriceUsdt: string;
  feeRate: string;
  feeNative: string;
  feeUsdt: string;
  execTs: number;
  bookSourceTs: number;
  bookRecvTs: number;
  levelsUsed: number;
}

export interface FundingLegCashflow {
  venue: 'BINANCE' | 'HYPERLIQUID';
  settlementTime: number;
  fundingRate: string;
  qtyEth: string;
  refPriceNative: string | null;
  priceCurrency: 'USDT' | 'USDC';
  priceSource: 'settlement_mark_price' | 'settlement_nearest_oracle' | 'book_mid_fallback' | 'missing';
  fxRate: string;
  fxSource: string;
  cashflowNative: string | null;
  cashflowUsdt: string | null;
}

export interface InFlightOrderAtEnd {
  age_tier: string;
  entry_bps_threshold: string;
  strategy_version: StrategyVersion;
  delay_ms: number;
  opportunity_id: string;
  group_id: string;
  kind: 'ENTRY' | 'EXIT';
  direction: Direction;
  decision_ts: number;
  expected_arrival_ts: number;
  ended_at_ms: number;
  status: 'IN_FLIGHT_AT_END';
  reason: string;
}

export interface UnvaluedOpenPosition {
  age_tier: string;
  entry_bps_threshold: string;
  strategy_version: StrategyVersion;
  delay_ms: number;
  opportunity_id: string;
  planned_qty: string;
  unvalued_qty: string;
  reason: string;
}

export interface AgeTierCoverageReport {
  age_tier: string;
  bn_max_recv_age_ms: number;
  bn_max_source_age_ms: number;
  hl_max_recv_age_ms: number;
  hl_max_source_age_ms: number;
  future_source_tolerance_ms: number;
  total_window_ms: number;
  bn_valid_ms: number;
  hl_valid_ms: number;
  valid_overlap_ms: number;
  overlap_ratio_pct: string;
}

export interface DelayExecutionComparison {
  delayMs: number;
  delayModel: string;
  decisionTs: number;
  arrivalTs: number;
  executable: boolean;
  rejectReason: string | null;
  longFill: LegFillDetail | null;
  shortFill: LegFillDetail | null;
  entrySpreadBpsAtArrival: string | null;
  entrySpreadUsdAtArrival: string | null;
  entryFeesUsd: string | null;
}

export interface TradeScorecardRow {
  run_id: string;
  age_tier: string;
  entry_bps_threshold: string;
  strategy_version: StrategyVersion;
  delay_ms: number;
  delay_model: string;
  opportunity_id: string;
  group_id: string;
  asset: 'ETH';
  direction: Direction;
  long_venue: 'BINANCE' | 'HYPERLIQUID';
  short_venue: 'BINANCE' | 'HYPERLIQUID';
  long_symbol: string;
  short_symbol: string;
  decision: 'TRIGGERED' | 'REJECTED';
  reject_reason: string | null;
  trigger_ts: number;
  exec_arrival_ts: number | null;
  exit_decision_ts: number | null;
  exit_exec_arrival_ts: number | null;
  event_ts_left: number | null;
  event_ts_right: number | null;
  recv_ts_left: number | null;
  recv_ts_right: number | null;
  budget_usdt: string;
  planned_qty: string;
  actual_filled_qty: string;
  unit_multiplier_normalized: string;
  long_ref_price_usdt: string | null;
  planned_notional_usdt: string | null;
  denominator_rule: string;
  fx_usdc_usdt: string;
  fx_source: string;
  fee_source: 'account_api' | 'vip0_fallback';
  fee_assumption_detail: string;
  exit_assumption: string;
  bbo_entry_spread_bps: string | null;
  vwap_entry_spread_bps: string | null;
  est_exit_spread_bps: string | null;
  entry_long_fill: LegFillDetail | null;
  entry_short_fill: LegFillDetail | null;
  exit_long_fill: LegFillDetail | null;
  exit_short_fill: LegFillDetail | null;
  bn_contract_pnl_usdt: string | null;
  hl_contract_pnl_usdc: string | null;
  hl_contract_pnl_usdt: string | null;
  contract_spread_pnl_usd: string | null;
  collateral_fx_pnl_usd: string;
  collateral_fx_note: string;
  fees_4leg_usd: string | null;
  funding_events_crossed: number;
  funding_net_usd: string | null;
  funding_legs: FundingLegCashflow[];
  borrowing_cost_est_usd: string;
  borrowing_note: string;
  roundtrip_net_pnl_usd: string | null;
  roundtrip_net_bps: string | null;
  budget_roi_pct: string | null;
  is_open_at_end: boolean;
  mark_to_close_usd: string | null;
  unvalued_qty: string;
  max_naked_leg_ms: string | null;
  rest_queue_wait_ms: string | null;
  margin_used_est_usd: string | null;
  margin_used_actual_usd: string | null;
  book_gap_count: number;
  manual_intervention_count: number;
  manual_notes: string;
}

export interface VariantSummary {
  age_tier: string;
  entry_bps_threshold: string;
  strategy_version: StrategyVersion;
  delay_ms: number;
  raw_decision_ticks_evaluated: number;
  raw_candidates: number;
  logged_candidates: number;
  triggered_count: number;
  distinct_group_count: number;
  raw_reject_count: number;
  raw_reject_reasons: Record<string, number>;
  completed_roundtrips: number;
  open_at_end_count: number;
  in_flight_at_end_count: number;
  unvalued_open_count: number;
  unvalued_open_qty_eth: string;
  realized_roundtrip_pnl_usd: string;
  mark_to_close_open_pnl_usd: string;
  total_fees_usd: string;
  total_funding_net_usd: string;
  total_planned_notional_usdt: string;
  realized_net_bps: string | null;
}

export interface ReplaySuiteResult {
  runId: string;
  generatedAtIso: string;
  config: ReplayConfig;
  catalog: CaptureCatalogMeta | null;
  timelineDiagnostics: {
    startedAtMs: number;
    endedAtMs: number;
    startedAtIso: string;
    endedAtIso: string;
    eventsProcessed: number;
    binanceBridges: BinanceBridgeProof[];
    binanceGaps: Array<{ recvTs: number; connGen: number; expectedPu: string; actualPu: string; U: string; u: string }>;
    binanceGapCount: number;
    hyperliquidReconnectFirstValid: Array<{ recvTs: number; connGen: number; sourceTs: number; bidLevels: number; askLevels: number }>;
    hyperliquidStaleRejectedCount: number;
    crossexBypassCount: number;
    binanceChannelsUsed: string[];
    liveSettledFundingCount: number;
    historicalBackfillFundingCount: number;
    crossFormatPriceUpdates: {
      binance: number;
      hyperliquid: number;
      total: number;
    };
    coverageByAgeTier: AgeTierCoverageReport[];
  };
  summaries: VariantSummary[];
  rows: TradeScorecardRow[];
  inFlightOrdersAtEnd: InFlightOrderAtEnd[];
  unvaluedOpenPositions: UnvaluedOpenPosition[];
  sampleDelayComparison: {
    opportunityId: string;
    direction: Direction;
    decisionTs: number;
    zeroMs: DelayExecutionComparison;
    hundredMs: DelayExecutionComparison;
  } | null;
}

export interface PendingOrderState {
  kind: 'ENTRY' | 'EXIT';
  opportunityId: string;
  groupId: string;
  direction: Direction;
  decisionTs: number;
  arrivalTs: number;
  decisionSnapshot: {
    longRefPriceUsdt: string;
    plannedNotionalUsdt: string;
    fxRate: string;
    fxSource: string;
    bboSpreadBps: string | null;
    vwapSpreadBps: string | null;
    estExitBps: string | null;
    eventTsLeft: number;
    eventTsRight: number;
    recvTsLeft: number;
    recvTsRight: number;
  };
}

export interface OpenPositionState {
  openRow: TradeScorecardRow;
  opportunityId: string;
  groupId: string;
  direction: Direction;
  entryDecisionTs: number;
  entryExecTs: number;
  longEntryFill: LegFillDetail;
  shortEntryFill: LegFillDetail;
  plannedNotionalUsdt: string;
}

export interface VariantMetricsAccumulator {
  loggedCandidates: number;
  triggeredCount: number;
  distinctGroupCount: number;
  lastTriggeredGroupId: string | null;
  completedRoundtrips: number;
  openAtEndCount: number;
  unvaluedOpenCount: number;
  unvaluedOpenQty: string;
  realizedPnlUsd: string;
  markOpenPnlUsd: string;
  totalFeesUsd: string;
  totalFundingNetUsd: string;
  totalPlannedNotionalUsdt: string;
}

export interface StreamingReplayOptions {
  retainRowsInMemory?: boolean;
  maxRetainedRows?: number;
  onFinalizedRow?: (row: TradeScorecardRow) => void;
  /**
   * Optional pre-extracted settlement records used strictly for post-trade funding
   * accounting so late-arriving settlements match their crossed holding intervals
   * without affecting causal live trading decisions.
   */
  preloadedFundingSettlements?: readonly FundingSettledRecorded[];
}

export interface VariantCheckpoint {
  spec: VariantSpec;
  seq: number;
  groupSeq: number;
  rawDecisionTicksEvaluated: number;
  rawCandidates: number;
  rawRejectCount: number;
  rawRejectReasons: Record<string, number>;
  activeGroupId: string | null;
  lastGroupDirection: Direction | null;
  lastRejectLogTs: number;
  pendingOrder: PendingOrderState | null;
  openPosition: OpenPositionState | null;
  metrics: VariantMetricsAccumulator;
  rows: TradeScorecardRow[];
}

export interface AgeTierCoverageCheckpoint {
  config: AgeTierConfig;
  prevT: number | null;
  bnValidFrom: number;
  bnValidUntil: number;
  hlValidFrom: number;
  hlValidUntil: number;
  bnValidMs: number;
  hlValidMs: number;
  validOverlapMs: number;
}

export interface ReplayCheckpoint {
  runId: string;
  config: ReplayConfig;
  sessionMeta: SessionMetaEvent | null;
  startedAtMs: number | null;
  endedAtMs: number;
  eventsProcessed: number;
  bnBook: BinanceBookCheckpoint;
  hlBook: HyperliquidBookCheckpoint;
  lastFx: { ts: number; rate: string; source: FxRateRecorded['source'] };
  liveSettledFunding: FundingSettledRecorded[];
  accountingLiveSettlements?: FundingSettledRecorded[];
  hasPreloadedAccountingIndex?: boolean;
  historicalBackfillCount: number;
  seenSettlementKeys: string[];
  binanceBridges: BinanceBridgeProof[];
  binanceGaps: ReplaySuiteResult['timelineDiagnostics']['binanceGaps'];
  hlReconnectFirstValid: ReplaySuiteResult['timelineDiagnostics']['hyperliquidReconnectFirstValid'];
  hlStaleRejectedCount: number;
  crossexBypassCount: number;
  bnInGapRecovery: boolean;
  delaySampleRows: TradeScorecardRow[];
  coverageTrackers: AgeTierCoverageCheckpoint[];
  variants: VariantCheckpoint[];
}

export interface VariantSpec {
  ageTierLabel: string;
  bnAge: LegAgeConfig;
  hlAge: LegAgeConfig;
  entryBps: string;
  version: StrategyVersion;
  delayMs: number;
}

type BookCheckResult =
  | { valid: true; view: OrderBookView; validFrom: number; validUntil: number }
  | { valid: false; reason: string };

export function evaluateBookValidity(
  view: OrderBookView | null,
  atTs: number,
  cfg: LegAgeConfig,
  machineStatus: string,
): BookCheckResult {
  if (!view) {
    return { valid: false, reason: machineStatus === 'INVALID_GAP' ? 'BOOK_INVALID_GAP' : 'BOOK_NOT_SYNCED' };
  }
  if (!view.bestBid || !view.bestAsk) {
    return { valid: false, reason: 'EMPTY_BBO' };
  }
  const bidNum = Number(view.bestBid[0]);
  const askNum = Number(view.bestAsk[0]);
  if (!(bidNum < askNum) && (bidNum > askNum || new Decimal(view.bestBid[0]).gte(view.bestAsk[0]))) {
    return { valid: false, reason: 'CROSSED_BOOK' };
  }
  if (view.sourceTs > view.recvTs + cfg.futureSourceToleranceMs) {
    return { valid: false, reason: 'FUTURE_SOURCE_TS_EXCEEDED' };
  }
  const expiresAt = Math.min(view.recvTs + cfg.maxRecvAgeMs, view.sourceTs + cfg.maxSourceAgeMs);
  if (atTs > expiresAt || expiresAt <= view.recvTs) {
    return { valid: false, reason: 'STALE_BOOK_SOURCE_OR_RECV' };
  }
  return { valid: true, view, validFrom: view.recvTs, validUntil: expiresAt };
}

function formatInvalidBookPairReason(
  bnCheck: BookCheckResult,
  hlCheck: BookCheckResult,
  prefix: '' | 'EXEC_INVALID_' | 'FINAL_BOOK_INVALID_',
): string {
  if (!bnCheck.valid && !hlCheck.valid) {
    return `${prefix}BOTH_BN_${bnCheck.reason}_HL_${hlCheck.reason}`;
  }
  if (!bnCheck.valid) {
    return `${prefix}BN_${bnCheck.reason}`;
  }
  if (!hlCheck.valid) {
    return `${prefix}HL_${hlCheck.reason}`;
  }
  return `${prefix}UNKNOWN`;
}

function priceInUsdt(venue: 'BINANCE' | 'HYPERLIQUID', price: string, fxRate: string): string {
  if (venue === 'BINANCE') return price;
  return new Decimal(price).mul(fxRate).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString();
}

function overlapSegment(a0: number, a1: number, b0: number, b1: number): number {
  const start = Math.max(a0, b0);
  const end = Math.min(a1, b1);
  return end > start ? end - start : 0;
}

function advanceCoverageTo(tracker: AgeTierCoverageCheckpoint, nextTs: number): void {
  if (tracker.prevT === null) {
    tracker.prevT = nextTs;
    return;
  }
  if (nextTs <= tracker.prevT) return;
  const segStart = tracker.prevT;
  const segEnd = nextTs;
  tracker.bnValidMs += overlapSegment(segStart, segEnd, tracker.bnValidFrom, tracker.bnValidUntil);
  tracker.hlValidMs += overlapSegment(segStart, segEnd, tracker.hlValidFrom, tracker.hlValidUntil);
  const dualStart = Math.max(tracker.bnValidFrom, tracker.hlValidFrom);
  const dualEnd = Math.min(tracker.bnValidUntil, tracker.hlValidUntil);
  tracker.validOverlapMs += overlapSegment(segStart, segEnd, dualStart, dualEnd);
  tracker.prevT = nextTs;
}

function updateCoverageLeg(
  tracker: AgeTierCoverageCheckpoint,
  venue: 'BINANCE' | 'HYPERLIQUID',
  view: OrderBookView | null,
  status: string,
  atTs: number,
): void {
  const cfg = venue === 'BINANCE' ? tracker.config.bn : tracker.config.hl;
  const check = evaluateBookValidity(view, atTs, cfg, status);
  if (venue === 'BINANCE') {
    if (check.valid) {
      tracker.bnValidFrom = check.validFrom;
      tracker.bnValidUntil = check.validUntil;
    } else {
      tracker.bnValidFrom = atTs;
      tracker.bnValidUntil = atTs;
    }
  } else if (check.valid) {
    tracker.hlValidFrom = check.validFrom;
    tracker.hlValidUntil = check.validUntil;
  } else {
    tracker.hlValidFrom = atTs;
    tracker.hlValidUntil = atTs;
  }
}

interface TickEvaluationCache {
  tDecision: number;
  bnCheck: BookCheckResult;
  hlChecksByMaxAge: Map<number, BookCheckResult>;
  bestBbo: { direction: Direction; bboSpreadBps: string } | null;
  entryEvalByDirection: Partial<Record<Direction, ReturnType<typeof buildEntryEvaluation>>>;
  vwapDecisionByDirection: Partial<Record<Direction, {
    decisionReject: string | null;
    estExitBps: string | null;
    longRefPriceUsdt: string;
    plannedNotionalUsdt: string;
  }>>;
  exitEvalByDirection: Partial<Record<Direction, ReturnType<typeof buildExitEvaluation>>>;
}

function computeBboOnlyDirection(
  bnView: OrderBookView,
  hlView: OrderBookView,
  fxRate: string,
): { direction: Direction; bboSpreadBps: string } | null {
  if (!bnView.bestAsk || !bnView.bestBid || !hlView.bestAsk || !hlView.bestBid) {
    return null;
  }
  const bnAsk = Number(bnView.bestAsk[0]);
  const bnBid = Number(bnView.bestBid[0]);
  const hlBid = Number(hlView.bestBid[0]);
  const hlAsk = Number(hlView.bestAsk[0]);
  const fxNum = Number(fxRate);
  // Fast conservative numeric pre-screen: compute exact Decimal only for the winning side unless both sides look close.
  const approxABps = ((hlBid * fxNum - bnAsk) / bnAsk) * 10_000;
  const approxBBps = ((bnBid - hlAsk * fxNum) / (hlAsk * fxNum)) * 10_000;

  if (approxABps < -5 && approxBBps < -5 && Math.abs(approxABps - approxBBps) > 1) {
    if (approxBBps > approxABps) {
      const longBbo = new Decimal(hlView.bestAsk[0]).mul(fxRate).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
      const shortBbo = new Decimal(bnView.bestBid[0]);
      const bps = shortBbo.minus(longBbo).div(longBbo).mul(10_000).toDecimalPlaces(4).toString();
      return { direction: 'LONG_HL_SHORT_BN', bboSpreadBps: bps };
    }
    const longBbo = new Decimal(bnView.bestAsk[0]);
    const shortBbo = new Decimal(hlView.bestBid[0]).mul(fxRate).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
    const bps = shortBbo.minus(longBbo).div(longBbo).mul(10_000).toDecimalPlaces(4).toString();
    return { direction: 'LONG_BN_SHORT_HL', bboSpreadBps: bps };
  }

  const longA = new Decimal(priceInUsdt('BINANCE', bnView.bestAsk[0], fxRate));
  const shortA = new Decimal(priceInUsdt('HYPERLIQUID', hlView.bestBid[0], fxRate));
  const bpsA = shortA.minus(longA).div(longA).mul(10_000).toDecimalPlaces(4);

  const longB = new Decimal(priceInUsdt('HYPERLIQUID', hlView.bestAsk[0], fxRate));
  const shortB = new Decimal(priceInUsdt('BINANCE', bnView.bestBid[0], fxRate));
  const bpsB = shortB.minus(longB).div(longB).mul(10_000).toDecimalPlaces(4);

  if (bpsB.gt(bpsA)) {
    return { direction: 'LONG_HL_SHORT_BN', bboSpreadBps: bpsB.toString() };
  }
  return { direction: 'LONG_BN_SHORT_HL', bboSpreadBps: bpsA.toString() };
}

function buildEntryEvaluation(params: {
  direction: Direction;
  qtyEth: string;
  bnView: OrderBookView;
  hlView: OrderBookView;
  fxRate: string;
  fxSource: string;
  fees: FeeScheduleAssumption;
  ts: number;
}): {
  executable: boolean;
  rejectReason: string | null;
  longFill: LegFillDetail | null;
  shortFill: LegFillDetail | null;
  bboSpreadBps: string | null;
  vwapSpreadBps: string | null;
  vwapSpreadUsd: string | null;
  entryFeesUsd: string | null;
} {
  const longVenue = params.direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
  const shortVenue = longVenue === 'BINANCE' ? 'HYPERLIQUID' : 'BINANCE';
  const longView = longVenue === 'BINANCE' ? params.bnView : params.hlView;
  const shortView = shortVenue === 'BINANCE' ? params.bnView : params.hlView;

  if (!longView.bestAsk || !shortView.bestBid) {
    return {
      executable: false,
      rejectReason: 'EMPTY_BBO',
      longFill: null,
      shortFill: null,
      bboSpreadBps: null,
      vwapSpreadBps: null,
      vwapSpreadUsd: null,
      entryFeesUsd: null,
    };
  }

  const longBboUsdt = new Decimal(priceInUsdt(longVenue, longView.bestAsk[0], params.fxRate));
  const shortBboUsdt = new Decimal(priceInUsdt(shortVenue, shortView.bestBid[0], params.fxRate));
  const bboSpreadBps = shortBboUsdt.minus(longBboUsdt).div(longBboUsdt).mul(10_000).toDecimalPlaces(4).toString();

  const longWalk = longView.walkAsks(params.qtyEth);
  const shortWalk = shortView.walkBids(params.qtyEth);
  if (!longWalk.fillable || !shortWalk.fillable) {
    const missingVenue = !longWalk.fillable && !shortWalk.fillable
      ? 'BOTH'
      : !longWalk.fillable ? longVenue : shortVenue;
    return {
      executable: false,
      rejectReason: `INSUFFICIENT_DEPTH_${missingVenue}`,
      longFill: null,
      shortFill: null,
      bboSpreadBps,
      vwapSpreadBps: null,
      vwapSpreadUsd: null,
      entryFeesUsd: null,
    };
  }

  const longVwapUsdt = new Decimal(priceInUsdt(longVenue, longWalk.vwapPrice, params.fxRate));
  const shortVwapUsdt = new Decimal(priceInUsdt(shortVenue, shortWalk.vwapPrice, params.fxRate));
  const qty = new Decimal(params.qtyEth);

  const longFeeRate = longVenue === 'BINANCE' ? params.fees.binanceTakerFeeRate : params.fees.hyperliquidTakerFeeRate;
  const shortFeeRate = shortVenue === 'BINANCE' ? params.fees.binanceTakerFeeRate : params.fees.hyperliquidTakerFeeRate;

  const longFeeNative = qty.mul(longWalk.vwapPrice).mul(longFeeRate).toDecimalPlaces(8);
  const shortFeeNative = qty.mul(shortWalk.vwapPrice).mul(shortFeeRate).toDecimalPlaces(8);
  const longFeeUsdt = longVenue === 'BINANCE'
    ? longFeeNative
    : longFeeNative.mul(params.fxRate).toDecimalPlaces(8);
  const shortFeeUsdt = shortVenue === 'BINANCE'
    ? shortFeeNative
    : shortFeeNative.mul(params.fxRate).toDecimalPlaces(8);

  const vwapSpreadUsd = qty.mul(shortVwapUsdt.minus(longVwapUsdt)).toDecimalPlaces(8);
  const vwapSpreadBps = shortVwapUsdt.minus(longVwapUsdt).div(longVwapUsdt).mul(10_000).toDecimalPlaces(4);

  const longFill: LegFillDetail = {
    venue: longVenue,
    symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'BUY',
    qtyEth: params.qtyEth,
    avgPriceNative: longWalk.vwapPrice,
    priceCurrency: longVenue === 'BINANCE' ? 'USDT' : 'USDC',
    fxAtExec: longVenue === 'BINANCE' ? '1' : params.fxRate,
    fxSource: longVenue === 'BINANCE' ? 'native_usdt' : params.fxSource,
    avgPriceUsdt: longVwapUsdt.toString(),
    feeRate: longFeeRate,
    feeNative: longFeeNative.toString(),
    feeUsdt: longFeeUsdt.toString(),
    execTs: params.ts,
    bookSourceTs: longView.sourceTs,
    bookRecvTs: longView.recvTs,
    levelsUsed: longWalk.levelsUsed,
  };
  const shortFill: LegFillDetail = {
    venue: shortVenue,
    symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'SELL',
    qtyEth: params.qtyEth,
    avgPriceNative: shortWalk.vwapPrice,
    priceCurrency: shortVenue === 'BINANCE' ? 'USDT' : 'USDC',
    fxAtExec: shortVenue === 'BINANCE' ? '1' : params.fxRate,
    fxSource: shortVenue === 'BINANCE' ? 'native_usdt' : params.fxSource,
    avgPriceUsdt: shortVwapUsdt.toString(),
    feeRate: shortFeeRate,
    feeNative: shortFeeNative.toString(),
    feeUsdt: shortFeeUsdt.toString(),
    execTs: params.ts,
    bookSourceTs: shortView.sourceTs,
    bookRecvTs: shortView.recvTs,
    levelsUsed: shortWalk.levelsUsed,
  };

  return {
    executable: true,
    rejectReason: null,
    longFill,
    shortFill,
    bboSpreadBps,
    vwapSpreadBps: vwapSpreadBps.toString(),
    vwapSpreadUsd: vwapSpreadUsd.toString(),
    entryFeesUsd: longFeeUsdt.plus(shortFeeUsdt).toString(),
  };
}

function buildExitEvaluation(params: {
  direction: Direction;
  qtyEth: string;
  bnView: OrderBookView;
  hlView: OrderBookView;
  fxRate: string;
  fxSource: string;
  fees: FeeScheduleAssumption;
  ts: number;
}): {
  executable: boolean;
  rejectReason: string | null;
  longCloseFill: LegFillDetail | null;
  shortCloseFill: LegFillDetail | null;
  exitSpreadBps: string | null;
} {
  const longVenue = params.direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
  const shortVenue = longVenue === 'BINANCE' ? 'HYPERLIQUID' : 'BINANCE';
  const longView = longVenue === 'BINANCE' ? params.bnView : params.hlView;
  const shortView = shortVenue === 'BINANCE' ? params.bnView : params.hlView;

  const longSellWalk = longView.walkBids(params.qtyEth);
  const shortBuyWalk = shortView.walkAsks(params.qtyEth);
  if (!longSellWalk.fillable || !shortBuyWalk.fillable) {
    return {
      executable: false,
      rejectReason: 'CLOSE_INSUFFICIENT_DEPTH',
      longCloseFill: null,
      shortCloseFill: null,
      exitSpreadBps: null,
    };
  }

  const longExitUsdt = new Decimal(priceInUsdt(longVenue, longSellWalk.vwapPrice, params.fxRate));
  const shortExitUsdt = new Decimal(priceInUsdt(shortVenue, shortBuyWalk.vwapPrice, params.fxRate));
  const qty = new Decimal(params.qtyEth);

  const longFeeRate = longVenue === 'BINANCE' ? params.fees.binanceTakerFeeRate : params.fees.hyperliquidTakerFeeRate;
  const shortFeeRate = shortVenue === 'BINANCE' ? params.fees.binanceTakerFeeRate : params.fees.hyperliquidTakerFeeRate;

  const longFeeNative = qty.mul(longSellWalk.vwapPrice).mul(longFeeRate).toDecimalPlaces(8);
  const shortFeeNative = qty.mul(shortBuyWalk.vwapPrice).mul(shortFeeRate).toDecimalPlaces(8);
  const longFeeUsdt = longVenue === 'BINANCE'
    ? longFeeNative
    : longFeeNative.mul(params.fxRate).toDecimalPlaces(8);
  const shortFeeUsdt = shortVenue === 'BINANCE'
    ? shortFeeNative
    : shortFeeNative.mul(params.fxRate).toDecimalPlaces(8);

  const longCloseFill: LegFillDetail = {
    venue: longVenue,
    symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'SELL',
    qtyEth: params.qtyEth,
    avgPriceNative: longSellWalk.vwapPrice,
    priceCurrency: longVenue === 'BINANCE' ? 'USDT' : 'USDC',
    fxAtExec: longVenue === 'BINANCE' ? '1' : params.fxRate,
    fxSource: longVenue === 'BINANCE' ? 'native_usdt' : params.fxSource,
    avgPriceUsdt: longExitUsdt.toString(),
    feeRate: longFeeRate,
    feeNative: longFeeNative.toString(),
    feeUsdt: longFeeUsdt.toString(),
    execTs: params.ts,
    bookSourceTs: longView.sourceTs,
    bookRecvTs: longView.recvTs,
    levelsUsed: longSellWalk.levelsUsed,
  };
  const shortCloseFill: LegFillDetail = {
    venue: shortVenue,
    symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'BUY',
    qtyEth: params.qtyEth,
    avgPriceNative: shortBuyWalk.vwapPrice,
    priceCurrency: shortVenue === 'BINANCE' ? 'USDT' : 'USDC',
    fxAtExec: shortVenue === 'BINANCE' ? '1' : params.fxRate,
    fxSource: shortVenue === 'BINANCE' ? 'native_usdt' : params.fxSource,
    avgPriceUsdt: shortExitUsdt.toString(),
    feeRate: shortFeeRate,
    feeNative: shortFeeNative.toString(),
    feeUsdt: shortFeeUsdt.toString(),
    execTs: params.ts,
    bookSourceTs: shortView.sourceTs,
    bookRecvTs: shortView.recvTs,
    levelsUsed: shortBuyWalk.levelsUsed,
  };

  const exitSpreadBps = shortExitUsdt.minus(longExitUsdt).div(longExitUsdt).mul(10_000).toDecimalPlaces(4).toString();
  return {
    executable: true,
    rejectReason: null,
    longCloseFill,
    shortCloseFill,
    exitSpreadBps,
  };
}

function computeNativeContractPnl(params: {
  direction: Direction;
  qtyEth: string;
  longEntry: LegFillDetail;
  shortEntry: LegFillDetail;
  longExit: LegFillDetail;
  shortExit: LegFillDetail;
  settlementFxRate: string;
}): {
  bnContractPnlUsdt: string;
  hlContractPnlUsdc: string;
  hlContractPnlUsdt: string;
  contractSpreadPnlUsd: string;
} {
  const qty = new Decimal(params.qtyEth);
  const bnIsLong = params.direction === 'LONG_BN_SHORT_HL';
  const bnEntryNative = bnIsLong ? params.longEntry.avgPriceNative : params.shortEntry.avgPriceNative;
  const bnExitNative = bnIsLong ? params.longExit.avgPriceNative : params.shortExit.avgPriceNative;
  const hlEntryNative = bnIsLong ? params.shortEntry.avgPriceNative : params.longEntry.avgPriceNative;
  const hlExitNative = bnIsLong ? params.shortExit.avgPriceNative : params.longExit.avgPriceNative;

  // Long PnL = qty * (exit - entry); Short PnL = qty * (entry - exit).
  const bnPnl = bnIsLong
    ? qty.mul(new Decimal(bnExitNative).minus(bnEntryNative))
    : qty.mul(new Decimal(bnEntryNative).minus(bnExitNative));
  const hlPnlUsdc = bnIsLong
    ? qty.mul(new Decimal(hlEntryNative).minus(hlExitNative))
    : qty.mul(new Decimal(hlExitNative).minus(hlEntryNative));
  const hlPnlUsdt = hlPnlUsdc.mul(params.settlementFxRate);
  const totalUsd = bnPnl.plus(hlPnlUsdt);

  return {
    bnContractPnlUsdt: bnPnl.toDecimalPlaces(8).toString(),
    hlContractPnlUsdc: hlPnlUsdc.toDecimalPlaces(8).toString(),
    hlContractPnlUsdt: hlPnlUsdt.toDecimalPlaces(8).toString(),
    contractSpreadPnlUsd: totalUsd.toDecimalPlaces(8).toString(),
  };
}

function computeFundingBreakdown(params: {
  liveSettledFunding: readonly FundingSettledRecorded[];
  direction: Direction;
  qtyEth: string;
  entryTs: number;
  exitTs: number;
  fallbackBnPriceUsdt: string | null;
  fallbackHlPriceUsdc: string | null;
  fallbackFxRate: string;
  fallbackFxSource: string;
}): { count: number; netUsd: string; legs: FundingLegCashflow[] } {
  const longVenue = params.direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
  const qty = new Decimal(params.qtyEth);
  const legs: FundingLegCashflow[] = [];
  let netUsd = new Decimal(0);

  for (const s of params.liveSettledFunding) {
    if (s.isHistoricalBackfill) continue;
    if (s.settlementTime <= params.entryTs || s.settlementTime > params.exitTs) continue;

    if (s.venue === 'BINANCE') {
      const refPrice = s.markPrice ?? params.fallbackBnPriceUsdt;
      const priceSource: FundingLegCashflow['priceSource'] = s.markPrice
        ? 'settlement_mark_price'
        : params.fallbackBnPriceUsdt ? 'book_mid_fallback' : 'missing';
      const cashflow = refPrice
        ? qty.mul(refPrice).mul(s.fundingRate).mul(longVenue === 'BINANCE' ? -1 : 1).toDecimalPlaces(8)
        : null;
      if (cashflow) netUsd = netUsd.plus(cashflow);
      legs.push({
        venue: 'BINANCE',
        settlementTime: s.settlementTime,
        fundingRate: s.fundingRate,
        qtyEth: params.qtyEth,
        refPriceNative: refPrice,
        priceCurrency: 'USDT',
        priceSource,
        fxRate: '1',
        fxSource: 'native_usdt',
        cashflowNative: cashflow?.toString() ?? null,
        cashflowUsdt: cashflow?.toString() ?? null,
      });
    } else {
      const refPriceUsdc = s.nearestOraclePriceUsdc ?? params.fallbackHlPriceUsdc;
      const priceSource: FundingLegCashflow['priceSource'] = s.nearestOraclePriceUsdc
        ? 'settlement_nearest_oracle'
        : params.fallbackHlPriceUsdc ? 'book_mid_fallback' : 'missing';
      const fxRate = s.nearestFxUsdcUsdt ?? params.fallbackFxRate;
      const fxSource = s.nearestFxSource ?? params.fallbackFxSource;
      const cashflowUsdc = refPriceUsdc
        ? qty.mul(refPriceUsdc).mul(s.fundingRate).mul(longVenue === 'HYPERLIQUID' ? -1 : 1).toDecimalPlaces(8)
        : null;
      const cashflowUsdt = cashflowUsdc ? cashflowUsdc.mul(fxRate).toDecimalPlaces(8) : null;
      if (cashflowUsdt) netUsd = netUsd.plus(cashflowUsdt);
      legs.push({
        venue: 'HYPERLIQUID',
        settlementTime: s.settlementTime,
        fundingRate: s.fundingRate,
        qtyEth: params.qtyEth,
        refPriceNative: refPriceUsdc,
        priceCurrency: 'USDC',
        priceSource,
        fxRate,
        fxSource,
        cashflowNative: cashflowUsdc?.toString() ?? null,
        cashflowUsdt: cashflowUsdt?.toString() ?? null,
      });
    }
  }

  return {
    count: legs.length,
    netUsd: netUsd.toDecimalPlaces(8).toString(),
    legs,
  };
}

function buildVariantSpecs(config: ReplayConfig): VariantSpec[] {
  const specs: VariantSpec[] = [];
  for (const hlMaxAgeMs of config.hlMaxAgeMsList) {
    const label = `hl_${hlMaxAgeMs}ms_bn_${config.bnMaxRecvAgeMs}ms`;
    const bnAge: LegAgeConfig = {
      maxRecvAgeMs: config.bnMaxRecvAgeMs,
      maxSourceAgeMs: config.bnMaxSourceAgeMs,
      futureSourceToleranceMs: config.futureSourceToleranceMs,
    };
    const hlAge: LegAgeConfig = {
      maxRecvAgeMs: hlMaxAgeMs,
      maxSourceAgeMs: hlMaxAgeMs,
      futureSourceToleranceMs: config.futureSourceToleranceMs,
    };
    for (const entryBps of config.entryBpsList) {
      for (const version of ['bbo_v1', 'vwap_taker_v2'] as const) {
        for (const delayMs of config.delaysMs) {
          specs.push({ ageTierLabel: label, bnAge, hlAge, entryBps, version, delayMs });
        }
      }
    }
  }
  return specs;
}

function buildAgeTiers(config: ReplayConfig): AgeTierConfig[] {
  return config.hlMaxAgeMsList.map((hlMaxAgeMs) => ({
    label: `hl_${hlMaxAgeMs}ms_bn_${config.bnMaxRecvAgeMs}ms`,
    bn: {
      maxRecvAgeMs: config.bnMaxRecvAgeMs,
      maxSourceAgeMs: config.bnMaxSourceAgeMs,
      futureSourceToleranceMs: config.futureSourceToleranceMs,
    },
    hl: {
      maxRecvAgeMs: hlMaxAgeMs,
      maxSourceAgeMs: hlMaxAgeMs,
      futureSourceToleranceMs: config.futureSourceToleranceMs,
    },
  }));
}

function midpointFromView(view: OrderBookView | null): string | null {
  if (!view?.bestBid || !view?.bestAsk) return null;
  return new Decimal(view.bestBid[0]).plus(view.bestAsk[0]).div(2).toString();
}

export function extractFundingSettlementsFromEvents(
  events: readonly RecordedMarketEvent[],
): FundingSettledRecorded[] {
  return events.filter((ev): ev is FundingSettledRecorded => ev.type === 'funding_settled');
}

export async function extractFundingSettlementsFromFile(
  ndjsonPath: string,
): Promise<FundingSettledRecorded[]> {
  const collected: FundingSettledRecorded[] = [];
  const rl = createInterface({
    input: createReadStream(ndjsonPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"funding_settled"')) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as RecordedMarketEvent;
    if (parsed.type === 'funding_settled') {
      collected.push(parsed);
    }
  }
  return collected;
}

function dedupeAndSortLiveSettlements(
  records: readonly FundingSettledRecorded[],
): FundingSettledRecorded[] {
  const byKey = new Map<string, FundingSettledRecorded>();
  for (const r of records) {
    const key = `${r.venue}:${r.settlementTime}`;
    const existing = byKey.get(key);
    if (!existing || (existing.isHistoricalBackfill && !r.isHistoricalBackfill)) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()]
    .filter((r) => !r.isHistoricalBackfill)
    .sort((a, b) => a.settlementTime - b.settlementTime || a.venue.localeCompare(b.venue));
}

/**
 * Streaming single-pass offline replay engine supporting O(1) memory footprint over multi-GB
 * NDJSON captures, causal pending-order arrival, native-currency contract PnL separation,
 * and exact checkpoint continuation across file segments.
 */
export class StreamingReplayRunner {
  private readonly bnMachine = new BinanceOrderBookStateMachine();
  private readonly hlMachine = new HyperliquidOrderBookStateMachine();
  private readonly config: ReplayConfig;
  private readonly runId: string;

  private sessionMeta: SessionMetaEvent | null = null;
  private startedAtMs: number | null = null;
  private endedAtMs = 0;
  private eventsProcessed = 0;

  private lastFx: { ts: number; rate: string; source: FxRateRecorded['source'] } = {
    ts: 0,
    rate: '1',
    source: 'parity_fallback',
  };
  private liveSettledFunding: FundingSettledRecorded[] = [];
  private readonly accountingLiveSettlements: FundingSettledRecorded[];
  private readonly hasPreloadedAccountingIndex: boolean;
  private historicalBackfillCount = 0;
  private seenSettlementKeys = new Set<string>();

  private binanceBridges: BinanceBridgeProof[] = [];
  private binanceGaps: ReplaySuiteResult['timelineDiagnostics']['binanceGaps'] = [];
  private hlReconnectFirstValid: ReplaySuiteResult['timelineDiagnostics']['hyperliquidReconnectFirstValid'] = [];
  private hlStaleRejectedCount = 0;
  private crossexBypassCount = 0;
  private bnInGapRecovery = false;
  private delaySampleRows: TradeScorecardRow[] = [];
  private totalRetainedRows = 0;
  private readonly options: StreamingReplayOptions;

  private readonly coverageTrackers: AgeTierCoverageCheckpoint[];
  private readonly variants: VariantCheckpoint[];

  constructor(
    partialConfig: Partial<ReplayConfig> = {},
    checkpoint?: ReplayCheckpoint,
    options: StreamingReplayOptions = {},
  ) {
    this.options = options;
    if (checkpoint) {
      this.config = checkpoint.config;
      this.runId = checkpoint.runId;
      this.sessionMeta = checkpoint.sessionMeta;
      this.startedAtMs = checkpoint.startedAtMs;
      this.endedAtMs = checkpoint.endedAtMs;
      this.eventsProcessed = checkpoint.eventsProcessed;
      this.bnMachine.restoreCheckpoint(checkpoint.bnBook);
      this.hlMachine.restoreCheckpoint(checkpoint.hlBook);
      this.lastFx = { ...checkpoint.lastFx };
      this.liveSettledFunding = checkpoint.liveSettledFunding.map((s) => ({ ...s }));
      if (options.preloadedFundingSettlements !== undefined) {
        this.hasPreloadedAccountingIndex = true;
        this.accountingLiveSettlements = dedupeAndSortLiveSettlements(options.preloadedFundingSettlements);
      } else {
        this.hasPreloadedAccountingIndex = checkpoint.hasPreloadedAccountingIndex ?? false;
        this.accountingLiveSettlements = (checkpoint.accountingLiveSettlements ?? []).map((s) => ({ ...s }));
      }
      this.historicalBackfillCount = checkpoint.historicalBackfillCount;
      this.seenSettlementKeys = new Set(checkpoint.seenSettlementKeys);
      this.binanceBridges = [...checkpoint.binanceBridges];
      this.binanceGaps = [...checkpoint.binanceGaps];
      this.hlReconnectFirstValid = [...checkpoint.hlReconnectFirstValid];
      this.hlStaleRejectedCount = checkpoint.hlStaleRejectedCount;
      this.crossexBypassCount = checkpoint.crossexBypassCount;
      this.bnInGapRecovery = checkpoint.bnInGapRecovery;
      this.delaySampleRows = [...checkpoint.delaySampleRows];
      this.coverageTrackers = checkpoint.coverageTrackers.map((t) => ({ ...t }));
      this.variants = checkpoint.variants.map((v) => ({
        ...v,
        rawRejectReasons: { ...v.rawRejectReasons },
        metrics: { ...v.metrics },
        openPosition: v.openPosition ? { ...v.openPosition, openRow: { ...v.openPosition.openRow } } : null,
        rows: [...v.rows],
      }));
      this.totalRetainedRows = this.variants.reduce((acc, v) => acc + v.rows.length, 0);
      return;
    }

    this.hasPreloadedAccountingIndex = options.preloadedFundingSettlements !== undefined;
    this.accountingLiveSettlements = options.preloadedFundingSettlements
      ? dedupeAndSortLiveSettlements(options.preloadedFundingSettlements)
      : [];
    this.config = {
      ...DEFAULT_REPLAY_CONFIG,
      ...partialConfig,
      fees: { ...DEFAULT_VIP0_FEES, ...partialConfig.fees },
    };
    this.runId = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.coverageTrackers = buildAgeTiers(this.config).map((cfg) => ({
      config: cfg,
      prevT: null,
      bnValidFrom: 0,
      bnValidUntil: 0,
      hlValidFrom: 0,
      hlValidUntil: 0,
      bnValidMs: 0,
      hlValidMs: 0,
      validOverlapMs: 0,
    }));
    this.variants = buildVariantSpecs(this.config).map((spec) => ({
      spec,
      seq: 0,
      groupSeq: 0,
      rawDecisionTicksEvaluated: 0,
      rawCandidates: 0,
      rawRejectCount: 0,
      rawRejectReasons: {},
      activeGroupId: null,
      lastGroupDirection: null,
      lastRejectLogTs: Number.NEGATIVE_INFINITY,
      pendingOrder: null,
      openPosition: null,
      metrics: {
        loggedCandidates: 0,
        triggeredCount: 0,
        distinctGroupCount: 0,
        lastTriggeredGroupId: null,
        completedRoundtrips: 0,
        openAtEndCount: 0,
        unvaluedOpenCount: 0,
        unvaluedOpenQty: '0',
        realizedPnlUsd: '0',
        markOpenPnlUsd: '0',
        totalFeesUsd: '0',
        totalFundingNetUsd: '0',
        totalPlannedNotionalUsdt: '0',
      },
      rows: [],
    }));
  }

  static fromCheckpoint(
    checkpoint: ReplayCheckpoint,
    options: StreamingReplayOptions = {},
  ): StreamingReplayRunner {
    return new StreamingReplayRunner({}, checkpoint, options);
  }

  exportCheckpoint(): ReplayCheckpoint {
    return {
      runId: this.runId,
      config: this.config,
      sessionMeta: this.sessionMeta,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      eventsProcessed: this.eventsProcessed,
      bnBook: this.bnMachine.exportCheckpoint(),
      hlBook: this.hlMachine.exportCheckpoint(),
      lastFx: { ...this.lastFx },
      liveSettledFunding: this.liveSettledFunding.map((s) => ({ ...s })),
      accountingLiveSettlements: this.accountingLiveSettlements.map((s) => ({ ...s })),
      hasPreloadedAccountingIndex: this.hasPreloadedAccountingIndex,
      historicalBackfillCount: this.historicalBackfillCount,
      seenSettlementKeys: [...this.seenSettlementKeys],
      binanceBridges: [...this.binanceBridges],
      binanceGaps: [...this.binanceGaps],
      hlReconnectFirstValid: [...this.hlReconnectFirstValid],
      hlStaleRejectedCount: this.hlStaleRejectedCount,
      crossexBypassCount: this.crossexBypassCount,
      bnInGapRecovery: this.bnInGapRecovery,
      delaySampleRows: [...this.delaySampleRows],
      coverageTrackers: this.coverageTrackers.map((t) => ({ ...t })),
      variants: this.variants.map((v) => ({
        ...v,
        rawRejectReasons: { ...v.rawRejectReasons },
        metrics: { ...v.metrics },
        openPosition: v.openPosition ? { ...v.openPosition, openRow: { ...v.openPosition.openRow } } : null,
        rows: [...v.rows],
      })),
    };
  }

  processEvent(ev: RecordedMarketEvent): void {
    this.eventsProcessed += 1;
    if (this.startedAtMs === null) this.startedAtMs = ev.recvTs;
    if (ev.recvTs > this.endedAtMs) this.endedAtMs = ev.recvTs;

    // Step 1: Before this event mutates books, mature any pending order whose arrivalTs < ev.recvTs!
    this.maturePendingOrdersStrictlyBefore(ev.recvTs);

    // Step 2: Advance coverage clock to ev.recvTs BEFORE applying the event mutation.
    for (const tracker of this.coverageTrackers) {
      advanceCoverageTo(tracker, ev.recvTs);
    }

    // Step 3: Apply event to live order book / FX / funding state.
    let updatedVenue: 'BINANCE' | 'HYPERLIQUID' | null = null;

    if (ev.type === 'session_meta') {
      this.sessionMeta = ev;
    } else if (ev.type === 'cx_raw') {
      this.crossexBypassCount += 1;
    } else if (ev.type === 'fx_rate') {
      this.lastFx = { ts: ev.recvTs, rate: ev.rate, source: ev.source };
    } else if (ev.type === 'funding_settled') {
      const key = `${ev.venue}:${ev.settlementTime}`;
      if (!this.seenSettlementKeys.has(key)) {
        this.seenSettlementKeys.add(key);
        if (ev.isHistoricalBackfill) {
          this.historicalBackfillCount += 1;
        } else {
          this.liveSettledFunding.push(ev);
          this.liveSettledFunding.sort((a, b) => a.settlementTime - b.settlementTime || a.venue.localeCompare(b.venue));
        }
      }
    } else if (ev.type === 'conn_event') {
      if (ev.venue === 'BINANCE') {
        if (ev.status === 'open') {
          if (this.bnMachine.onConnectionOpen(ev.connGen)) {
            this.bnInGapRecovery = false;
            updatedVenue = 'BINANCE';
          }
        } else if (ev.status === 'close' || ev.status === 'injected_disconnect') {
          if (this.bnMachine.onConnectionDisconnect(ev.connGen)) {
            this.bnInGapRecovery = false;
            updatedVenue = 'BINANCE';
          }
        }
      } else if (ev.venue === 'HYPERLIQUID') {
        if (ev.status === 'open') {
          if (this.hlMachine.onConnectionOpen(ev.connGen)) {
            updatedVenue = 'HYPERLIQUID';
          }
        } else if (ev.status === 'close' || ev.status === 'injected_disconnect') {
          if (this.hlMachine.onConnectionDisconnect(ev.connGen)) {
            updatedVenue = 'HYPERLIQUID';
          }
        }
      }
    } else if (ev.type === 'bn_depth_snapshot') {
      const res = this.bnMachine.onRestSnapshot({
        connGen: ev.connGen,
        fetchedAtMs: ev.recvTs,
        lastUpdateId: ev.lastUpdateId,
        bids: ev.bids,
        asks: ev.asks,
      });
      if (res.kind !== 'stale_connection_ignored') {
        updatedVenue = 'BINANCE';
      }
      if (res.kind === 'bridge_ready') {
        this.bnInGapRecovery = false;
        this.binanceBridges.push(res.proof);
      }
    } else if (ev.type === 'bn_depth_delta') {
      const res = this.bnMachine.onDepthDelta({
        connGen: ev.connGen,
        recvSeq: ev.recvSeq,
        recvTs: ev.recvTs,
        eventTime: ev.eventTime,
        ...(ev.transactionTime !== undefined ? { transactionTime: ev.transactionTime } : {}),
        U: ev.U,
        u: ev.u,
        pu: ev.pu,
        bids: ev.bids,
        asks: ev.asks,
      });
      if (res.kind !== 'stale_connection_ignored') {
        updatedVenue = 'BINANCE';
      }
      if (res.kind === 'bridge_ready') {
        this.bnInGapRecovery = false;
        this.binanceBridges.push(res.proof);
      } else if (res.kind === 'sequence_gap') {
        this.binanceGaps.push({
          recvTs: ev.recvTs,
          connGen: ev.connGen,
          expectedPu: res.expectedPu,
          actualPu: res.actualPu,
          U: res.U,
          u: res.u,
        });
        this.bnInGapRecovery = true;
        this.bnMachine.markGapResyncing();
      }
    } else if (ev.type === 'hl_l2book') {
      const res = this.hlMachine.onSnapshot({
        connGen: ev.connGen,
        sourceTs: ev.sourceTs,
        recvTs: ev.recvTs,
        bids: ev.bids,
        asks: ev.asks,
      });
      if (res.kind !== 'stale_connection_ignored') {
        updatedVenue = 'HYPERLIQUID';
      }
      if (res.kind === 'applied' && res.firstForConnection && ev.connGen > 1) {
        this.hlReconnectFirstValid.push({
          recvTs: ev.recvTs,
          connGen: ev.connGen,
          sourceTs: ev.sourceTs,
          bidLevels: ev.bidLevels,
          askLevels: ev.askLevels,
        });
      } else if (res.kind === 'stale_backward_ignored') {
        this.hlStaleRejectedCount += 1;
      }
    }

    if (updatedVenue === 'BINANCE' || updatedVenue === 'HYPERLIQUID') {
      const bnView = this.bnMachine.view();
      const hlView = this.hlMachine.view();
      const bnStatus = this.effectiveBnStatus();
      const hlStatus = this.hlMachine.getState();
      for (const tracker of this.coverageTrackers) {
        updateCoverageLeg(
          tracker,
          updatedVenue,
          updatedVenue === 'BINANCE' ? bnView : hlView,
          updatedVenue === 'BINANCE' ? bnStatus : hlStatus,
          ev.recvTs,
        );
      }

      // Mature any pending order whose arrivalTs === ev.recvTs now that ev at exact arrivalTs is applied.
      this.maturePendingOrdersAtExactTs(ev.recvTs);

      // Run decision step for every variant on this book tick, sharing book validity + BBO/VWAP evaluations per tick.
      const tickCache: TickEvaluationCache = {
        tDecision: ev.recvTs,
        bnCheck: evaluateBookValidity(bnView, ev.recvTs, {
          maxRecvAgeMs: this.config.bnMaxRecvAgeMs,
          maxSourceAgeMs: this.config.bnMaxSourceAgeMs,
          futureSourceToleranceMs: this.config.futureSourceToleranceMs,
        }, bnStatus),
        hlChecksByMaxAge: new Map(),
        bestBbo: null,
        entryEvalByDirection: {},
        vwapDecisionByDirection: {},
        exitEvalByDirection: {},
      };
      for (const variant of this.variants) {
        this.evaluateVariantAtTick(variant, ev.recvTs, bnView, hlView, bnStatus, hlStatus, tickCache);
      }
    }
  }

  private effectiveBnStatus(): string {
    const raw = this.bnMachine.getState();
    return this.bnInGapRecovery && raw !== 'SYNCED' ? 'INVALID_GAP' : raw;
  }

  private maturePendingOrdersStrictlyBefore(nextTs: number): void {
    const bnView = this.bnMachine.view();
    const hlView = this.hlMachine.view();
    const bnStatus = this.effectiveBnStatus();
    const hlStatus = this.hlMachine.getState();
    for (const variant of this.variants) {
      if (variant.pendingOrder && variant.pendingOrder.arrivalTs < nextTs) {
        this.executePendingOrder(variant, bnView, hlView, bnStatus, hlStatus);
      }
    }
  }

  private maturePendingOrdersAtExactTs(exactTs: number): void {
    const bnView = this.bnMachine.view();
    const hlView = this.hlMachine.view();
    const bnStatus = this.effectiveBnStatus();
    const hlStatus = this.hlMachine.getState();
    for (const variant of this.variants) {
      if (variant.pendingOrder && variant.pendingOrder.arrivalTs <= exactTs) {
        this.executePendingOrder(variant, bnView, hlView, bnStatus, hlStatus);
      }
    }
  }

  private recordRejection(
    variant: VariantCheckpoint,
    reason: string,
    tDecision: number,
    direction: Direction,
    bnView: OrderBookView | null,
    hlView: OrderBookView | null,
    bboSpreadBps: string | null,
    vwapSpreadBps: string | null,
    estExitBps: string | null,
    longRefPriceUsdt: string | null,
    plannedNotionalUsdt: string | null,
    note: string,
  ): void {
    variant.rawRejectCount += 1;
    variant.rawRejectReasons[reason] = (variant.rawRejectReasons[reason] ?? 0) + 1;
    if (tDecision - variant.lastRejectLogTs < this.config.cooldownBetweenRejectsMs) {
      return;
    }
    variant.lastRejectLogTs = tDecision;
    variant.seq += 1;
    const longVenue = direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
    const shortVenue = longVenue === 'BINANCE' ? 'HYPERLIQUID' : 'BINANCE';

    const finalizedRow: TradeScorecardRow = {
      run_id: this.runId,
      age_tier: variant.spec.ageTierLabel,
      entry_bps_threshold: variant.spec.entryBps,
      strategy_version: variant.spec.version,
      delay_ms: variant.spec.delayMs,
      delay_model: variant.spec.delayMs === 0
        ? 'zero_delay_last_synced_book'
        : `fixed_one_way_delay_${variant.spec.delayMs}ms_per_leg`,
      opportunity_id: `${variant.spec.version}-${variant.spec.delayMs}ms-${String(variant.seq).padStart(4, '0')}`,
      group_id: variant.activeGroupId
        ?? `grp-${variant.spec.version}-${variant.spec.delayMs}ms-rej-${String(variant.seq).padStart(4, '0')}`,
      asset: 'ETH',
      direction,
      long_venue: longVenue,
      short_venue: shortVenue,
      long_symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
      short_symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
      decision: 'REJECTED',
      reject_reason: reason,
      trigger_ts: tDecision,
      exec_arrival_ts: null,
      exit_decision_ts: null,
      exit_exec_arrival_ts: null,
      event_ts_left: bnView?.sourceTs ?? null,
      event_ts_right: hlView?.sourceTs ?? null,
      recv_ts_left: bnView?.recvTs ?? null,
      recv_ts_right: hlView?.recvTs ?? null,
      budget_usdt: this.config.budgetUsdt,
      planned_qty: this.config.plannedQtyEth,
      actual_filled_qty: '0',
      unit_multiplier_normalized: '1',
      long_ref_price_usdt: longRefPriceUsdt,
      planned_notional_usdt: plannedNotionalUsdt,
      denominator_rule: 'planned_notional_usdt = Q_plan * long_ref_price_in_usdt',
      fx_usdc_usdt: this.lastFx.rate,
      fx_source: this.lastFx.source,
      fee_source: this.config.fees.source,
      fee_assumption_detail: `${this.config.fees.binanceContract} ${this.config.fees.binanceTakerFeeRate}; ${this.config.fees.hyperliquidContract} ${this.config.fees.hyperliquidTakerFeeRate}`,
      exit_assumption: `Pre-trade scenario only: takeProfitBps(${this.config.takeProfitBps}) + exitDepthBuffer(${this.config.scenarioExitDepthBufferBps} bps)`,
      bbo_entry_spread_bps: bboSpreadBps,
      vwap_entry_spread_bps: vwapSpreadBps,
      est_exit_spread_bps: estExitBps,
      entry_long_fill: null,
      entry_short_fill: null,
      exit_long_fill: null,
      exit_short_fill: null,
      bn_contract_pnl_usdt: null,
      hl_contract_pnl_usdc: null,
      hl_contract_pnl_usdt: null,
      contract_spread_pnl_usd: null,
      collateral_fx_pnl_usd: '0',
      collateral_fx_note: 'offline_collateral_fx_pnl_assumed_zero_no_wallet_balance',
      fees_4leg_usd: null,
      funding_events_crossed: 0,
      funding_net_usd: null,
      funding_legs: [],
      borrowing_cost_est_usd: '0',
      borrowing_note: 'offline_borrowing_assumed_zero_no_wallet_liability',
      roundtrip_net_pnl_usd: null,
      roundtrip_net_bps: null,
      budget_roi_pct: null,
      is_open_at_end: false,
      mark_to_close_usd: null,
      unvalued_qty: '0',
      max_naked_leg_ms: null,
      rest_queue_wait_ms: null,
      margin_used_est_usd: null,
      margin_used_actual_usd: null,
      book_gap_count: this.binanceGaps.length,
      manual_intervention_count: 0,
      manual_notes: note,
    };
    this.emitFinalizedRow(variant, finalizedRow);
  }

  private emitFinalizedRow(variant: VariantCheckpoint, row: TradeScorecardRow): void {
    const m = variant.metrics;
    m.loggedCandidates += 1;
    if (row.decision === 'TRIGGERED') {
      m.triggeredCount += 1;
      if (row.group_id !== m.lastTriggeredGroupId) {
        m.distinctGroupCount += 1;
        m.lastTriggeredGroupId = row.group_id;
      }
      if (row.fees_4leg_usd) {
        m.totalFeesUsd = new Decimal(m.totalFeesUsd).plus(row.fees_4leg_usd).toString();
      }
      if (row.funding_net_usd) {
        m.totalFundingNetUsd = new Decimal(m.totalFundingNetUsd).plus(row.funding_net_usd).toString();
      }
      if (row.is_open_at_end) {
        m.openAtEndCount += 1;
        if (Number(row.unvalued_qty) > 0) {
          m.unvaluedOpenCount += 1;
          m.unvaluedOpenQty = new Decimal(m.unvaluedOpenQty).plus(row.unvalued_qty).toString();
        } else if (row.mark_to_close_usd) {
          m.markOpenPnlUsd = new Decimal(m.markOpenPnlUsd).plus(row.mark_to_close_usd).toString();
        }
      } else {
        m.completedRoundtrips += 1;
        if (row.roundtrip_net_pnl_usd) {
          m.realizedPnlUsd = new Decimal(m.realizedPnlUsd).plus(row.roundtrip_net_pnl_usd).toString();
        }
        if (row.planned_notional_usdt) {
          m.totalPlannedNotionalUsdt = new Decimal(m.totalPlannedNotionalUsdt).plus(row.planned_notional_usdt).toString();
        }
      }
    }

    if (this.delaySampleRows.length < 300 || (row.decision === 'TRIGGERED' && this.delaySampleRows.length < 600)) {
      this.delaySampleRows.push(row);
    }
    this.options.onFinalizedRow?.(row);

    const retain = this.options.retainRowsInMemory !== false;
    const cap = this.options.maxRetainedRows ?? Number.POSITIVE_INFINITY;
    if (retain && (this.totalRetainedRows < cap || (row.decision === 'TRIGGERED' && this.totalRetainedRows < cap * 2))) {
      variant.rows.push(row);
      this.totalRetainedRows += 1;
    }
  }

  private executePendingOrder(
    variant: VariantCheckpoint,
    bnView: OrderBookView | null,
    hlView: OrderBookView | null,
    bnStatus: string,
    hlStatus: string,
  ): void {
    const order = variant.pendingOrder;
    if (!order) return;
    variant.pendingOrder = null;

    const bnCheck = evaluateBookValidity(bnView, order.arrivalTs, variant.spec.bnAge, bnStatus);
    const hlCheck = evaluateBookValidity(hlView, order.arrivalTs, variant.spec.hlAge, hlStatus);

    if (order.kind === 'ENTRY') {
      if (!bnCheck.valid || !hlCheck.valid) {
        const reason = formatInvalidBookPairReason(bnCheck, hlCheck, 'EXEC_INVALID_');
        this.recordRejection(
          variant,
          reason,
          order.decisionTs,
          order.direction,
          bnView,
          hlView,
          order.decisionSnapshot.bboSpreadBps,
          order.decisionSnapshot.vwapSpreadBps,
          order.decisionSnapshot.estExitBps,
          order.decisionSnapshot.longRefPriceUsdt,
          order.decisionSnapshot.plannedNotionalUsdt,
          `Arrival failed at t+${variant.spec.delayMs}ms: ${reason}`,
        );
        return;
      }

      const execEntry = buildEntryEvaluation({
        direction: order.direction,
        qtyEth: this.config.plannedQtyEth,
        bnView: bnCheck.view,
        hlView: hlCheck.view,
        fxRate: this.lastFx.rate,
        fxSource: this.lastFx.source,
        fees: this.config.fees,
        ts: order.arrivalTs,
      });

      if (!execEntry.executable || !execEntry.longFill || !execEntry.shortFill) {
        const reason = `EXEC_${execEntry.rejectReason ?? 'INSUFFICIENT_DEPTH'}`;
        this.recordRejection(
          variant,
          reason,
          order.decisionTs,
          order.direction,
          bnCheck.view,
          hlCheck.view,
          order.decisionSnapshot.bboSpreadBps,
          order.decisionSnapshot.vwapSpreadBps,
          order.decisionSnapshot.estExitBps,
          order.decisionSnapshot.longRefPriceUsdt,
          order.decisionSnapshot.plannedNotionalUsdt,
          `Arrival depth fill failed at t+${variant.spec.delayMs}ms: ${reason}`,
        );
        return;
      }

      variant.seq += 1;
      const delayModel = variant.spec.delayMs === 0
        ? 'zero_delay_last_synced_book'
        : `fixed_one_way_delay_${variant.spec.delayMs}ms_per_leg`;

      const openRow: TradeScorecardRow = {
        run_id: this.runId,
        age_tier: variant.spec.ageTierLabel,
        entry_bps_threshold: variant.spec.entryBps,
        strategy_version: variant.spec.version,
        delay_ms: variant.spec.delayMs,
        delay_model: delayModel,
        opportunity_id: order.opportunityId,
        group_id: order.groupId,
        asset: 'ETH',
        direction: order.direction,
        long_venue: execEntry.longFill.venue,
        short_venue: execEntry.shortFill.venue,
        long_symbol: execEntry.longFill.symbol,
        short_symbol: execEntry.shortFill.symbol,
        decision: 'TRIGGERED',
        reject_reason: null,
        trigger_ts: order.decisionTs,
        exec_arrival_ts: order.arrivalTs,
        exit_decision_ts: null,
        exit_exec_arrival_ts: null,
        event_ts_left: order.decisionSnapshot.eventTsLeft,
        event_ts_right: order.decisionSnapshot.eventTsRight,
        recv_ts_left: order.decisionSnapshot.recvTsLeft,
        recv_ts_right: order.decisionSnapshot.recvTsRight,
        budget_usdt: this.config.budgetUsdt,
        planned_qty: this.config.plannedQtyEth,
        actual_filled_qty: this.config.plannedQtyEth,
        unit_multiplier_normalized: '1',
        long_ref_price_usdt: order.decisionSnapshot.longRefPriceUsdt,
        planned_notional_usdt: order.decisionSnapshot.plannedNotionalUsdt,
        denominator_rule: 'planned_notional_usdt = Q_plan * long_ref_price_in_usdt',
        fx_usdc_usdt: this.lastFx.rate,
        fx_source: this.lastFx.source,
        fee_source: this.config.fees.source,
        fee_assumption_detail: `${this.config.fees.binanceContract} ${this.config.fees.binanceTakerFeeRate}; ${this.config.fees.hyperliquidContract} ${this.config.fees.hyperliquidTakerFeeRate}`,
        exit_assumption: variant.spec.version === 'bbo_v1'
          ? `Legacy BBO trigger without pre-trade exit buffer; closes when live exit <= ${this.config.takeProfitBps} bps`
          : `Pre-trade scenario only: takeProfitBps(${this.config.takeProfitBps}) + exitDepthBuffer(${this.config.scenarioExitDepthBufferBps} bps)`,
        bbo_entry_spread_bps: order.decisionSnapshot.bboSpreadBps,
        vwap_entry_spread_bps: execEntry.vwapSpreadBps,
        est_exit_spread_bps: order.decisionSnapshot.estExitBps,
        entry_long_fill: execEntry.longFill,
        entry_short_fill: execEntry.shortFill,
        exit_long_fill: null,
        exit_short_fill: null,
        bn_contract_pnl_usdt: null,
        hl_contract_pnl_usdc: null,
        hl_contract_pnl_usdt: null,
        contract_spread_pnl_usd: null,
        collateral_fx_pnl_usd: '0',
        collateral_fx_note: 'offline_collateral_fx_pnl_assumed_zero_no_wallet_balance',
        fees_4leg_usd: null,
        funding_events_crossed: 0,
        funding_net_usd: null,
        funding_legs: [],
        borrowing_cost_est_usd: '0',
        borrowing_note: 'offline_borrowing_assumed_zero_no_wallet_liability',
        roundtrip_net_pnl_usd: null,
        roundtrip_net_bps: null,
        budget_roi_pct: null,
        is_open_at_end: true,
        mark_to_close_usd: null,
        unvalued_qty: '0',
        max_naked_leg_ms: '0',
        rest_queue_wait_ms: null,
        margin_used_est_usd: new Decimal(order.decisionSnapshot.plannedNotionalUsdt)
          .mul('2')
          .div(this.config.assumedLeverage)
          .toDecimalPlaces(4)
          .toString(),
        margin_used_actual_usd: null,
        book_gap_count: this.binanceGaps.length,
        manual_intervention_count: 0,
        manual_notes: `Simultaneous dual-taker assumption (0ms skew between legs) under ${delayModel}`,
      };

      variant.openPosition = {
        openRow,
        opportunityId: order.opportunityId,
        groupId: order.groupId,
        direction: order.direction,
        entryDecisionTs: order.decisionTs,
        entryExecTs: order.arrivalTs,
        longEntryFill: execEntry.longFill,
        shortEntryFill: execEntry.shortFill,
        plannedNotionalUsdt: order.decisionSnapshot.plannedNotionalUsdt,
      };
      return;
    }

    // Pending EXIT maturation.
    const pos = variant.openPosition;
    if (!pos) return;
    if (!bnCheck.valid || !hlCheck.valid) return;
    const execExit = buildExitEvaluation({
      direction: pos.direction,
      qtyEth: this.config.plannedQtyEth,
      bnView: bnCheck.view,
      hlView: hlCheck.view,
      fxRate: this.lastFx.rate,
      fxSource: this.lastFx.source,
      fees: this.config.fees,
      ts: order.arrivalTs,
    });
    if (!execExit.executable || !execExit.longCloseFill || !execExit.shortCloseFill) return;

    const targetRow = pos.openRow;
    const pnl = computeNativeContractPnl({
      direction: pos.direction,
      qtyEth: this.config.plannedQtyEth,
      longEntry: pos.longEntryFill,
      shortEntry: pos.shortEntryFill,
      longExit: execExit.longCloseFill,
      shortExit: execExit.shortCloseFill,
      settlementFxRate: this.lastFx.rate,
    });
    const fees4 = new Decimal(pos.longEntryFill.feeUsdt)
      .plus(pos.shortEntryFill.feeUsdt)
      .plus(execExit.longCloseFill.feeUsdt)
      .plus(execExit.shortCloseFill.feeUsdt);
    const funding = computeFundingBreakdown({
      liveSettledFunding: this.hasPreloadedAccountingIndex
        ? this.accountingLiveSettlements
        : this.liveSettledFunding,
      direction: pos.direction,
      qtyEth: this.config.plannedQtyEth,
      entryTs: pos.entryExecTs,
      exitTs: order.arrivalTs,
      fallbackBnPriceUsdt: midpointFromView(bnCheck.view),
      fallbackHlPriceUsdc: midpointFromView(hlCheck.view),
      fallbackFxRate: this.lastFx.rate,
      fallbackFxSource: this.lastFx.source,
    });
    const netPnl = new Decimal(pnl.contractSpreadPnlUsd).plus(funding.netUsd).minus(fees4);
    const netBps = netPnl.div(pos.plannedNotionalUsdt).mul(10_000).toDecimalPlaces(4);
    const roiPct = netPnl.div(this.config.budgetUsdt).mul(100).toDecimalPlaces(4);

    targetRow.exit_decision_ts = order.decisionTs;
    targetRow.exit_exec_arrival_ts = order.arrivalTs;
    targetRow.exit_long_fill = execExit.longCloseFill;
    targetRow.exit_short_fill = execExit.shortCloseFill;
    targetRow.bn_contract_pnl_usdt = pnl.bnContractPnlUsdt;
    targetRow.hl_contract_pnl_usdc = pnl.hlContractPnlUsdc;
    targetRow.hl_contract_pnl_usdt = pnl.hlContractPnlUsdt;
    targetRow.contract_spread_pnl_usd = pnl.contractSpreadPnlUsd;
    targetRow.fees_4leg_usd = fees4.toDecimalPlaces(8).toString();
    targetRow.funding_events_crossed = funding.count;
    targetRow.funding_net_usd = funding.netUsd;
    targetRow.funding_legs = funding.legs;
    targetRow.roundtrip_net_pnl_usd = netPnl.toDecimalPlaces(8).toString();
    targetRow.roundtrip_net_bps = netBps.toString();
    targetRow.budget_roi_pct = roiPct.toString();
    targetRow.is_open_at_end = false;
    variant.openPosition = null;
    this.emitFinalizedRow(variant, targetRow);
  }

  private evaluateVariantAtTick(
    variant: VariantCheckpoint,
    tDecision: number,
    bnView: OrderBookView | null,
    hlView: OrderBookView | null,
    bnStatus: string,
    hlStatus: string,
    tickCache: TickEvaluationCache,
  ): void {
    variant.rawDecisionTicksEvaluated += 1;
    // Never enqueue a second decision while an entry/exit order is in flight.
    if (variant.pendingOrder !== null) return;

    const bnCheck = tickCache.bnCheck;
    let hlCheck = tickCache.hlChecksByMaxAge.get(variant.spec.hlAge.maxRecvAgeMs);
    if (!hlCheck) {
      hlCheck = evaluateBookValidity(hlView, tDecision, variant.spec.hlAge, hlStatus);
      tickCache.hlChecksByMaxAge.set(variant.spec.hlAge.maxRecvAgeMs, hlCheck);
    }

    if (!bnCheck.valid || !hlCheck.valid) {
      const reason = formatInvalidBookPairReason(bnCheck, hlCheck, '');
      variant.rawRejectCount += 1;
      variant.rawRejectReasons[reason] = (variant.rawRejectReasons[reason] ?? 0) + 1;
      return;
    }

    if (variant.openPosition) {
      const dir = variant.openPosition.direction;
      const longExitView = dir === 'LONG_BN_SHORT_HL' ? bnCheck.view : hlCheck.view;
      const shortExitView = dir === 'LONG_BN_SHORT_HL' ? hlCheck.view : bnCheck.view;
      const fxNum = Number(this.lastFx.rate);
      const longBidNum = longExitView.bestBid
        ? Number(longExitView.bestBid[0]) * (dir === 'LONG_BN_SHORT_HL' ? 1 : fxNum)
        : NaN;
      const shortAskNum = shortExitView.bestAsk
        ? Number(shortExitView.bestAsk[0]) * (dir === 'LONG_BN_SHORT_HL' ? fxNum : 1)
        : NaN;
      // Since VWAP exit spread >= BBO exit spread always, BBO > takeProfit + 0.05 guarantees exit cannot trigger.
      if (
        Number.isFinite(longBidNum) && Number.isFinite(shortAskNum) && longBidNum > 0
        && (((shortAskNum - longBidNum) / longBidNum) * 10_000 > Number(this.config.takeProfitBps) + 0.05)
      ) {
        return;
      }

      let exitCheck = tickCache.exitEvalByDirection[dir];
      if (!exitCheck) {
        exitCheck = buildExitEvaluation({
          direction: dir,
          qtyEth: this.config.plannedQtyEth,
          bnView: bnCheck.view,
          hlView: hlCheck.view,
          fxRate: this.lastFx.rate,
          fxSource: this.lastFx.source,
          fees: this.config.fees,
          ts: tDecision,
        });
        tickCache.exitEvalByDirection[dir] = exitCheck;
      }
      if (exitCheck.executable && exitCheck.exitSpreadBps !== null
        && (Number(exitCheck.exitSpreadBps) < Number(this.config.takeProfitBps) - 1e-9
          || new Decimal(exitCheck.exitSpreadBps).lte(this.config.takeProfitBps))) {
        variant.pendingOrder = {
          kind: 'EXIT',
          opportunityId: variant.openPosition.opportunityId,
          groupId: variant.openPosition.groupId,
          direction: variant.openPosition.direction,
          decisionTs: tDecision,
          arrivalTs: tDecision + variant.spec.delayMs,
          decisionSnapshot: {
            longRefPriceUsdt: variant.openPosition.longEntryFill.avgPriceUsdt,
            plannedNotionalUsdt: variant.openPosition.plannedNotionalUsdt,
            fxRate: this.lastFx.rate,
            fxSource: this.lastFx.source,
            bboSpreadBps: null,
            vwapSpreadBps: null,
            estExitBps: exitCheck.exitSpreadBps,
            eventTsLeft: bnCheck.view.sourceTs,
            eventTsRight: hlCheck.view.sourceTs,
            recvTsLeft: bnCheck.view.recvTs,
            recvTsRight: hlCheck.view.recvTs,
          },
        };
        if (variant.spec.delayMs === 0) {
          this.executePendingOrder(variant, bnCheck.view, hlCheck.view, bnStatus, hlStatus);
        }
      }
      return;
    }

    if (!tickCache.bestBbo) {
      tickCache.bestBbo = computeBboOnlyDirection(bnCheck.view, hlCheck.view, this.lastFx.rate);
    }
    const bestBbo = tickCache.bestBbo;
    if (!bestBbo) {
      variant.activeGroupId = null;
      variant.lastGroupDirection = null;
      return;
    }
    const bestBboNum = Number(bestBbo.bboSpreadBps);
    const entryBpsNum = Number(variant.spec.entryBps);
    if (bestBboNum < entryBpsNum - 1e-9
      || (Math.abs(bestBboNum - entryBpsNum) <= 1e-9 && new Decimal(bestBbo.bboSpreadBps).lt(variant.spec.entryBps))) {
      variant.activeGroupId = null;
      variant.lastGroupDirection = null;
      return;
    }

    const direction = bestBbo.direction;
    let evalRes = tickCache.entryEvalByDirection[direction];
    if (!evalRes) {
      evalRes = buildEntryEvaluation({
        direction,
        qtyEth: this.config.plannedQtyEth,
        bnView: bnCheck.view,
        hlView: hlCheck.view,
        fxRate: this.lastFx.rate,
        fxSource: this.lastFx.source,
        fees: this.config.fees,
        ts: tDecision,
      });
      tickCache.entryEvalByDirection[direction] = evalRes;
    }

    variant.rawCandidates += 1;

    let cachedVwap = tickCache.vwapDecisionByDirection[direction];
    if (!cachedVwap) {
      const longVenue: 'BINANCE' | 'HYPERLIQUID' = direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
      const longView = longVenue === 'BINANCE' ? bnCheck.view : hlCheck.view;
      const longRefPriceUsdt = priceInUsdt(longVenue, longView.bestAsk![0], this.lastFx.rate);
      const plannedNotionalUsdt = new Decimal(this.config.plannedQtyEth).mul(longRefPriceUsdt).toDecimalPlaces(8).toString();
      let decisionReject: string | null = null;
      let estExitBps: string | null = null;
      if (!evalRes.executable || evalRes.vwapSpreadUsd === null || evalRes.entryFeesUsd === null) {
        decisionReject = evalRes.rejectReason ?? 'INSUFFICIENT_DEPTH';
      } else {
        const scenarioExitCostBps = new Decimal(this.config.takeProfitBps).plus(this.config.scenarioExitDepthBufferBps);
        estExitBps = scenarioExitCostBps.toString();
        const scenarioExitCostUsd = new Decimal(plannedNotionalUsdt).mul(scenarioExitCostBps).div(10_000);
        const estRoundtripFeesUsd = new Decimal(evalRes.entryFeesUsd).mul(2);
        const estNetUsd = new Decimal(evalRes.vwapSpreadUsd)
          .minus(scenarioExitCostUsd)
          .minus(estRoundtripFeesUsd);
        const minNetUsd = new Decimal(plannedNotionalUsdt).mul(this.config.minNetEntryBps).div(10_000);
        if (estNetUsd.lte(minNetUsd)) {
          decisionReject = 'NET_EDGE_NOT_POSITIVE';
        }
      }
      cachedVwap = { decisionReject, estExitBps, longRefPriceUsdt, plannedNotionalUsdt };
      tickCache.vwapDecisionByDirection[direction] = cachedVwap;
    }

    const longRefPriceUsdt = cachedVwap.longRefPriceUsdt;
    const plannedNotionalUsdt = cachedVwap.plannedNotionalUsdt;
    const decisionReject = variant.spec.version === 'vwap_taker_v2' ? cachedVwap.decisionReject : null;
    const estExitBps = variant.spec.version === 'vwap_taker_v2' ? cachedVwap.estExitBps : null;

    if (decisionReject !== null) {
      this.recordRejection(
        variant,
        decisionReject,
        tDecision,
        direction,
        bnCheck.view,
        hlCheck.view,
        evalRes.bboSpreadBps,
        evalRes.vwapSpreadBps,
        estExitBps,
        longRefPriceUsdt,
        plannedNotionalUsdt,
        'Offline rejection at decision time',
      );
      return;
    }

    if (!variant.activeGroupId || variant.lastGroupDirection !== direction) {
      variant.groupSeq += 1;
      variant.activeGroupId = `grp-${variant.spec.version}-${variant.spec.delayMs}ms-${String(variant.groupSeq).padStart(4, '0')}`;
      variant.lastGroupDirection = direction;
    }
    const nextOppSeq = variant.seq + 1;
    const opportunityId = `${variant.spec.version}-${variant.spec.delayMs}ms-${String(nextOppSeq).padStart(4, '0')}`;

    variant.pendingOrder = {
      kind: 'ENTRY',
      opportunityId,
      groupId: variant.activeGroupId,
      direction,
      decisionTs: tDecision,
      arrivalTs: tDecision + variant.spec.delayMs,
      decisionSnapshot: {
        longRefPriceUsdt,
        plannedNotionalUsdt,
        fxRate: this.lastFx.rate,
        fxSource: this.lastFx.source,
        bboSpreadBps: evalRes.bboSpreadBps,
        vwapSpreadBps: evalRes.vwapSpreadBps,
        estExitBps,
        eventTsLeft: bnCheck.view.sourceTs,
        eventTsRight: hlCheck.view.sourceTs,
        recvTsLeft: bnCheck.view.recvTs,
        recvTsRight: hlCheck.view.recvTs,
      },
    };

    if (variant.spec.delayMs === 0) {
      this.executePendingOrder(variant, bnCheck.view, hlCheck.view, bnStatus, hlStatus);
    }
  }

  finalize(): ReplaySuiteResult {
    const finalTs = this.endedAtMs;
    for (const tracker of this.coverageTrackers) {
      advanceCoverageTo(tracker, finalTs);
    }

    const bnView = this.bnMachine.view();
    const hlView = this.hlMachine.view();
    const bnStatus = this.effectiveBnStatus();
    const hlStatus = this.hlMachine.getState();

    // Mature any pending order whose arrivalTs <= finalTs (only orders strictly <= end of capture).
    this.maturePendingOrdersAtExactTs(finalTs);

    const inFlightOrdersAtEnd: InFlightOrderAtEnd[] = [];
    const unvaluedOpenPositions: UnvaluedOpenPosition[] = [];
    const summaries: VariantSummary[] = [];
    const allRows: TradeScorecardRow[] = [];

    for (const variant of this.variants) {
      if (variant.pendingOrder) {
        inFlightOrdersAtEnd.push({
          age_tier: variant.spec.ageTierLabel,
          entry_bps_threshold: variant.spec.entryBps,
          strategy_version: variant.spec.version,
          delay_ms: variant.spec.delayMs,
          opportunity_id: variant.pendingOrder.opportunityId,
          group_id: variant.pendingOrder.groupId,
          kind: variant.pendingOrder.kind,
          direction: variant.pendingOrder.direction,
          decision_ts: variant.pendingOrder.decisionTs,
          expected_arrival_ts: variant.pendingOrder.arrivalTs,
          ended_at_ms: finalTs,
          status: 'IN_FLIGHT_AT_END',
          reason: `Order arrived at ${variant.pendingOrder.arrivalTs} after recording end ${finalTs}`,
        });
      }

      if (variant.openPosition) {
        const pos = variant.openPosition;
        const targetRow = pos.openRow;
        const funding = computeFundingBreakdown({
          liveSettledFunding: this.hasPreloadedAccountingIndex
            ? this.accountingLiveSettlements
            : this.liveSettledFunding,
          direction: pos.direction,
          qtyEth: this.config.plannedQtyEth,
          entryTs: pos.entryExecTs,
          exitTs: finalTs,
          fallbackBnPriceUsdt: midpointFromView(bnView),
          fallbackHlPriceUsdc: midpointFromView(hlView),
          fallbackFxRate: this.lastFx.rate,
          fallbackFxSource: this.lastFx.source,
        });
        targetRow.funding_events_crossed = funding.count;
        targetRow.funding_net_usd = funding.netUsd;
        targetRow.funding_legs = funding.legs;

        const bnEndCheck = evaluateBookValidity(bnView, finalTs, variant.spec.bnAge, bnStatus);
        const hlEndCheck = evaluateBookValidity(hlView, finalTs, variant.spec.hlAge, hlStatus);
        if (bnEndCheck.valid && hlEndCheck.valid) {
          const endExit = buildExitEvaluation({
            direction: pos.direction,
            qtyEth: this.config.plannedQtyEth,
            bnView: bnEndCheck.view,
            hlView: hlEndCheck.view,
            fxRate: this.lastFx.rate,
            fxSource: this.lastFx.source,
            fees: this.config.fees,
            ts: finalTs,
          });
          if (endExit.executable && endExit.longCloseFill && endExit.shortCloseFill) {
            const pnl = computeNativeContractPnl({
              direction: pos.direction,
              qtyEth: this.config.plannedQtyEth,
              longEntry: pos.longEntryFill,
              shortEntry: pos.shortEntryFill,
              longExit: endExit.longCloseFill,
              shortExit: endExit.shortCloseFill,
              settlementFxRate: this.lastFx.rate,
            });
            const fees4 = new Decimal(pos.longEntryFill.feeUsdt)
              .plus(pos.shortEntryFill.feeUsdt)
              .plus(endExit.longCloseFill.feeUsdt)
              .plus(endExit.shortCloseFill.feeUsdt);
            const mtm = new Decimal(pnl.contractSpreadPnlUsd).plus(funding.netUsd).minus(fees4);
            targetRow.exit_long_fill = endExit.longCloseFill;
            targetRow.exit_short_fill = endExit.shortCloseFill;
            targetRow.bn_contract_pnl_usdt = pnl.bnContractPnlUsdt;
            targetRow.hl_contract_pnl_usdc = pnl.hlContractPnlUsdc;
            targetRow.hl_contract_pnl_usdt = pnl.hlContractPnlUsdt;
            targetRow.contract_spread_pnl_usd = pnl.contractSpreadPnlUsd;
            targetRow.fees_4leg_usd = fees4.toDecimalPlaces(8).toString();
            targetRow.mark_to_close_usd = mtm.toDecimalPlaces(8).toString();
            targetRow.unvalued_qty = '0';
          } else {
            const reason = endExit.rejectReason ?? 'FINAL_CLOSE_INSUFFICIENT_DEPTH';
            targetRow.unvalued_qty = this.config.plannedQtyEth;
            targetRow.manual_notes += `; Unvalued at end: ${reason}`;
            unvaluedOpenPositions.push({
              age_tier: variant.spec.ageTierLabel,
              entry_bps_threshold: variant.spec.entryBps,
              strategy_version: variant.spec.version,
              delay_ms: variant.spec.delayMs,
              opportunity_id: targetRow.opportunity_id,
              planned_qty: targetRow.planned_qty,
              unvalued_qty: targetRow.unvalued_qty,
              reason,
            });
          }
        } else {
          const reason = formatInvalidBookPairReason(bnEndCheck, hlEndCheck, 'FINAL_BOOK_INVALID_');
          targetRow.unvalued_qty = this.config.plannedQtyEth;
          targetRow.manual_notes += `; Unvalued at end: ${reason}`;
          unvaluedOpenPositions.push({
            age_tier: variant.spec.ageTierLabel,
            entry_bps_threshold: variant.spec.entryBps,
            strategy_version: variant.spec.version,
            delay_ms: variant.spec.delayMs,
            opportunity_id: targetRow.opportunity_id,
            planned_qty: targetRow.planned_qty,
            unvalued_qty: targetRow.unvalued_qty,
            reason,
          });
        }
        variant.openPosition = null;
        this.emitFinalizedRow(variant, targetRow);
      }

      if (!this.hasPreloadedAccountingIndex && this.liveSettledFunding.length > 0) {
        this.reconcileClosedRowsFunding(variant);
      }

      for (const row of variant.rows) {
        allRows.push(row);
      }

      const m = variant.metrics;
      const realizedPnl = new Decimal(m.realizedPnlUsd);
      const totalRealizedNotional = new Decimal(m.totalPlannedNotionalUsdt);

      summaries.push({
        age_tier: variant.spec.ageTierLabel,
        entry_bps_threshold: variant.spec.entryBps,
        strategy_version: variant.spec.version,
        delay_ms: variant.spec.delayMs,
        raw_decision_ticks_evaluated: variant.rawDecisionTicksEvaluated,
        raw_candidates: variant.rawCandidates,
        logged_candidates: m.loggedCandidates,
        triggered_count: m.triggeredCount,
        distinct_group_count: m.distinctGroupCount,
        raw_reject_count: variant.rawRejectCount,
        raw_reject_reasons: { ...variant.rawRejectReasons },
        completed_roundtrips: m.completedRoundtrips,
        open_at_end_count: m.openAtEndCount,
        in_flight_at_end_count: variant.pendingOrder ? 1 : 0,
        unvalued_open_count: m.unvaluedOpenCount,
        unvalued_open_qty_eth: m.unvaluedOpenQty,
        realized_roundtrip_pnl_usd: realizedPnl.toDecimalPlaces(6).toString(),
        mark_to_close_open_pnl_usd: new Decimal(m.markOpenPnlUsd).toDecimalPlaces(6).toString(),
        total_fees_usd: new Decimal(m.totalFeesUsd).toDecimalPlaces(6).toString(),
        total_funding_net_usd: new Decimal(m.totalFundingNetUsd).toDecimalPlaces(6).toString(),
        total_planned_notional_usdt: totalRealizedNotional.toDecimalPlaces(4).toString(),
        realized_net_bps: totalRealizedNotional.gt(0)
          ? realizedPnl.div(totalRealizedNotional).mul(10_000).toDecimalPlaces(4).toString()
          : null,
      });
    }

    const totalWindowMs = Math.max(0, finalTs - (this.startedAtMs ?? finalTs));
    const coverageByAgeTier: AgeTierCoverageReport[] = this.coverageTrackers.map((t) => ({
      age_tier: t.config.label,
      bn_max_recv_age_ms: t.config.bn.maxRecvAgeMs,
      bn_max_source_age_ms: t.config.bn.maxSourceAgeMs,
      hl_max_recv_age_ms: t.config.hl.maxRecvAgeMs,
      hl_max_source_age_ms: t.config.hl.maxSourceAgeMs,
      future_source_tolerance_ms: t.config.bn.futureSourceToleranceMs,
      total_window_ms: totalWindowMs,
      bn_valid_ms: t.bnValidMs,
      hl_valid_ms: t.hlValidMs,
      valid_overlap_ms: t.validOverlapMs,
      overlap_ratio_pct: totalWindowMs > 0
        ? new Decimal(t.validOverlapMs).div(totalWindowMs).mul(100).toDecimalPlaces(2).toString()
        : '0',
    }));

    return {
      runId: this.runId,
      generatedAtIso: new Date().toISOString(),
      config: this.config,
      catalog: this.sessionMeta?.catalog ?? null,
      timelineDiagnostics: {
        startedAtMs: this.startedAtMs ?? 0,
        endedAtMs: finalTs,
        startedAtIso: new Date(this.startedAtMs ?? 0).toISOString(),
        endedAtIso: new Date(finalTs).toISOString(),
        eventsProcessed: this.eventsProcessed,
        binanceBridges: this.binanceBridges,
        binanceGaps: this.binanceGaps,
        binanceGapCount: this.binanceGaps.length,
        hyperliquidReconnectFirstValid: this.hlReconnectFirstValid,
        hyperliquidStaleRejectedCount: this.hlStaleRejectedCount,
        crossexBypassCount: this.crossexBypassCount,
        binanceChannelsUsed: this.sessionMeta
          ? [this.sessionMeta.endpoints.binanceWsUrl, this.sessionMeta.endpoints.binanceStreamName]
          : [],
        liveSettledFundingCount: this.liveSettledFunding.length,
        historicalBackfillFundingCount: this.historicalBackfillCount,
        crossFormatPriceUpdates: {
          binance: this.bnMachine.getCrossFormatMutationCount(),
          hyperliquid: this.hlMachine.getCrossFormatMutationCount(),
          total: this.bnMachine.getCrossFormatMutationCount() + this.hlMachine.getCrossFormatMutationCount(),
        },
        coverageByAgeTier,
      },
      summaries,
      rows: allRows,
      inFlightOrdersAtEnd,
      unvaluedOpenPositions,
      sampleDelayComparison: buildSampleDelayComparison(allRows.length > 0 ? allRows : this.delaySampleRows),
    };
  }

  private reconcileClosedRowsFunding(variant: VariantCheckpoint): void {
    const m = variant.metrics;
    for (const row of variant.rows) {
      if (
        row.decision !== 'TRIGGERED'
        || row.is_open_at_end
        || row.exec_arrival_ts === null
        || row.exit_exec_arrival_ts === null
        || !row.exit_long_fill
        || !row.exit_short_fill
      ) {
        continue;
      }
      const fallbackBnPriceUsdt = row.exit_long_fill.venue === 'BINANCE'
        ? row.exit_long_fill.avgPriceNative
        : row.exit_short_fill.avgPriceNative;
      const fallbackHlPriceUsdc = row.exit_long_fill.venue === 'HYPERLIQUID'
        ? row.exit_long_fill.avgPriceNative
        : row.exit_short_fill.avgPriceNative;
      const funding = computeFundingBreakdown({
        liveSettledFunding: this.liveSettledFunding,
        direction: row.direction,
        qtyEth: row.planned_qty,
        entryTs: row.exec_arrival_ts,
        exitTs: row.exit_exec_arrival_ts,
        fallbackBnPriceUsdt,
        fallbackHlPriceUsdc,
        fallbackFxRate: row.fx_usdc_usdt,
        fallbackFxSource: row.fx_source,
      });
      const prevNet = row.funding_net_usd ?? '0';
      if (funding.count === row.funding_events_crossed && funding.netUsd === prevNet) {
        continue;
      }
      const delta = new Decimal(funding.netUsd).minus(prevNet);
      row.funding_events_crossed = funding.count;
      row.funding_net_usd = funding.netUsd;
      row.funding_legs = funding.legs;
      const nextRoundtripNet = new Decimal(row.contract_spread_pnl_usd ?? '0')
        .plus(funding.netUsd)
        .minus(row.fees_4leg_usd ?? '0');
      row.roundtrip_net_pnl_usd = nextRoundtripNet.toDecimalPlaces(8).toString();
      if (row.planned_notional_usdt) {
        row.roundtrip_net_bps = nextRoundtripNet
          .div(row.planned_notional_usdt)
          .mul(10_000)
          .toDecimalPlaces(4)
          .toString();
      }
      row.budget_roi_pct = nextRoundtripNet
        .div(this.config.budgetUsdt)
        .mul(100)
        .toDecimalPlaces(4)
        .toString();
      m.totalFundingNetUsd = new Decimal(m.totalFundingNetUsd).plus(delta).toString();
      m.realizedPnlUsd = new Decimal(m.realizedPnlUsd).plus(delta).toString();
    }
  }
}

function buildSampleDelayComparison(
  rows: readonly TradeScorecardRow[],
): ReplaySuiteResult['sampleDelayComparison'] {
  const zeroRow = rows.find((r) => r.delay_ms === 0 && r.decision === 'TRIGGERED')
    ?? rows.find((r) => r.delay_ms === 0);
  if (!zeroRow) return null;
  const matchingHundred = rows.find(
    (r) =>
      r.delay_ms === 100
      && r.age_tier === zeroRow.age_tier
      && r.entry_bps_threshold === zeroRow.entry_bps_threshold
      && r.strategy_version === zeroRow.strategy_version
      && r.trigger_ts === zeroRow.trigger_ts,
  );

  const toExec = (row: TradeScorecardRow | undefined, delayMs: number): DelayExecutionComparison => {
    if (!row) {
      return {
        delayMs,
        delayModel: delayMs === 0 ? 'zero_delay_last_synced_book' : `fixed_one_way_delay_${delayMs}ms_per_leg`,
        decisionTs: zeroRow.trigger_ts,
        arrivalTs: zeroRow.trigger_ts + delayMs,
        executable: false,
        rejectReason: 'NO_MATCHING_CANDIDATE_OR_IN_FLIGHT',
        longFill: null,
        shortFill: null,
        entrySpreadBpsAtArrival: null,
        entrySpreadUsdAtArrival: null,
        entryFeesUsd: null,
      };
    }
    const feesUsd = row.entry_long_fill && row.entry_short_fill
      ? new Decimal(row.entry_long_fill.feeUsdt).plus(row.entry_short_fill.feeUsdt).toString()
      : null;
    const spreadUsd = row.entry_long_fill && row.entry_short_fill
      ? new Decimal(row.planned_qty)
          .mul(new Decimal(row.entry_short_fill.avgPriceUsdt).minus(row.entry_long_fill.avgPriceUsdt))
          .toDecimalPlaces(8)
          .toString()
      : null;
    return {
      delayMs,
      delayModel: row.delay_model,
      decisionTs: row.trigger_ts,
      arrivalTs: row.exec_arrival_ts ?? (row.trigger_ts + delayMs),
      executable: row.decision === 'TRIGGERED',
      rejectReason: row.reject_reason,
      longFill: row.entry_long_fill,
      shortFill: row.entry_short_fill,
      entrySpreadBpsAtArrival: row.vwap_entry_spread_bps,
      entrySpreadUsdAtArrival: spreadUsd,
      entryFeesUsd: feesUsd,
    };
  };

  return {
    opportunityId: zeroRow.opportunity_id,
    direction: zeroRow.direction,
    decisionTs: zeroRow.trigger_ts,
    zeroMs: toExec(zeroRow, 0),
    hundredMs: toExec(matchingHundred, 100),
  };
}

export function runPhase1Replay(
  events: readonly RecordedMarketEvent[],
  partialConfig: Partial<ReplayConfig> = {},
): ReplaySuiteResult {
  const ordered = [...events].sort((a, b) => a.recvTs - b.recvTs || a.recvSeq - b.recvSeq);
  const preloadedFundingSettlements = extractFundingSettlementsFromEvents(ordered);
  const runner = new StreamingReplayRunner(partialConfig, undefined, { preloadedFundingSettlements });
  for (const ev of ordered) {
    runner.processEvent(ev);
  }
  return runner.finalize();
}

export async function runPhase1ReplayStream(
  ndjsonPath: string,
  partialConfig: Partial<ReplayConfig> = {},
  options: StreamingReplayOptions = {},
): Promise<ReplaySuiteResult> {
  const preloadedFundingSettlements = options.preloadedFundingSettlements
    ?? await extractFundingSettlementsFromFile(ndjsonPath);
  const runner = new StreamingReplayRunner(partialConfig, undefined, {
    ...options,
    preloadedFundingSettlements,
  });
  const rl = createInterface({
    input: createReadStream(ndjsonPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    runner.processEvent(JSON.parse(trimmed) as RecordedMarketEvent);
  }
  return runner.finalize();
}
