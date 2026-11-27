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

export interface OrderBookView {
  bestBid: PriceLevel | null;
  bestAsk: PriceLevel | null;
  sourceTs: number;
  recvTs: number;
  connGen: number;
  depthBids: number;
  depthAsks: number;
  walkBids(qty: string): DepthWalkResult;
  walkAsks(qty: string): DepthWalkResult;
  snapshot(): NormalizedOrderBook;
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
  | { kind: 'buffered'; status: BinanceBookStatus; bufferLength: number; overflowDropped: boolean }
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

interface SortedEntry {
  priceNum: number;
  price: string;
  qty: string;
}

function compareSidePrices(
  aNum: number,
  aStr: string,
  bNum: number,
  bStr: string,
  descending: boolean,
): number {
  if (aNum !== bNum) {
    return descending ? (aNum > bNum ? -1 : 1) : (aNum < bNum ? -1 : 1);
  }
  if (aStr === bStr) return 0;
  const cmp = new Decimal(aStr).cmp(bStr);
  return descending ? -cmp : cmp;
}

/**
 * Incrementally maintained sorted single-side book (`bids` desc or `asks` asc).
 * Price-level mutations are O(log N) binary searches instead of full O(N log N)
 * re-sorts, enabling million-event offline replays in constant low memory.
 */
export class SortedBookSide {
  private readonly levels = new Map<string, string>();
  private entries: SortedEntry[] = [];

  constructor(private readonly descending: boolean) {}

  clear(): void {
    this.levels.clear();
    this.entries = [];
  }

  clone(): SortedBookSide {
    const copy = new SortedBookSide(this.descending);
    for (const [k, v] of this.levels) copy.levels.set(k, v);
    copy.entries = this.entries.map((entry) => ({ ...entry }));
    return copy;
  }

  size(): number {
    return this.entries.length;
  }

  best(): PriceLevel | null {
    const first = this.entries[0];
    return first ? [first.price, first.qty] : null;
  }

  loadSnapshot(updates: readonly PriceLevel[]): void {
    this.levels.clear();
    const next: SortedEntry[] = [];
    for (const [price, qty] of updates) {
      const qNum = Number(qty);
      if (qty === '0' || (Number.isFinite(qNum) ? qNum <= 0 : new Decimal(qty).lte(0))) continue;
      if (!this.levels.has(price)) {
        next.push({ priceNum: Number(price), price, qty });
      }
      this.levels.set(price, qty);
    }
    // Deduplicate if overwritten in same snapshot array.
    const dedup = next.length === this.levels.size
      ? next
      : [...this.levels.entries()].map(([price, qty]) => ({ priceNum: Number(price), price, qty }));
    dedup.sort((a, b) => compareSidePrices(a.priceNum, a.price, b.priceNum, b.price, this.descending));
    this.entries = dedup;
  }

  apply(updates: readonly PriceLevel[]): void {
    for (const [price, qty] of updates) {
      const qNum = Number(qty);
      const isRemoval = qty === '0' || (Number.isFinite(qNum) ? qNum <= 0 : new Decimal(qty).lte(0));
      const priceNum = Number(price);

      if (isRemoval) {
        if (!this.levels.delete(price)) continue;
        const idx = this.findIndex(priceNum, price);
        if (idx >= 0) this.entries.splice(idx, 1);
        continue;
      }

      const existed = this.levels.has(price);
      this.levels.set(price, qty);
      if (existed) {
        const idx = this.findIndex(priceNum, price);
        if (idx >= 0) {
          this.entries[idx]!.qty = qty;
          continue;
        }
      }
      const insertAt = this.findInsertionIndex(priceNum, price);
      this.entries.splice(insertAt, 0, { priceNum, price, qty });
    }
  }

  toPriceLevels(): PriceLevel[] {
    return this.entries.map((entry) => [entry.price, entry.qty] as const);
  }

  walkDepth(requestedQty: string): DepthWalkResult {
    const reqNum = Number(requestedQty);
    if (this.entries.length > 0 && Number.isFinite(reqNum) && reqNum > 0) {
      const first = this.entries[0]!;
      const firstQtyNum = Number(first.qty);
      if (Number.isFinite(firstQtyNum) && firstQtyNum >= reqNum + 1e-12 && Number(first.price) > 0) {
        const target = new Decimal(requestedQty);
        const dotIdx = first.price.indexOf('.');
        const vwapPrice = dotIdx >= 0 && first.price.length - dotIdx - 1 > 8
          ? new Decimal(first.price).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString()
          : first.price;
        return {
          fillable: true,
          qty: target.toString(),
          vwapPrice,
          worstPrice: first.price,
          notionalQuote: target.mul(first.price).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString(),
          levelsUsed: 1,
        };
      }
    }

    const target = new Decimal(requestedQty);
    if (!target.isFinite() || target.lte(0)) {
      return { fillable: false, requestedQty, maxAvailableQty: '0', visibleLevels: this.entries.length };
    }
    let remaining = target;
    let totalCost = new Decimal(0);
    let filled = new Decimal(0);
    let worstPrice = new Decimal(0);
    let levelsUsed = 0;

    for (const entry of this.entries) {
      const price = new Decimal(entry.price);
      const size = new Decimal(entry.qty);
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
      visibleLevels: this.entries.length,
    };
  }

  private findIndex(priceNum: number, priceStr: string): number {
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cur = this.entries[mid]!;
      const cmp = compareSidePrices(cur.priceNum, cur.price, priceNum, priceStr, this.descending);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private findInsertionIndex(priceNum: number, priceStr: string): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const cur = this.entries[mid]!;
      const cmp = compareSidePrices(cur.priceNum, cur.price, priceNum, priceStr, this.descending);
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(String(value));
}

export interface BinanceBookCheckpoint {
  status: BinanceBookStatus;
  connGen: number;
  lastAppliedU: string | null;
  lastSourceTs: number;
  lastRecvTs: number;
  droppedOverflowCount: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
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
  private droppedOverflowCount = 0;
  private bids = new SortedBookSide(true);
  private asks = new SortedBookSide(false);
  private lastAppliedU: bigint | null = null;
  private lastSourceTs = 0;
  private lastRecvTs = 0;

  constructor(private readonly maxBufferLength = 5_000) {}

  getState(): BinanceBookStatus {
    return this.status;
  }

  getConnectionGeneration(): number {
    return this.connGen;
  }

  getDiagnostics(): {
    status: BinanceBookStatus;
    connGen: number;
    bufferLength: number;
    droppedOverflowCount: number;
    lastAppliedU: string | null;
  } {
    return {
      status: this.status,
      connGen: this.connGen,
      bufferLength: this.buffer.length,
      droppedOverflowCount: this.droppedOverflowCount,
      lastAppliedU: this.lastAppliedU === null ? null : this.lastAppliedU.toString(),
    };
  }

  exportCheckpoint(): BinanceBookCheckpoint {
    return {
      status: this.status,
      connGen: this.connGen,
      lastAppliedU: this.lastAppliedU === null ? null : this.lastAppliedU.toString(),
      lastSourceTs: this.lastSourceTs,
      lastRecvTs: this.lastRecvTs,
      droppedOverflowCount: this.droppedOverflowCount,
      bids: this.status === 'SYNCED' ? this.bids.toPriceLevels() : [],
      asks: this.status === 'SYNCED' ? this.asks.toPriceLevels() : [],
    };
  }

  restoreCheckpoint(cp: BinanceBookCheckpoint): void {
    this.status = cp.status;
    this.connGen = cp.connGen;
    this.lastAppliedU = cp.lastAppliedU === null ? null : BigInt(cp.lastAppliedU);
    this.lastSourceTs = cp.lastSourceTs;
    this.lastRecvTs = cp.lastRecvTs;
    this.droppedOverflowCount = cp.droppedOverflowCount;
    this.buffer = [];
    this.pendingSnapshot = null;
    this.droppedSincePending = 0;
    this.bids.loadSnapshot(cp.bids);
    this.asks.loadSnapshot(cp.asks);
  }

  private pushBufferedDelta(event: BinanceDepthDeltaEvent): boolean {
    let overflowed = false;
    while (this.buffer.length >= this.maxBufferLength) {
      this.buffer.shift();
      this.droppedOverflowCount += 1;
      overflowed = true;
    }
    this.buffer.push(event);
    return overflowed;
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
          return { kind: 'buffered', status: 'BUFFERING', bufferLength: this.buffer.length, overflowDropped: false };
        }
        if (U > snapId) {
          this.pendingSnapshot = null;
          this.pushBufferedDelta(event);
          return {
            kind: 'bridge_failed_refetch',
            status: 'BUFFERING',
            reason: 'first_delta_after_snapshot',
            snapshotLastUpdateId: snapId.toString(),
            firstU: U.toString(),
            firstUFinal: u.toString(),
          };
        }
        const overflowed = this.pushBufferedDelta(event);
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
            snapshotLastUpdateId: toBigInt(snapshot.lastUpdateId).toString(),
            firstU: U.toString(),
            firstUFinal: u.toString(),
          };
        }
        return { kind: 'buffered', status: 'BUFFERING', bufferLength: this.buffer.length, overflowDropped: overflowed };
      }
      const overflowed = this.pushBufferedDelta(event);
      return { kind: 'buffered', status: 'BUFFERING', bufferLength: this.buffer.length, overflowDropped: overflowed };
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

    this.bids.apply(event.bids);
    this.asks.apply(event.asks);
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

    const nextBids = new SortedBookSide(true);
    const nextAsks = new SortedBookSide(false);
    nextBids.loadSnapshot(snapshot.bids);
    nextAsks.loadSnapshot(snapshot.asks);

    nextBids.apply(first.bids);
    nextAsks.apply(first.asks);
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
      nextBids.apply(event.bids);
      nextAsks.apply(event.asks);
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
        bidLevels: this.bids.size(),
        askLevels: this.asks.size(),
        bestBid: this.bids.best()?.[0] ?? null,
        bestAsk: this.asks.best()?.[0] ?? null,
      },
    };
  }

  view(): OrderBookView | null {
    if (this.status !== 'SYNCED') return null;
    const bids = this.bids;
    const asks = this.asks;
    const sourceTs = this.lastSourceTs;
    const recvTs = this.lastRecvTs;
    const connGen = this.connGen;
    return {
      bestBid: bids.best(),
      bestAsk: asks.best(),
      sourceTs,
      recvTs,
      connGen,
      depthBids: bids.size(),
      depthAsks: asks.size(),
      walkBids: (qty) => bids.walkDepth(qty),
      walkAsks: (qty) => asks.walkDepth(qty),
      snapshot: () => ({
        bids: bids.toPriceLevels(),
        asks: asks.toPriceLevels(),
        sourceTs,
        recvTs,
        connGen,
        depthBids: bids.size(),
        depthAsks: asks.size(),
      }),
    };
  }

  snapshot(): NormalizedOrderBook | null {
    return this.view()?.snapshot() ?? null;
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

export interface HyperliquidBookCheckpoint {
  status: HyperliquidBookStatus;
  connGen: number;
  lastSourceTs: number;
  appliedInCurrentConn: number;
  book: NormalizedOrderBook | null;
}

/**
 * Deterministic Hyperliquid L2 order book state machine. Each valid snapshot replaces
 * the full visible book (preserving exact level count without extrapolating past depth).
 */
export class HyperliquidOrderBookStateMachine {
  private status: HyperliquidBookStatus = 'WAITING_SNAPSHOT';
  private connGen = 0;
  private lastSourceTs = 0;
  private bids = new SortedBookSide(true);
  private asks = new SortedBookSide(false);
  private currentBook: NormalizedOrderBook | null = null;
  private appliedInCurrentConn = 0;

  getState(): HyperliquidBookStatus {
    return this.status;
  }

  getConnectionGeneration(): number {
    return this.connGen;
  }

  exportCheckpoint(): HyperliquidBookCheckpoint {
    return {
      status: this.status,
      connGen: this.connGen,
      lastSourceTs: this.lastSourceTs,
      appliedInCurrentConn: this.appliedInCurrentConn,
      book: this.currentBook ? { ...this.currentBook } : null,
    };
  }

  restoreCheckpoint(cp: HyperliquidBookCheckpoint): void {
    this.status = cp.status;
    this.connGen = cp.connGen;
    this.lastSourceTs = cp.lastSourceTs;
    this.appliedInCurrentConn = cp.appliedInCurrentConn;
    this.currentBook = cp.book;
    if (cp.book) {
      this.bids.loadSnapshot(cp.book.bids);
      this.asks.loadSnapshot(cp.book.asks);
    } else {
      this.bids.clear();
      this.asks.clear();
    }
  }

  onConnectionOpen(connGen: number): void {
    this.connGen = connGen;
    this.status = 'WAITING_SNAPSHOT';
    this.lastSourceTs = 0;
    this.bids.clear();
    this.asks.clear();
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

    this.bids.loadSnapshot(input.bids);
    this.asks.loadSnapshot(input.asks);
    const bids = this.bids.toPriceLevels();
    const asks = this.asks.toPriceLevels();
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

  view(): OrderBookView | null {
    if (this.status !== 'SYNCED' || !this.currentBook) return null;
    const book = this.currentBook;
    const bids = this.bids;
    const asks = this.asks;
    return {
      bestBid: bids.best(),
      bestAsk: asks.best(),
      sourceTs: book.sourceTs,
      recvTs: book.recvTs,
      connGen: book.connGen,
      depthBids: book.depthBids,
      depthAsks: book.depthAsks,
      walkBids: (qty) => bids.walkDepth(qty),
      walkAsks: (qty) => asks.walkDepth(qty),
      snapshot: () => book,
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
