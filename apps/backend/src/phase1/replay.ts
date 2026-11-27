import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import {
  BinanceOrderBookStateMachine,
  HyperliquidOrderBookStateMachine,
  walkOrderBookDepth,
  type BinanceBridgeProof,
  type NormalizedOrderBook,
} from './orderbook-state.js';
import type {
  CaptureCatalogMeta,
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
  note: 'Unauthenticated Phase 1 fallback using Binance USD-M VIP0 Taker (5 bps) and Hyperliquid Tier-0 Taker (4.5 bps)',
};

export interface ReplayConfig {
  budgetUsdt: string;
  plannedQtyEth: string;
  assumedLeverage: string;
  entryBps: string;
  takeProfitBps: string;
  scenarioExitDepthBufferBps: string;
  minNetEntryBps: string;
  maxBookAgeMs: number;
  delaysMs: number[];
  cooldownBetweenRejectsMs: number;
  fees: FeeScheduleAssumption;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  budgetUsdt: '2000',
  plannedQtyEth: '0.500',
  assumedLeverage: '5',
  entryBps: '2',
  takeProfitBps: '0',
  scenarioExitDepthBufferBps: '1',
  minNetEntryBps: '0',
  maxBookAgeMs: 15_000,
  delaysMs: [0, 100],
  cooldownBetweenRejectsMs: 1_000,
  fees: DEFAULT_VIP0_FEES,
};

export interface BookTimelinePoint {
  ts: number;
  recvSeq: number;
  connGen: number;
  valid: boolean;
  reason: string;
  book: NormalizedOrderBook | null;
}

export interface TimelineIndex {
  sessionMeta: SessionMetaEvent | null;
  startedAtMs: number;
  endedAtMs: number;
  binanceTimeline: BookTimelinePoint[];
  hyperliquidTimeline: BookTimelinePoint[];
  fxTimeline: Array<{ ts: number; rate: string; source: string }>;
  settledFunding: {
    binance: Array<{ time: number; rate: string; source: string }>;
    hyperliquid: Array<{ time: number; rate: string; source: string }>;
  };
  diagnostics: {
    binanceBridges: BinanceBridgeProof[];
    binanceGaps: Array<{ recvTs: number; connGen: number; expectedPu: string; actualPu: string; U: string; u: string }>;
    binanceGapCount: number;
    hyperliquidReconnectFirstValid: Array<{ recvTs: number; connGen: number; sourceTs: number; bidLevels: number; askLevels: number }>;
    hyperliquidStaleRejectedCount: number;
    crossexBypassCount: number;
    validOverlapMs: number;
    totalWindowMs: number;
  };
}

export interface LegFillDetail {
  venue: 'BINANCE' | 'HYPERLIQUID';
  symbol: string;
  side: 'BUY' | 'SELL';
  qtyEth: string;
  avgPriceNative: string;
  avgPriceUsdt: string;
  feeRate: string;
  feeUsdt: string;
  execTs: number;
  bookSourceTs: number;
  bookRecvTs: number;
  levelsUsed: number;
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
  entry_spread_pnl_usd: string | null;
  exit_spread_pnl_usd: string | null;
  fees_4leg_usd: string | null;
  funding_events_crossed: number;
  funding_net_usd: string | null;
  borrowing_cost_est_usd: string | null;
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
  strategy_version: StrategyVersion;
  delay_ms: number;
  total_candidates: number;
  triggered_count: number;
  rejected_count: number;
  reject_reasons: Record<string, number>;
  completed_roundtrips: number;
  open_at_end_count: number;
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
  timelineDiagnostics: TimelineIndex['diagnostics'] & {
    startedAtIso: string;
    endedAtIso: string;
    binanceChannelsUsed: string[];
  };
  summaries: VariantSummary[];
  rows: TradeScorecardRow[];
  sampleDelayComparison: {
    opportunityId: string;
    direction: Direction;
    decisionTs: number;
    zeroMs: DelayExecutionComparison;
    hundredMs: DelayExecutionComparison;
  } | null;
}

export function parseEventsNdjson(rawText: string): RecordedMarketEvent[] {
  const events: RecordedMarketEvent[] = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events.push(JSON.parse(trimmed) as RecordedMarketEvent);
  }
  events.sort((a, b) => a.recvTs - b.recvTs || a.recvSeq - b.recvSeq);
  return events;
}

export function loadEventsFromFile(path: string): RecordedMarketEvent[] {
  return parseEventsNdjson(readFileSync(path, 'utf8'));
}

export function latestPointAt(timeline: readonly BookTimelinePoint[], ts: number): BookTimelinePoint | null {
  let lo = 0;
  let hi = timeline.length - 1;
  let best: BookTimelinePoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = timeline[mid]!;
    if (item.ts <= ts) {
      best = item;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function latestFxAt(
  fxTimeline: ReadonlyArray<{ ts: number; rate: string; source: string }>,
  ts: number,
): { rate: string; source: string } {
  let lo = 0;
  let hi = fxTimeline.length - 1;
  let best: { ts: number; rate: string; source: string } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = fxTimeline[mid]!;
    if (item.ts <= ts) {
      best = item;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ? { rate: best.rate, source: best.source } : { rate: '1', source: 'parity_fallback' };
}

export function buildReplayTimeline(events: readonly RecordedMarketEvent[]): TimelineIndex {
  const bnMachine = new BinanceOrderBookStateMachine();
  const hlMachine = new HyperliquidOrderBookStateMachine();

  let sessionMeta: SessionMetaEvent | null = null;
  const binanceTimeline: BookTimelinePoint[] = [];
  const hyperliquidTimeline: BookTimelinePoint[] = [];
  const fxTimeline: Array<{ ts: number; rate: string; source: string }> = [];
  const bnSettledMap = new Map<number, { time: number; rate: string; source: string }>();
  const hlSettledMap = new Map<number, { time: number; rate: string; source: string }>();

  const binanceBridges: BinanceBridgeProof[] = [];
  const binanceGaps: TimelineIndex['diagnostics']['binanceGaps'] = [];
  const hyperliquidReconnectFirstValid: TimelineIndex['diagnostics']['hyperliquidReconnectFirstValid'] = [];
  let hyperliquidStaleRejectedCount = 0;
  let crossexBypassCount = 0;

  let bnOpenPendingSnapshot = false;

  for (const ev of events) {
    if (ev.type === 'session_meta') {
      sessionMeta = ev;
      continue;
    }
    if (ev.type === 'cx_raw') {
      crossexBypassCount += 1;
      continue;
    }
    if (ev.type === 'fx_rate') {
      fxTimeline.push({ ts: ev.recvTs, rate: ev.rate, source: ev.source });
      continue;
    }
    if (ev.type === 'funding_settled') {
      if (ev.venue === 'BINANCE') {
        bnSettledMap.set(ev.settlementTime, {
          time: ev.settlementTime,
          rate: ev.fundingRate,
          source: ev.source,
        });
      } else {
        hlSettledMap.set(ev.settlementTime, {
          time: ev.settlementTime,
          rate: ev.fundingRate,
          source: ev.source,
        });
      }
      continue;
    }
    if (ev.type === 'conn_event') {
      if (ev.venue === 'BINANCE') {
        if (ev.status === 'open') {
          bnMachine.onConnectionOpen(ev.connGen);
          bnOpenPendingSnapshot = true;
          binanceTimeline.push({
            ts: ev.recvTs,
            recvSeq: ev.recvSeq,
            connGen: ev.connGen,
            valid: false,
            reason: 'BOOK_RESYNCING_OPEN',
            book: null,
          });
        } else if (ev.status === 'close' || ev.status === 'injected_disconnect') {
          bnMachine.markGapResyncing();
          binanceTimeline.push({
            ts: ev.recvTs,
            recvSeq: ev.recvSeq,
            connGen: ev.connGen,
            valid: false,
            reason: `DISCONNECT_${ev.status.toUpperCase()}`,
            book: null,
          });
        }
      } else if (ev.venue === 'HYPERLIQUID') {
        if (ev.status === 'open') {
          hlMachine.onConnectionOpen(ev.connGen);
          hyperliquidTimeline.push({
            ts: ev.recvTs,
            recvSeq: ev.recvSeq,
            connGen: ev.connGen,
            valid: false,
            reason: 'HL_WAITING_SNAPSHOT',
            book: null,
          });
        } else if (ev.status === 'close' || ev.status === 'injected_disconnect') {
          hyperliquidTimeline.push({
            ts: ev.recvTs,
            recvSeq: ev.recvSeq,
            connGen: ev.connGen,
            valid: false,
            reason: `DISCONNECT_${ev.status.toUpperCase()}`,
            book: null,
          });
        }
      }
      continue;
    }
    if (ev.type === 'bn_depth_snapshot') {
      const res = bnMachine.onRestSnapshot({
        connGen: ev.connGen,
        fetchedAtMs: ev.recvTs,
        lastUpdateId: ev.lastUpdateId,
        bids: ev.bids,
        asks: ev.asks,
      });
      if (res.kind === 'bridge_ready') {
        bnOpenPendingSnapshot = false;
        binanceBridges.push(res.proof);
        binanceTimeline.push({
          ts: ev.recvTs,
          recvSeq: ev.recvSeq,
          connGen: ev.connGen,
          valid: true,
          reason: 'BRIDGE_READY',
          book: bnMachine.snapshot(),
        });
      }
      continue;
    }
    if (ev.type === 'bn_depth_delta') {
      const res = bnMachine.onDepthDelta({
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
      if (res.kind === 'bridge_ready') {
        bnOpenPendingSnapshot = false;
        binanceBridges.push(res.proof);
        binanceTimeline.push({
          ts: ev.recvTs,
          recvSeq: ev.recvSeq,
          connGen: ev.connGen,
          valid: true,
          reason: 'BRIDGE_READY',
          book: bnMachine.snapshot(),
        });
      } else if (res.kind === 'applied') {
        binanceTimeline.push({
          ts: ev.recvTs,
          recvSeq: ev.recvSeq,
          connGen: ev.connGen,
          valid: true,
          reason: 'DELTA_APPLIED',
          book: bnMachine.snapshot(),
        });
      } else if (res.kind === 'sequence_gap') {
        binanceGaps.push({
          recvTs: ev.recvTs,
          connGen: ev.connGen,
          expectedPu: res.expectedPu,
          actualPu: res.actualPu,
          U: res.U,
          u: res.u,
        });
        bnMachine.markGapResyncing();
        binanceTimeline.push({
          ts: ev.recvTs,
          recvSeq: ev.recvSeq,
          connGen: ev.connGen,
          valid: false,
          reason: 'SEQUENCE_GAP',
          book: null,
        });
      } else if (res.kind === 'bridge_failed_refetch' && bnOpenPendingSnapshot) {
        binanceTimeline.push({
          ts: ev.recvTs,
          recvSeq: ev.recvSeq,
          connGen: ev.connGen,
          valid: false,
          reason: 'BRIDGE_FAILED_REFETCH',
          book: null,
        });
      }
      continue;
    }
    if (ev.type === 'hl_l2book') {
      const res = hlMachine.onSnapshot({
        connGen: ev.connGen,
        sourceTs: ev.sourceTs,
        recvTs: ev.recvTs,
        bids: ev.bids,
        asks: ev.asks,
      });
      if (res.kind === 'applied') {
        if (res.firstForConnection && ev.connGen > 1) {
          hyperliquidReconnectFirstValid.push({
            recvTs: ev.recvTs,
            connGen: ev.connGen,
            sourceTs: ev.sourceTs,
            bidLevels: ev.bidLevels,
            askLevels: ev.askLevels,
          });
        }
        hyperliquidTimeline.push({
          ts: ev.recvTs,
          recvSeq: ev.recvSeq,
          connGen: ev.connGen,
          valid: true,
          reason: res.firstForConnection ? 'HL_FIRST_SNAPSHOT' : 'HL_SNAPSHOT',
          book: res.book,
        });
      } else if (res.kind === 'stale_backward_ignored') {
        hyperliquidStaleRejectedCount += 1;
      }
    }
  }

  const startedAtMs = events[0]?.recvTs ?? 0;
  const endedAtMs = events[events.length - 1]?.recvTs ?? startedAtMs;
  const validOverlapMs = computeValidOverlapMs(binanceTimeline, hyperliquidTimeline, endedAtMs);

  return {
    sessionMeta,
    startedAtMs,
    endedAtMs,
    binanceTimeline,
    hyperliquidTimeline,
    fxTimeline,
    settledFunding: {
      binance: [...bnSettledMap.values()].sort((a, b) => a.time - b.time),
      hyperliquid: [...hlSettledMap.values()].sort((a, b) => a.time - b.time),
    },
    diagnostics: {
      binanceBridges,
      binanceGaps,
      binanceGapCount: binanceGaps.length,
      hyperliquidReconnectFirstValid,
      hyperliquidStaleRejectedCount,
      crossexBypassCount,
      validOverlapMs,
      totalWindowMs: Math.max(0, endedAtMs - startedAtMs),
    },
  };
}

function computeValidOverlapMs(
  bn: readonly BookTimelinePoint[],
  hl: readonly BookTimelinePoint[],
  endedAtMs: number,
): number {
  const boundaries = new Set<number>([endedAtMs]);
  for (const p of bn) boundaries.add(p.ts);
  for (const p of hl) boundaries.add(p.ts);
  const sorted = [...boundaries].sort((a, b) => a - b);
  let overlap = 0;
  let bi = 0;
  let hi = 0;
  let bnValid = false;
  let hlValid = false;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const t = sorted[i]!;
    const nextT = sorted[i + 1]!;
    while (bi < bn.length && bn[bi]!.ts <= t) {
      bnValid = bn[bi]!.valid;
      bi += 1;
    }
    while (hi < hl.length && hl[hi]!.ts <= t) {
      hlValid = hl[hi]!.valid;
      hi += 1;
    }
    if (bnValid && hlValid) {
      overlap += nextT - t;
    }
  }
  return overlap;
}

function isFreshValidBook(point: BookTimelinePoint | null, atTs: number, maxAgeMs: number): point is BookTimelinePoint & { book: NormalizedOrderBook } {
  if (!point || !point.valid || !point.book) return false;
  return atTs - point.book.recvTs <= maxAgeMs;
}

function priceInUsdt(venue: 'BINANCE' | 'HYPERLIQUID', price: string, fxRate: string): string {
  if (venue === 'BINANCE') return price;
  return new Decimal(price).mul(fxRate).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString();
}

function evaluateEntryAtBooks(params: {
  direction: Direction;
  qtyEth: string;
  bnBook: NormalizedOrderBook;
  hlBook: NormalizedOrderBook;
  fxRate: string;
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
  const longBook = longVenue === 'BINANCE' ? params.bnBook : params.hlBook;
  const shortBook = shortVenue === 'BINANCE' ? params.bnBook : params.hlBook;

  const longTopAsk = longBook.asks[0]?.[0];
  const shortTopBid = shortBook.bids[0]?.[0];
  if (!longTopAsk || !shortTopBid) {
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

  const longBboUsdt = new Decimal(priceInUsdt(longVenue, longTopAsk, params.fxRate));
  const shortBboUsdt = new Decimal(priceInUsdt(shortVenue, shortTopBid, params.fxRate));
  const bboSpreadBps = shortBboUsdt.minus(longBboUsdt).div(longBboUsdt).mul(10_000).toDecimalPlaces(4).toString();

  const longWalk = walkOrderBookDepth(longBook.asks, params.qtyEth);
  const shortWalk = walkOrderBookDepth(shortBook.bids, params.qtyEth);
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

  const longFeeUsdt = qty.mul(longVwapUsdt).mul(longFeeRate).toDecimalPlaces(8);
  const shortFeeUsdt = qty.mul(shortVwapUsdt).mul(shortFeeRate).toDecimalPlaces(8);
  const vwapSpreadUsd = qty.mul(shortVwapUsdt.minus(longVwapUsdt)).toDecimalPlaces(8);
  const vwapSpreadBps = shortVwapUsdt.minus(longVwapUsdt).div(longVwapUsdt).mul(10_000).toDecimalPlaces(4);

  const longFill: LegFillDetail = {
    venue: longVenue,
    symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'BUY',
    qtyEth: params.qtyEth,
    avgPriceNative: longWalk.vwapPrice,
    avgPriceUsdt: longVwapUsdt.toString(),
    feeRate: longFeeRate,
    feeUsdt: longFeeUsdt.toString(),
    execTs: params.ts,
    bookSourceTs: longBook.sourceTs,
    bookRecvTs: longBook.recvTs,
    levelsUsed: longWalk.levelsUsed,
  };
  const shortFill: LegFillDetail = {
    venue: shortVenue,
    symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'SELL',
    qtyEth: params.qtyEth,
    avgPriceNative: shortWalk.vwapPrice,
    avgPriceUsdt: shortVwapUsdt.toString(),
    feeRate: shortFeeRate,
    feeUsdt: shortFeeUsdt.toString(),
    execTs: params.ts,
    bookSourceTs: shortBook.sourceTs,
    bookRecvTs: shortBook.recvTs,
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

function evaluateExitAtBooks(params: {
  direction: Direction;
  qtyEth: string;
  bnBook: NormalizedOrderBook;
  hlBook: NormalizedOrderBook;
  fxRate: string;
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
  const longBook = longVenue === 'BINANCE' ? params.bnBook : params.hlBook;
  const shortBook = shortVenue === 'BINANCE' ? params.bnBook : params.hlBook;

  // Closing Long = SELL on bids; closing Short = BUY on asks.
  const longSellWalk = walkOrderBookDepth(longBook.bids, params.qtyEth);
  const shortBuyWalk = walkOrderBookDepth(shortBook.asks, params.qtyEth);
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

  const longCloseFill: LegFillDetail = {
    venue: longVenue,
    symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'SELL',
    qtyEth: params.qtyEth,
    avgPriceNative: longSellWalk.vwapPrice,
    avgPriceUsdt: longExitUsdt.toString(),
    feeRate: longFeeRate,
    feeUsdt: qty.mul(longExitUsdt).mul(longFeeRate).toDecimalPlaces(8).toString(),
    execTs: params.ts,
    bookSourceTs: longBook.sourceTs,
    bookRecvTs: longBook.recvTs,
    levelsUsed: longSellWalk.levelsUsed,
  };
  const shortCloseFill: LegFillDetail = {
    venue: shortVenue,
    symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'BUY',
    qtyEth: params.qtyEth,
    avgPriceNative: shortBuyWalk.vwapPrice,
    avgPriceUsdt: shortExitUsdt.toString(),
    feeRate: shortFeeRate,
    feeUsdt: qty.mul(shortExitUsdt).mul(shortFeeRate).toDecimalPlaces(8).toString(),
    execTs: params.ts,
    bookSourceTs: shortBook.sourceTs,
    bookRecvTs: shortBook.recvTs,
    levelsUsed: shortBuyWalk.levelsUsed,
  };

  // Exit spread defined symmetrically with entry: (B close buy - A close sell) / A close sell.
  const exitSpreadBps = shortExitUsdt.minus(longExitUsdt).div(longExitUsdt).mul(10_000).toDecimalPlaces(4).toString();
  return {
    executable: true,
    rejectReason: null,
    longCloseFill,
    shortCloseFill,
    exitSpreadBps,
  };
}

function computeCrossedFundingUsd(params: {
  timeline: TimelineIndex;
  direction: Direction;
  qtyEth: string;
  longRefPriceUsdt: string;
  entryTs: number;
  exitTs: number;
  fxRate: string;
}): { count: number; netUsd: string } {
  const longVenue = params.direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
  let count = 0;
  let net = new Decimal(0);
  const notional = new Decimal(params.qtyEth).mul(params.longRefPriceUsdt);

  for (const s of params.timeline.settledFunding.binance) {
    if (s.time > params.entryTs && s.time <= params.exitTs) {
      count += 1;
      const payment = notional.mul(s.rate);
      // Long pays positive rate; short receives positive rate.
      net = longVenue === 'BINANCE' ? net.minus(payment) : net.plus(payment);
    }
  }
  for (const s of params.timeline.settledFunding.hyperliquid) {
    if (s.time > params.entryTs && s.time <= params.exitTs) {
      count += 1;
      const payment = notional.mul(s.rate).mul(params.fxRate);
      net = longVenue === 'HYPERLIQUID' ? net.minus(payment) : net.plus(payment);
    }
  }
  return { count, netUsd: net.toDecimalPlaces(8).toString() };
}

function simulateVariant(params: {
  runId: string;
  timeline: TimelineIndex;
  config: ReplayConfig;
  version: StrategyVersion;
  delayMs: number;
}): { summary: VariantSummary; rows: TradeScorecardRow[] } {
  const { runId, timeline, config, version, delayMs } = params;
  const decisionTimes = [...new Set([
    ...timeline.binanceTimeline.filter((p) => p.valid).map((p) => p.ts),
    ...timeline.hyperliquidTimeline.filter((p) => p.valid).map((p) => p.ts),
  ])].sort((a, b) => a - b);

  const rows: TradeScorecardRow[] = [];
  const rejectReasons: Record<string, number> = {};
  const delayModel = delayMs === 0
    ? 'zero_delay_last_synced_book'
    : `fixed_one_way_delay_${delayMs}ms_per_leg`;

  let openPosition: {
    rowIndex: number;
    direction: Direction;
    entryTs: number;
    longEntryFill: LegFillDetail;
    shortEntryFill: LegFillDetail;
    plannedNotionalUsdt: string;
    groupId: string;
  } | null = null;

  let seq = 0;
  let groupSeq = 0;
  let activeGroupId: string | null = null;
  let lastGroupDirection: Direction | null = null;
  let lastRejectTs = Number.NEGATIVE_INFINITY;

  const incReject = (reason: string) => {
    rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
  };

  for (const tDecision of decisionTimes) {
    const bnPoint = latestPointAt(timeline.binanceTimeline, tDecision);
    const hlPoint = latestPointAt(timeline.hyperliquidTimeline, tDecision);
    if (!isFreshValidBook(bnPoint, tDecision, config.maxBookAgeMs)
      || !isFreshValidBook(hlPoint, tDecision, config.maxBookAgeMs)) {
      continue;
    }

    const fxAtDecision = latestFxAt(timeline.fxTimeline, tDecision);

    if (openPosition) {
      const exitCheck = evaluateExitAtBooks({
        direction: openPosition.direction,
        qtyEth: config.plannedQtyEth,
        bnBook: bnPoint.book,
        hlBook: hlPoint.book,
        fxRate: fxAtDecision.rate,
        fees: config.fees,
        ts: tDecision,
      });
      if (exitCheck.executable && exitCheck.exitSpreadBps !== null
        && new Decimal(exitCheck.exitSpreadBps).lte(config.takeProfitBps)) {
        const arrivalTs = tDecision + delayMs;
        const bnArr = latestPointAt(timeline.binanceTimeline, arrivalTs);
        const hlArr = latestPointAt(timeline.hyperliquidTimeline, arrivalTs);
        if (isFreshValidBook(bnArr, arrivalTs, config.maxBookAgeMs)
          && isFreshValidBook(hlArr, arrivalTs, config.maxBookAgeMs)) {
          const fxArr = latestFxAt(timeline.fxTimeline, arrivalTs);
          const execExit = evaluateExitAtBooks({
            direction: openPosition.direction,
            qtyEth: config.plannedQtyEth,
            bnBook: bnArr.book,
            hlBook: hlArr.book,
            fxRate: fxArr.rate,
            fees: config.fees,
            ts: arrivalTs,
          });
          if (execExit.executable && execExit.longCloseFill && execExit.shortCloseFill) {
            const targetRow = rows[openPosition.rowIndex]!;
            const qty = new Decimal(config.plannedQtyEth);
            const entrySpreadPnl = qty.mul(
              new Decimal(openPosition.shortEntryFill.avgPriceUsdt).minus(openPosition.longEntryFill.avgPriceUsdt),
            );
            const exitSpreadPnl = qty.mul(
              new Decimal(execExit.shortCloseFill.avgPriceUsdt).minus(execExit.longCloseFill.avgPriceUsdt),
            ).neg();
            const fees4 = new Decimal(openPosition.longEntryFill.feeUsdt)
              .plus(openPosition.shortEntryFill.feeUsdt)
              .plus(execExit.longCloseFill.feeUsdt)
              .plus(execExit.shortCloseFill.feeUsdt);
            const funding = computeCrossedFundingUsd({
              timeline,
              direction: openPosition.direction,
              qtyEth: config.plannedQtyEth,
              longRefPriceUsdt: targetRow.long_ref_price_usdt!,
              entryTs: openPosition.entryTs,
              exitTs: arrivalTs,
              fxRate: fxArr.rate,
            });
            const netPnl = entrySpreadPnl.plus(exitSpreadPnl).plus(funding.netUsd).minus(fees4);
            const netBps = netPnl.div(openPosition.plannedNotionalUsdt).mul(10_000).toDecimalPlaces(4);
            const roiPct = netPnl.div(config.budgetUsdt).mul(100).toDecimalPlaces(4);

            targetRow.exit_long_fill = execExit.longCloseFill;
            targetRow.exit_short_fill = execExit.shortCloseFill;
            targetRow.entry_spread_pnl_usd = entrySpreadPnl.toDecimalPlaces(8).toString();
            targetRow.exit_spread_pnl_usd = exitSpreadPnl.toDecimalPlaces(8).toString();
            targetRow.fees_4leg_usd = fees4.toDecimalPlaces(8).toString();
            targetRow.funding_events_crossed = funding.count;
            targetRow.funding_net_usd = funding.netUsd;
            targetRow.borrowing_cost_est_usd = '0';
            targetRow.roundtrip_net_pnl_usd = netPnl.toDecimalPlaces(8).toString();
            targetRow.roundtrip_net_bps = netBps.toString();
            targetRow.budget_roi_pct = roiPct.toString();
            targetRow.is_open_at_end = false;
            openPosition = null;
            continue;
          }
        }
      }
      continue;
    }

    // Evaluate both directions and choose the one with better BBO/VWAP spread.
    const evalA = evaluateEntryAtBooks({
      direction: 'LONG_BN_SHORT_HL',
      qtyEth: config.plannedQtyEth,
      bnBook: bnPoint.book,
      hlBook: hlPoint.book,
      fxRate: fxAtDecision.rate,
      fees: config.fees,
      ts: tDecision,
    });
    const evalB = evaluateEntryAtBooks({
      direction: 'LONG_HL_SHORT_BN',
      qtyEth: config.plannedQtyEth,
      bnBook: bnPoint.book,
      hlBook: hlPoint.book,
      fxRate: fxAtDecision.rate,
      fees: config.fees,
      ts: tDecision,
    });

    const pickBetter = (): { direction: Direction; evalRes: typeof evalA } => {
      const aScore = evalA.bboSpreadBps ? new Decimal(evalA.bboSpreadBps) : new Decimal(-999999);
      const bScore = evalB.bboSpreadBps ? new Decimal(evalB.bboSpreadBps) : new Decimal(-999999);
      return bScore.gt(aScore)
        ? { direction: 'LONG_HL_SHORT_BN', evalRes: evalB }
        : { direction: 'LONG_BN_SHORT_HL', evalRes: evalA };
    };
    const { direction, evalRes } = pickBetter();
    if (!evalRes.bboSpreadBps) continue;

    // Only log candidates when headline BBO spread actually meets baseline entryBps threshold
    // (keeps candidate log dense with meaningful arbitrage signals rather than 100ms noise).
    if (new Decimal(evalRes.bboSpreadBps).lt(config.entryBps)) {
      activeGroupId = null;
      lastGroupDirection = null;
      continue;
    }

    const longVenue: 'BINANCE' | 'HYPERLIQUID' = direction === 'LONG_BN_SHORT_HL' ? 'BINANCE' : 'HYPERLIQUID';
    const shortVenue: 'BINANCE' | 'HYPERLIQUID' = longVenue === 'BINANCE' ? 'HYPERLIQUID' : 'BINANCE';
    const longBook = longVenue === 'BINANCE' ? bnPoint.book : hlPoint.book;
    const longRefPriceUsdt = priceInUsdt(longVenue, longBook.asks[0]![0], fxAtDecision.rate);
    const plannedNotionalUsdt = new Decimal(config.plannedQtyEth).mul(longRefPriceUsdt).toDecimalPlaces(8).toString();

    let decisionReject: string | null = null;
    let estExitBps: string | null = null;

    if (version === 'vwap_taker_v2') {
      if (!evalRes.executable || evalRes.vwapSpreadUsd === null || evalRes.entryFeesUsd === null) {
        decisionReject = evalRes.rejectReason ?? 'INSUFFICIENT_DEPTH';
      } else {
        const scenarioExitCostBps = new Decimal(config.takeProfitBps).plus(config.scenarioExitDepthBufferBps);
        estExitBps = scenarioExitCostBps.toString();
        const scenarioExitCostUsd = new Decimal(plannedNotionalUsdt).mul(scenarioExitCostBps).div(10_000);
        // Conservative est roundtrip fees = 2 * entryFeesUsd (entry + exit taker legs).
        const estRoundtripFeesUsd = new Decimal(evalRes.entryFeesUsd).mul(2);
        const estNetUsd = new Decimal(evalRes.vwapSpreadUsd)
          .minus(scenarioExitCostUsd)
          .minus(estRoundtripFeesUsd);
        const minNetUsd = new Decimal(plannedNotionalUsdt).mul(config.minNetEntryBps).div(10_000);
        if (estNetUsd.lte(minNetUsd)) {
          decisionReject = 'NET_EDGE_NOT_POSITIVE';
        }
      }
    }

    if (decisionReject !== null) {
      if (tDecision - lastRejectTs < config.cooldownBetweenRejectsMs) {
        continue;
      }
      lastRejectTs = tDecision;
      seq += 1;
      incReject(decisionReject);
      rows.push({
        run_id: runId,
        strategy_version: version,
        delay_ms: delayMs,
        delay_model: delayModel,
        opportunity_id: `${version}-${delayMs}ms-${String(seq).padStart(4, '0')}`,
        group_id: activeGroupId ?? `grp-${version}-${delayMs}ms-rej-${String(seq).padStart(4, '0')}`,
        asset: 'ETH',
        direction,
        long_venue: longVenue,
        short_venue: shortVenue,
        long_symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
        short_symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
        decision: 'REJECTED',
        reject_reason: decisionReject,
        trigger_ts: tDecision,
        event_ts_left: bnPoint.book.sourceTs,
        event_ts_right: hlPoint.book.sourceTs,
        recv_ts_left: bnPoint.book.recvTs,
        recv_ts_right: hlPoint.book.recvTs,
        budget_usdt: config.budgetUsdt,
        planned_qty: config.plannedQtyEth,
        actual_filled_qty: '0',
        unit_multiplier_normalized: '1',
        long_ref_price_usdt: longRefPriceUsdt,
        planned_notional_usdt: plannedNotionalUsdt,
        denominator_rule: 'planned_notional_usdt = Q_plan * long_ref_price_in_usdt',
        fx_usdc_usdt: fxAtDecision.rate,
        fx_source: fxAtDecision.source,
        fee_source: config.fees.source,
        fee_assumption_detail: `${config.fees.binanceContract} ${config.fees.binanceTakerFeeRate}; ${config.fees.hyperliquidContract} ${config.fees.hyperliquidTakerFeeRate}`,
        exit_assumption: `Pre-trade scenario only: takeProfitBps(${config.takeProfitBps}) + exitDepthBuffer(${config.scenarioExitDepthBufferBps} bps)`,
        bbo_entry_spread_bps: evalRes.bboSpreadBps,
        vwap_entry_spread_bps: evalRes.vwapSpreadBps,
        est_exit_spread_bps: estExitBps,
        entry_long_fill: null,
        entry_short_fill: null,
        exit_long_fill: null,
        exit_short_fill: null,
        entry_spread_pnl_usd: null,
        exit_spread_pnl_usd: null,
        fees_4leg_usd: null,
        funding_events_crossed: 0,
        funding_net_usd: null,
        borrowing_cost_est_usd: null,
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
        book_gap_count: timeline.diagnostics.binanceGapCount,
        manual_intervention_count: 0,
        manual_notes: 'Offline rejection at decision time',
      });
      continue;
    }

    // Attempt execution at arrival timestamp (tDecision + delayMs).
    const arrivalTs = tDecision + delayMs;
    const bnArr = latestPointAt(timeline.binanceTimeline, arrivalTs);
    const hlArr = latestPointAt(timeline.hyperliquidTimeline, arrivalTs);
    if (!isFreshValidBook(bnArr, arrivalTs, config.maxBookAgeMs)
      || !isFreshValidBook(hlArr, arrivalTs, config.maxBookAgeMs)) {
      if (tDecision - lastRejectTs < config.cooldownBetweenRejectsMs) continue;
      lastRejectTs = tDecision;
      seq += 1;
      const reason = 'EXEC_BOOK_INVALID_AT_ARRIVAL';
      incReject(reason);
      rows.push({
        run_id: runId,
        strategy_version: version,
        delay_ms: delayMs,
        delay_model: delayModel,
        opportunity_id: `${version}-${delayMs}ms-${String(seq).padStart(4, '0')}`,
        group_id: activeGroupId ?? `grp-${version}-${delayMs}ms-rej-${String(seq).padStart(4, '0')}`,
        asset: 'ETH',
        direction,
        long_venue: longVenue,
        short_venue: shortVenue,
        long_symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
        short_symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
        decision: 'REJECTED',
        reject_reason: reason,
        trigger_ts: tDecision,
        event_ts_left: bnPoint.book.sourceTs,
        event_ts_right: hlPoint.book.sourceTs,
        recv_ts_left: bnPoint.book.recvTs,
        recv_ts_right: hlPoint.book.recvTs,
        budget_usdt: config.budgetUsdt,
        planned_qty: config.plannedQtyEth,
        actual_filled_qty: '0',
        unit_multiplier_normalized: '1',
        long_ref_price_usdt: longRefPriceUsdt,
        planned_notional_usdt: plannedNotionalUsdt,
        denominator_rule: 'planned_notional_usdt = Q_plan * long_ref_price_in_usdt',
        fx_usdc_usdt: fxAtDecision.rate,
        fx_source: fxAtDecision.source,
        fee_source: config.fees.source,
        fee_assumption_detail: `${config.fees.binanceContract} ${config.fees.binanceTakerFeeRate}; ${config.fees.hyperliquidContract} ${config.fees.hyperliquidTakerFeeRate}`,
        exit_assumption: `Pre-trade scenario only: takeProfitBps(${config.takeProfitBps}) + exitDepthBuffer(${config.scenarioExitDepthBufferBps} bps)`,
        bbo_entry_spread_bps: evalRes.bboSpreadBps,
        vwap_entry_spread_bps: evalRes.vwapSpreadBps,
        est_exit_spread_bps: estExitBps,
        entry_long_fill: null,
        entry_short_fill: null,
        exit_long_fill: null,
        exit_short_fill: null,
        entry_spread_pnl_usd: null,
        exit_spread_pnl_usd: null,
        fees_4leg_usd: null,
        funding_events_crossed: 0,
        funding_net_usd: null,
        borrowing_cost_est_usd: null,
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
        book_gap_count: timeline.diagnostics.binanceGapCount,
        manual_intervention_count: 0,
        manual_notes: `Arrival book invalid/resyncing at t+${delayMs}ms`,
      });
      continue;
    }

    const fxArr = latestFxAt(timeline.fxTimeline, arrivalTs);
    const execEntry = evaluateEntryAtBooks({
      direction,
      qtyEth: config.plannedQtyEth,
      bnBook: bnArr.book,
      hlBook: hlArr.book,
      fxRate: fxArr.rate,
      fees: config.fees,
      ts: arrivalTs,
    });

    if (!execEntry.executable || !execEntry.longFill || !execEntry.shortFill) {
      if (tDecision - lastRejectTs < config.cooldownBetweenRejectsMs) continue;
      lastRejectTs = tDecision;
      seq += 1;
      const reason = `EXEC_${execEntry.rejectReason ?? 'INSUFFICIENT_DEPTH'}`;
      incReject(reason);
      rows.push({
        run_id: runId,
        strategy_version: version,
        delay_ms: delayMs,
        delay_model: delayModel,
        opportunity_id: `${version}-${delayMs}ms-${String(seq).padStart(4, '0')}`,
        group_id: activeGroupId ?? `grp-${version}-${delayMs}ms-rej-${String(seq).padStart(4, '0')}`,
        asset: 'ETH',
        direction,
        long_venue: longVenue,
        short_venue: shortVenue,
        long_symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
        short_symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
        decision: 'REJECTED',
        reject_reason: reason,
        trigger_ts: tDecision,
        event_ts_left: bnPoint.book.sourceTs,
        event_ts_right: hlPoint.book.sourceTs,
        recv_ts_left: bnPoint.book.recvTs,
        recv_ts_right: hlPoint.book.recvTs,
        budget_usdt: config.budgetUsdt,
        planned_qty: config.plannedQtyEth,
        actual_filled_qty: '0',
        unit_multiplier_normalized: '1',
        long_ref_price_usdt: longRefPriceUsdt,
        planned_notional_usdt: plannedNotionalUsdt,
        denominator_rule: 'planned_notional_usdt = Q_plan * long_ref_price_in_usdt',
        fx_usdc_usdt: fxAtDecision.rate,
        fx_source: fxAtDecision.source,
        fee_source: config.fees.source,
        fee_assumption_detail: `${config.fees.binanceContract} ${config.fees.binanceTakerFeeRate}; ${config.fees.hyperliquidContract} ${config.fees.hyperliquidTakerFeeRate}`,
        exit_assumption: `Pre-trade scenario only: takeProfitBps(${config.takeProfitBps}) + exitDepthBuffer(${config.scenarioExitDepthBufferBps} bps)`,
        bbo_entry_spread_bps: evalRes.bboSpreadBps,
        vwap_entry_spread_bps: evalRes.vwapSpreadBps,
        est_exit_spread_bps: estExitBps,
        entry_long_fill: null,
        entry_short_fill: null,
        exit_long_fill: null,
        exit_short_fill: null,
        entry_spread_pnl_usd: null,
        exit_spread_pnl_usd: null,
        fees_4leg_usd: null,
        funding_events_crossed: 0,
        funding_net_usd: null,
        borrowing_cost_est_usd: null,
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
        book_gap_count: timeline.diagnostics.binanceGapCount,
        manual_intervention_count: 0,
        manual_notes: `Arrival fill failed at t+${delayMs}ms: ${reason}`,
      });
      continue;
    }

    seq += 1;
    if (!activeGroupId || lastGroupDirection !== direction) {
      groupSeq += 1;
      activeGroupId = `grp-${version}-${delayMs}ms-${String(groupSeq).padStart(4, '0')}`;
      lastGroupDirection = direction;
    }

    const rowIdx = rows.length;
    rows.push({
      run_id: runId,
      strategy_version: version,
      delay_ms: delayMs,
      delay_model: delayModel,
      opportunity_id: `${version}-${delayMs}ms-${String(seq).padStart(4, '0')}`,
      group_id: activeGroupId,
      asset: 'ETH',
      direction,
      long_venue: longVenue,
      short_venue: shortVenue,
      long_symbol: longVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
      short_symbol: shortVenue === 'BINANCE' ? 'BINANCE_FUTURE_ETH_USDT' : 'HYPERLIQUID_FUTURE_ETH_USDC',
      decision: 'TRIGGERED',
      reject_reason: null,
      trigger_ts: tDecision,
      event_ts_left: bnPoint.book.sourceTs,
      event_ts_right: hlPoint.book.sourceTs,
      recv_ts_left: bnPoint.book.recvTs,
      recv_ts_right: hlPoint.book.recvTs,
      budget_usdt: config.budgetUsdt,
      planned_qty: config.plannedQtyEth,
      actual_filled_qty: config.plannedQtyEth,
      unit_multiplier_normalized: '1',
      long_ref_price_usdt: longRefPriceUsdt,
      planned_notional_usdt: plannedNotionalUsdt,
      denominator_rule: 'planned_notional_usdt = Q_plan * long_ref_price_in_usdt',
      fx_usdc_usdt: fxAtDecision.rate,
      fx_source: fxAtDecision.source,
      fee_source: config.fees.source,
      fee_assumption_detail: `${config.fees.binanceContract} ${config.fees.binanceTakerFeeRate}; ${config.fees.hyperliquidContract} ${config.fees.hyperliquidTakerFeeRate}`,
      exit_assumption: version === 'bbo_v1'
        ? `Legacy BBO trigger without pre-trade exit buffer; closes when live exit <= ${config.takeProfitBps} bps`
        : `Pre-trade scenario only: takeProfitBps(${config.takeProfitBps}) + exitDepthBuffer(${config.scenarioExitDepthBufferBps} bps)`,
      bbo_entry_spread_bps: evalRes.bboSpreadBps,
      vwap_entry_spread_bps: execEntry.vwapSpreadBps,
      est_exit_spread_bps: estExitBps,
      entry_long_fill: execEntry.longFill,
      entry_short_fill: execEntry.shortFill,
      exit_long_fill: null,
      exit_short_fill: null,
      entry_spread_pnl_usd: new Decimal(execEntry.vwapSpreadUsd ?? '0').toString(),
      exit_spread_pnl_usd: null,
      fees_4leg_usd: null,
      funding_events_crossed: 0,
      funding_net_usd: null,
      borrowing_cost_est_usd: '0',
      roundtrip_net_pnl_usd: null,
      roundtrip_net_bps: null,
      budget_roi_pct: null,
      is_open_at_end: true,
      mark_to_close_usd: null,
      unvalued_qty: '0',
      max_naked_leg_ms: '0',
      rest_queue_wait_ms: null,
      margin_used_est_usd: new Decimal(plannedNotionalUsdt).mul('2').div(config.assumedLeverage).toDecimalPlaces(4).toString(),
      margin_used_actual_usd: null,
      book_gap_count: timeline.diagnostics.binanceGapCount,
      manual_intervention_count: 0,
      manual_notes: `Modeled simultaneous dual-taker arrival skew = 0ms under ${delayModel}; REST queue N/A offline`,
    });

    openPosition = {
      rowIndex: rowIdx,
      direction,
      entryTs: arrivalTs,
      longEntryFill: execEntry.longFill,
      shortEntryFill: execEntry.shortFill,
      plannedNotionalUsdt,
      groupId: activeGroupId,
    };
  }

  // Value any position still open at the end of the captured timeline.
  if (openPosition) {
    const targetRow = rows[openPosition.rowIndex]!;
    const finalTs = timeline.endedAtMs;
    const bnEnd = latestPointAt(timeline.binanceTimeline, finalTs);
    const hlEnd = latestPointAt(timeline.hyperliquidTimeline, finalTs);
    const fxEnd = latestFxAt(timeline.fxTimeline, finalTs);
    const funding = computeCrossedFundingUsd({
      timeline,
      direction: openPosition.direction,
      qtyEth: config.plannedQtyEth,
      longRefPriceUsdt: targetRow.long_ref_price_usdt!,
      entryTs: openPosition.entryTs,
      exitTs: finalTs,
      fxRate: fxEnd.rate,
    });
    targetRow.funding_events_crossed = funding.count;
    targetRow.funding_net_usd = funding.netUsd;

    if (isFreshValidBook(bnEnd, finalTs, config.maxBookAgeMs)
      && isFreshValidBook(hlEnd, finalTs, config.maxBookAgeMs)) {
      const endExit = evaluateExitAtBooks({
        direction: openPosition.direction,
        qtyEth: config.plannedQtyEth,
        bnBook: bnEnd.book,
        hlBook: hlEnd.book,
        fxRate: fxEnd.rate,
        fees: config.fees,
        ts: finalTs,
      });
      if (endExit.executable && endExit.longCloseFill && endExit.shortCloseFill) {
        const qty = new Decimal(config.plannedQtyEth);
        const entrySpreadPnl = qty.mul(
          new Decimal(openPosition.shortEntryFill.avgPriceUsdt).minus(openPosition.longEntryFill.avgPriceUsdt),
        );
        const exitSpreadPnl = qty.mul(
          new Decimal(endExit.shortCloseFill.avgPriceUsdt).minus(endExit.longCloseFill.avgPriceUsdt),
        ).neg();
        const fees4 = new Decimal(openPosition.longEntryFill.feeUsdt)
          .plus(openPosition.shortEntryFill.feeUsdt)
          .plus(endExit.longCloseFill.feeUsdt)
          .plus(endExit.shortCloseFill.feeUsdt);
        const mtm = entrySpreadPnl.plus(exitSpreadPnl).plus(funding.netUsd).minus(fees4);
        targetRow.exit_long_fill = endExit.longCloseFill;
        targetRow.exit_short_fill = endExit.shortCloseFill;
        targetRow.exit_spread_pnl_usd = exitSpreadPnl.toDecimalPlaces(8).toString();
        targetRow.fees_4leg_usd = fees4.toDecimalPlaces(8).toString();
        targetRow.mark_to_close_usd = mtm.toDecimalPlaces(8).toString();
        targetRow.unvalued_qty = '0';
      } else {
        targetRow.unvalued_qty = config.plannedQtyEth;
        targetRow.manual_notes += '; Final mark-to-close failed due to insufficient visible depth';
      }
    } else {
      targetRow.unvalued_qty = config.plannedQtyEth;
      targetRow.manual_notes += '; Final mark-to-close failed because final book was invalid or stale';
    }
  }

  let triggeredCount = 0;
  let rejectedCount = 0;
  let completedRoundtrips = 0;
  let openAtEndCount = 0;
  let realizedPnl = new Decimal(0);
  let markOpenPnl = new Decimal(0);
  let totalFees = new Decimal(0);
  let totalFunding = new Decimal(0);
  let totalRealizedNotional = new Decimal(0);

  for (const r of rows) {
    if (r.decision === 'REJECTED') {
      rejectedCount += 1;
      continue;
    }
    triggeredCount += 1;
    if (r.fees_4leg_usd) totalFees = totalFees.plus(r.fees_4leg_usd);
    if (r.funding_net_usd) totalFunding = totalFunding.plus(r.funding_net_usd);
    if (r.is_open_at_end) {
      openAtEndCount += 1;
      if (r.mark_to_close_usd) markOpenPnl = markOpenPnl.plus(r.mark_to_close_usd);
    } else {
      completedRoundtrips += 1;
      if (r.roundtrip_net_pnl_usd) realizedPnl = realizedPnl.plus(r.roundtrip_net_pnl_usd);
      if (r.planned_notional_usdt) totalRealizedNotional = totalRealizedNotional.plus(r.planned_notional_usdt);
    }
  }

  const realizedNetBps = totalRealizedNotional.gt(0)
    ? realizedPnl.div(totalRealizedNotional).mul(10_000).toDecimalPlaces(4).toString()
    : null;

  return {
    summary: {
      strategy_version: version,
      delay_ms: delayMs,
      total_candidates: rows.length,
      triggered_count: triggeredCount,
      rejected_count: rejectedCount,
      reject_reasons: rejectReasons,
      completed_roundtrips: completedRoundtrips,
      open_at_end_count: openAtEndCount,
      realized_roundtrip_pnl_usd: realizedPnl.toDecimalPlaces(6).toString(),
      mark_to_close_open_pnl_usd: markOpenPnl.toDecimalPlaces(6).toString(),
      total_fees_usd: totalFees.toDecimalPlaces(6).toString(),
      total_funding_net_usd: totalFunding.toDecimalPlaces(6).toString(),
      total_planned_notional_usdt: totalRealizedNotional.toDecimalPlaces(4).toString(),
      realized_net_bps: realizedNetBps,
    },
    rows,
  };
}

function buildDelayComparisonSample(
  timeline: TimelineIndex,
  config: ReplayConfig,
  rows: readonly TradeScorecardRow[],
): ReplaySuiteResult['sampleDelayComparison'] {
  const candidate = rows.find((r) => r.decision === 'TRIGGERED') ?? rows[0];
  if (!candidate) return null;
  const evalDelay = (delayMs: number): DelayExecutionComparison => {
    const arrivalTs = candidate.trigger_ts + delayMs;
    const bn = latestPointAt(timeline.binanceTimeline, arrivalTs);
    const hl = latestPointAt(timeline.hyperliquidTimeline, arrivalTs);
    const model = delayMs === 0 ? 'zero_delay_last_synced_book' : `fixed_one_way_delay_${delayMs}ms_per_leg`;
    if (!isFreshValidBook(bn, arrivalTs, config.maxBookAgeMs)
      || !isFreshValidBook(hl, arrivalTs, config.maxBookAgeMs)) {
      return {
        delayMs,
        delayModel: model,
        decisionTs: candidate.trigger_ts,
        arrivalTs,
        executable: false,
        rejectReason: 'BOOK_INVALID_AT_ARRIVAL',
        longFill: null,
        shortFill: null,
        entrySpreadBpsAtArrival: null,
        entrySpreadUsdAtArrival: null,
        entryFeesUsd: null,
      };
    }
    const fx = latestFxAt(timeline.fxTimeline, arrivalTs);
    const res = evaluateEntryAtBooks({
      direction: candidate.direction,
      qtyEth: candidate.planned_qty,
      bnBook: bn.book,
      hlBook: hl.book,
      fxRate: fx.rate,
      fees: config.fees,
      ts: arrivalTs,
    });
    return {
      delayMs,
      delayModel: model,
      decisionTs: candidate.trigger_ts,
      arrivalTs,
      executable: res.executable,
      rejectReason: res.rejectReason,
      longFill: res.longFill,
      shortFill: res.shortFill,
      entrySpreadBpsAtArrival: res.vwapSpreadBps,
      entrySpreadUsdAtArrival: res.vwapSpreadUsd,
      entryFeesUsd: res.entryFeesUsd,
    };
  };

  return {
    opportunityId: candidate.opportunity_id,
    direction: candidate.direction,
    decisionTs: candidate.trigger_ts,
    zeroMs: evalDelay(0),
    hundredMs: evalDelay(100),
  };
}

export function runPhase1Replay(
  events: readonly RecordedMarketEvent[],
  partialConfig: Partial<ReplayConfig> = {},
): ReplaySuiteResult {
  const config: ReplayConfig = {
    ...DEFAULT_REPLAY_CONFIG,
    ...partialConfig,
    fees: { ...DEFAULT_VIP0_FEES, ...partialConfig.fees },
  };
  const timeline = buildReplayTimeline(events);
  const runId = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const summaries: VariantSummary[] = [];
  const allRows: TradeScorecardRow[] = [];

  for (const version of ['bbo_v1', 'vwap_taker_v2'] as const) {
    for (const delayMs of config.delaysMs) {
      const res = simulateVariant({ runId, timeline, config, version, delayMs });
      summaries.push(res.summary);
      allRows.push(...res.rows);
    }
  }

  return {
    runId,
    generatedAtIso: new Date().toISOString(),
    config,
    catalog: timeline.sessionMeta?.catalog ?? null,
    timelineDiagnostics: {
      ...timeline.diagnostics,
      startedAtIso: new Date(timeline.startedAtMs).toISOString(),
      endedAtIso: new Date(timeline.endedAtMs).toISOString(),
      binanceChannelsUsed: timeline.sessionMeta
        ? [timeline.sessionMeta.endpoints.binanceWsUrl, timeline.sessionMeta.endpoints.binanceStreamName]
        : [],
    },
    summaries,
    rows: allRows,
    sampleDelayComparison: buildDelayComparisonSample(timeline, config, allRows),
  };
}
