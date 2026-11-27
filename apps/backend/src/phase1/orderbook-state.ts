import { Decimal } from 'decimal.js';

export type PriceLevel = readonly [price: string, quantity: string];

export interface NormalizedOrderBook {
  bids: PriceLevel[];
  asks: PriceLevel[];
  sourceTs: number;
  recvTs: number;
  connGen: number;
  depthBids: number;
  depthAsks: number;
}

export interface BinanceDepthDeltaEvent {
  connGen: number;
  recvSeq: number;
  recvTs: number;
  eventTime: number;
  transactionTime?: number;
  U: string | number | bigint;
  u: string | number | bigint;
  pu: string | number | bigint;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface BinanceDepthSnapshotInput {
  connGen: number;
  fetchedAtMs: number;
  lastUpdateId: string | number | bigint;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export type BinanceBookStatus = 'UNSYNCED' | 'BUFFERING' | 'SYNCED' | 'INVALID_GAP';

export interface BinanceBridgeProof {
  connGen: number;
  snapshotLastUpdateId: string;
  droppedPreSnapshotCount: number;
  bridgeEvent: {
    U: string;
    u: string;
    pu: string;
    recvSeq: number;
    recvTs: number;
  };
  appliedBufferedCount: number;
  bidLevels: number;
  askLevels: number;
  bestBid: string | null;
  bestAsk: string | null;
}

export type BinanceDeltaResult =
  | { kind: 'buffered'; status: BinanceBookStatus; bufferLength: number }
  | { kind: 'applied'; status: 'SYNCED'; u: string }
  | { kind: 'duplicate_ignored'; status: 'SYNCED'; u: string; lastAppliedU: string }
  | { kind: 'stale_connection_ignored'; status: BinanceBookStatus }
  | { kind: 'bridge_ready'; status: 'SYNCED'; proof: BinanceBridgeProof }
  | {
      kind: 'bridge_failed_refetch';
      status: 'BUFFERING';
      reason: 'first_delta_after_snapshot' | 'buffered_pu_gap';
      snapshotLastUpdateId: string;
      firstU: string;
      firstUFinal: string;
    }
  | {
      kind: 'sequence_gap';
      status: 'INVALID_GAP';
      expectedPu: string;
      actualPu: string;
      U: string;
      u: string;
    };

export type BinanceSnapshotResult =
  | { kind: 'stale_connection_ignored'; status: BinanceBookStatus }
  | { kind: 'waiting_for_bridge_delta'; status: 'BUFFERING'; droppedPreSnapshotCount: number }
  | { kind: 'bridge_ready'; status: 'SYNCED'; proof: BinanceBridgeProof }
  | {
      kind: 'bridge_failed_refetch';
      status: 'BUFFERING';
      reason: 'snapshot_behind_buffer' | 'buffered_pu_gap';
      snapshotLastUpdateId: string;
      detail: string;
    };

function applyLevelUpdates(book: Map<string, string>, updates: readonly PriceLevel[]): void {
  for (const [price, quantity] of updates) {
    if (new Decimal(quantity).lte(0)) {
      book.delete(price);
    } else {
      book.set(price, quantity);
    }
  }
}

function sortedLevels(book: Map<string, string>, descending: boolean): PriceLevel[] {
  return [...book.entries()].sort((left, right) => {
    const diff = new Decimal(left[0]).minus(right[0]);
    if (diff.isZero()) return 0;
    return descending ? (diff.gt(0) ? -1 : 1) : (diff.lt(0) ? -1 : 1);
  });
}

function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(String(value));
}

/**
 * Deterministic Binance USD-M local order book state machine following the official
 * buffer -> REST snapshot -> (U <= lastUpdateId <= u) bridge -> (pu === prev_u) rules.
 */
export class BinanceOrderBookStateMachine {
  private status: BinanceBookStatus = 'UNSYNCED';
  private connGen = 0;
  private buffer: BinanceDepthDeltaEvent[] = [];
  private pendingSnapshot: BinanceDepthSnapshotInput | null = null;
  private droppedSincePending = 0;
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private lastAppliedU: bigint | null = null;
  private lastSourceTs = 0;
  private lastRecvTs = 0;

  getState(): BinanceBookStatus {
    return this.status;
  }

  getConnectionGeneration(): number {
    return this.connGen;
  }

  onConnectionOpen(connGen: number): void {
    this.connGen = connGen;
    this.status = 'BUFFERING';
    this.buffer = [];
    this.pendingSnapshot = null;
    this.droppedSincePending = 0;
    this.bids.clear();
    this.asks.clear();
    this.lastAppliedU = null;
  }

  markGapResyncing(): void {
    this.status = 'BUFFERING';
    this.buffer = [];
    this.pendingSnapshot = null;
    this.droppedSincePending = 0;
    this.bids.clear();
    this.asks.clear();
    this.lastAppliedU = null;
  }

  onDepthDelta(event: BinanceDepthDeltaEvent): BinanceDeltaResult {
    if (event.connGen !== this.connGen || this.status === 'UNSYNCED') {
      return { kind: 'stale_connection_ignored', status: this.status };
    }
    if (this.status === 'INVALID_GAP') {
      return { kind: 'stale_connection_ignored', status: 'INVALID_GAP' };
    }
    if (this.status === 'BUFFERING') {
      if (this.pendingSnapshot) {
        const snapId = toBigInt(this.pendingSnapshot.lastUpdateId);
        const u = toBigInt(event.u);
        const U = toBigInt(event.U);
        if (u < snapId) {
          this.droppedSincePending += 1;
          return { kind: 'buffered', status: 'BUFFERING', bufferLength: this.buffer.length };
        }
        if (U > snapId) {
          this.pendingSnapshot = null;
          this.buffer.push(event);
          return {
            kind: 'bridge_failed_refetch',
            status: 'BUFFERING',
            reason: 'first_delta_after_snapshot',
            snapshotLastUpdateId: snapId.toString(),
            firstU: U.toString(),
            firstUFinal: u.toString(),
          };
        }
        this.buffer.push(event);
        const snapshot = this.pendingSnapshot;
        const dropped = this.droppedSincePending;
        this.pendingSnapshot = null;
        this.droppedSincePending = 0;
        const result = this.tryBridgeWithSnapshot(snapshot, dropped);
        if (result.kind === 'bridge_ready') {
          return { kind: 'bridge_ready', status: 'SYNCED', proof: result.proof };
        }
        if (result.kind === 'bridge_failed_refetch') {
          return {
            kind: 'bridge_failed_refetch',
            status: 'BUFFERING',
            reason: result.reason === 'snapshot_behind_buffer' ? 'first_delta_after_snapshot' : 'buffered_pu_gap',
            snapshotLastUpdateId: snapshot ? toBigInt(snapshot.lastUpdateId).toString() : snapId.toString(),
            firstU: U.toString(),
            firstUFinal: u.toString(),
          };
        }
        return { kind: 'buffered', status: 'BUFFERING', bufferLength: this.buffer.length };
      }
      this.buffer.push(event);
      return { kind: 'buffered', status: 'BUFFERING', bufferLength: this.buffer.length };
    }

    const u = toBigInt(event.u);
    const U = toBigInt(event.U);
    const pu = toBigInt(event.pu);
    const expectedPu = this.lastAppliedU;
    if (expectedPu === null) {
      this.status = 'INVALID_GAP';
      return {
        kind: 'sequence_gap',
        status: 'INVALID_GAP',
        expectedPu: 'none',
        actualPu: pu.toString(),
        U: U.toString(),
        u: u.toString(),
      };
    }
    if (u <= expectedPu) {
      return {
        kind: 'duplicate_ignored',
        status: 'SYNCED',
        u: u.toString(),
        lastAppliedU: expectedPu.toString(),
      };
    }
    if (pu !== expectedPu) {
      this.status = 'INVALID_GAP';
      this.bids.clear();
      this.asks.clear();
      return {
        kind: 'sequence_gap',
        status: 'INVALID_GAP',
        expectedPu: expectedPu.toString(),
        actualPu: pu.toString(),
        U: U.toString(),
        u: u.toString(),
      };
    }

    applyLevelUpdates(this.bids, event.bids);
    applyLevelUpdates(this.asks, event.asks);
    this.lastAppliedU = u;
    this.lastSourceTs = event.eventTime;
    this.lastRecvTs = event.recvTs;
    return { kind: 'applied', status: 'SYNCED', u: u.toString() };
  }

  onRestSnapshot(snapshot: BinanceDepthSnapshotInput): BinanceSnapshotResult {
    if (snapshot.connGen !== this.connGen || this.status !== 'BUFFERING') {
      return { kind: 'stale_connection_ignored', status: this.status };
    }
    return this.tryBridgeWithSnapshot(snapshot, 0);
  }

  private tryBridgeWithSnapshot(
    snapshot: BinanceDepthSnapshotInput,
    priorDropped: number,
  ): BinanceSnapshotResult {
    const snapId = toBigInt(snapshot.lastUpdateId);
    const kept: BinanceDepthDeltaEvent[] = [];
    let dropped = priorDropped;
    for (const event of this.buffer) {
      if (toBigInt(event.u) < snapId) {
        dropped += 1;
      } else {
        kept.push(event);
      }
    }
    this.buffer = kept;

    if (kept.length === 0) {
      this.pendingSnapshot = snapshot;
      this.droppedSincePending = dropped;
      return {
        kind: 'waiting_for_bridge_delta',
        status: 'BUFFERING',
        droppedPreSnapshotCount: dropped,
      };
    }

    const first = kept[0]!;
    const firstU = toBigInt(first.U);
    const firstEndU = toBigInt(first.u);
    if (firstU > snapId) {
      this.pendingSnapshot = null;
      this.droppedSincePending = 0;
      return {
        kind: 'bridge_failed_refetch',
        status: 'BUFFERING',
        reason: 'snapshot_behind_buffer',
        snapshotLastUpdateId: snapId.toString(),
        detail: `first buffered delta starts at U=${firstU.toString()} > lastUpdateId=${snapId.toString()}`,
      };
    }

    // Valid first bridging event: U <= lastUpdateId && u >= lastUpdateId.
    const nextBids = new Map<string, string>();
    const nextAsks = new Map<string, string>();
    applyLevelUpdates(nextBids, snapshot.bids);
    applyLevelUpdates(nextAsks, snapshot.asks);

    applyLevelUpdates(nextBids, first.bids);
    applyLevelUpdates(nextAsks, first.asks);
    let appliedU = firstEndU;
    let appliedCount = 1;
    let lastEvent = first;

    for (let index = 1; index < kept.length; index += 1) {
      const event = kept[index]!;
      const evU = toBigInt(event.u);
      const evPu = toBigInt(event.pu);
      if (evU <= appliedU) continue;
      if (evPu !== appliedU) {
        this.pendingSnapshot = null;
        this.buffer = [];
        return {
          kind: 'bridge_failed_refetch',
          status: 'BUFFERING',
          reason: 'buffered_pu_gap',
          snapshotLastUpdateId: snapId.toString(),
          detail: `buffered pu=${evPu.toString()} != prev u=${appliedU.toString()}`,
        };
      }
      applyLevelUpdates(nextBids, event.bids);
      applyLevelUpdates(nextAsks, event.asks);
      appliedU = evU;
      appliedCount += 1;
      lastEvent = event;
    }

    this.bids = nextBids;
    this.asks = nextAsks;
    this.lastAppliedU = appliedU;
    this.lastSourceTs = lastEvent.eventTime;
    this.lastRecvTs = lastEvent.recvTs;
    this.status = 'SYNCED';
    this.buffer = [];
    this.pendingSnapshot = null;
    this.droppedSincePending = 0;

    const sortedBids = sortedLevels(this.bids, true);
    const sortedAsks = sortedLevels(this.asks, false);
    return {
      kind: 'bridge_ready',
      status: 'SYNCED',
      proof: {
        connGen: this.connGen,
        snapshotLastUpdateId: snapId.toString(),
        droppedPreSnapshotCount: dropped,
        bridgeEvent: {
          U: firstU.toString(),
          u: firstEndU.toString(),
          pu: toBigInt(first.pu).toString(),
          recvSeq: first.recvSeq,
          recvTs: first.recvTs,
        },
        appliedBufferedCount: appliedCount,
        bidLevels: sortedBids.length,
        askLevels: sortedAsks.length,
        bestBid: sortedBids[0]?.[0] ?? null,
        bestAsk: sortedAsks[0]?.[0] ?? null,
      },
    };
  }

  snapshot(): NormalizedOrderBook | null {
    if (this.status !== 'SYNCED') return null;
    const bids = sortedLevels(this.bids, true);
    const asks = sortedLevels(this.asks, false);
    return {
      bids,
      asks,
      sourceTs: this.lastSourceTs,
      recvTs: this.lastRecvTs,
      connGen: this.connGen,
      depthBids: bids.length,
      depthAsks: asks.length,
    };
  }
}

export interface HyperliquidL2SnapshotInput {
  connGen: number;
  sourceTs: number;
  recvTs: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export type HyperliquidBookStatus = 'WAITING_SNAPSHOT' | 'SYNCED';

export type HyperliquidSnapshotResult =
  | { kind: 'stale_connection_ignored'; status: HyperliquidBookStatus }
  | { kind: 'stale_backward_ignored'; status: HyperliquidBookStatus; sourceTs: number; lastSourceTs: number }
  | { kind: 'duplicate_timestamp_ignored'; status: 'SYNCED'; sourceTs: number }
  | {
      kind: 'applied';
      status: 'SYNCED';
      firstForConnection: boolean;
      book: NormalizedOrderBook;
    };

/**
 * Deterministic Hyperliquid L2 order book state machine. Each valid snapshot replaces
 * the full visible book (preserving exact level count without extrapolating past depth).
 */
export class HyperliquidOrderBookStateMachine {
  private status: HyperliquidBookStatus = 'WAITING_SNAPSHOT';
  private connGen = 0;
  private lastSourceTs = 0;
  private currentBook: NormalizedOrderBook | null = null;
  private appliedInCurrentConn = 0;

  getState(): HyperliquidBookStatus {
    return this.status;
  }

  getConnectionGeneration(): number {
    return this.connGen;
  }

  onConnectionOpen(connGen: number): void {
    this.connGen = connGen;
    this.status = 'WAITING_SNAPSHOT';
    this.lastSourceTs = 0;
    this.currentBook = null;
    this.appliedInCurrentConn = 0;
  }

  onSnapshot(input: HyperliquidL2SnapshotInput): HyperliquidSnapshotResult {
    if (input.connGen !== this.connGen) {
      return { kind: 'stale_connection_ignored', status: this.status };
    }
    if (this.appliedInCurrentConn > 0) {
      if (input.sourceTs < this.lastSourceTs) {
        return {
          kind: 'stale_backward_ignored',
          status: this.status,
          sourceTs: input.sourceTs,
          lastSourceTs: this.lastSourceTs,
        };
      }
      if (input.sourceTs === this.lastSourceTs) {
        return {
          kind: 'duplicate_timestamp_ignored',
          status: 'SYNCED',
          sourceTs: input.sourceTs,
        };
      }
    }

    const bids = [...input.bids].sort((a, b) => new Decimal(b[0]).minus(a[0]).toNumber());
    const asks = [...input.asks].sort((a, b) => new Decimal(a[0]).minus(b[0]).toNumber());
    const firstForConnection = this.appliedInCurrentConn === 0;
    this.appliedInCurrentConn += 1;
    this.lastSourceTs = input.sourceTs;
    this.status = 'SYNCED';
    this.currentBook = {
      bids,
      asks,
      sourceTs: input.sourceTs,
      recvTs: input.recvTs,
      connGen: input.connGen,
      depthBids: bids.length,
      depthAsks: asks.length,
    };
    return {
      kind: 'applied',
      status: 'SYNCED',
      firstForConnection,
      book: this.currentBook,
    };
  }

  snapshot(): NormalizedOrderBook | null {
    return this.status === 'SYNCED' ? this.currentBook : null;
  }
}

export type DepthWalkResult =
  | {
      fillable: true;
      qty: string;
      vwapPrice: string;
      worstPrice: string;
      notionalQuote: string;
      levelsUsed: number;
    }
  | {
      fillable: false;
      requestedQty: string;
      maxAvailableQty: string;
      visibleLevels: number;
    };

/**
 * Walk visible price levels strictly without extrapolating beyond the final visible tier.
 */
export function walkOrderBookDepth(levels: readonly PriceLevel[], requestedQty: string): DepthWalkResult {
  const target = new Decimal(requestedQty);
  if (!target.isFinite() || target.lte(0)) {
    return { fillable: false, requestedQty, maxAvailableQty: '0', visibleLevels: levels.length };
  }
  let remaining = target;
  let totalCost = new Decimal(0);
  let filled = new Decimal(0);
  let worstPrice = new Decimal(0);
  let levelsUsed = 0;

  for (const [rawPrice, rawSize] of levels) {
    const price = new Decimal(rawPrice);
    const size = new Decimal(rawSize);
    if (!price.gt(0) || !size.gt(0)) continue;
    const take = Decimal.min(remaining, size);
    totalCost = totalCost.plus(take.mul(price));
    filled = filled.plus(take);
    worstPrice = price;
    levelsUsed += 1;
    remaining = remaining.minus(take);
    if (remaining.lte('1e-12')) {
      return {
        fillable: true,
        qty: target.toString(),
        vwapPrice: totalCost.div(target).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString(),
        worstPrice: worstPrice.toString(),
        notionalQuote: totalCost.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString(),
        levelsUsed,
      };
    }
  }

  return {
    fillable: false,
    requestedQty: target.toString(),
    maxAvailableQty: filled.toString(),
    visibleLevels: levels.length,
  };
}
