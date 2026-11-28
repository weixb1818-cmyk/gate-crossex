import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BinanceOrderBookStateMachine,
  HyperliquidOrderBookStateMachine,
  SortedBookSide,
  canonicalPriceKey,
  walkOrderBookDepth,
} from './orderbook-state.js';
import { stripProcessProxyEnv } from './proxy-free.js';
import { Phase1MarketRecorder } from './recorder.js';
import {
  StreamingReplayRunner,
  evaluateBookValidity,
  runPhase1Replay,
  runPhase1ReplayStream,
} from './replay.js';
import type { RecordedMarketEvent } from './types.js';

describe('Phase 1 proxy stripping', () => {
  it('removes proxy keys locally and sets NO_PROXY=*', () => {
    const mockEnv: NodeJS.ProcessEnv = {
      http_proxy: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7891',
      PATH: '/usr/bin',
    };
    const report = stripProcessProxyEnv(mockEnv);
    expect(report.removedKeys).toEqual(['http_proxy', 'HTTPS_PROXY', 'ALL_PROXY']);
    expect(mockEnv.http_proxy).toBeUndefined();
    expect(mockEnv.HTTPS_PROXY).toBeUndefined();
    expect(mockEnv.ALL_PROXY).toBeUndefined();
    expect(mockEnv.NO_PROXY).toBe('*');
    expect(mockEnv.PATH).toBe('/usr/bin');
  });
});

describe('BinanceOrderBookStateMachine', () => {
  it('buffers pre-snapshot deltas, drops u < lastUpdateId, bridges on U <= lastUpdateId <= u, and detects pu gaps', () => {
    const machine = new BinanceOrderBookStateMachine();
    machine.onConnectionOpen(1);
    expect(machine.getState()).toBe('BUFFERING');

    // Delta strictly before snapshot -> will be dropped.
    expect(machine.onDepthDelta({
      connGen: 1,
      recvSeq: 1,
      recvTs: 1000,
      eventTime: 999,
      U: '90',
      u: '99',
      pu: '89',
      bids: [['1700.00', '5']],
      asks: [['1701.00', '5']],
    }).kind).toBe('buffered');

    // Bridging delta covering lastUpdateId=105.
    expect(machine.onDepthDelta({
      connGen: 1,
      recvSeq: 2,
      recvTs: 1010,
      eventTime: 1009,
      U: '100',
      u: '110',
      pu: '99',
      bids: [['1700.10', '2']],
      asks: [],
    }).kind).toBe('buffered');

    const snapRes = machine.onRestSnapshot({
      connGen: 1,
      fetchedAtMs: 1020,
      lastUpdateId: '105',
      bids: [['1700.00', '1'], ['1699.00', '4']],
      asks: [['1700.50', '3']],
    });
    expect(snapRes.kind).toBe('bridge_ready');
    if (snapRes.kind === 'bridge_ready') {
      expect(snapRes.proof.droppedPreSnapshotCount).toBe(1);
      expect(snapRes.proof.bridgeEvent.U).toBe('100');
      expect(snapRes.proof.bridgeEvent.u).toBe('110');
      expect(snapRes.proof.bestBid).toBe('1700.10');
    }

    // Duplicate frame (u <= 110) must be ignored safely without breaking SYNCED state.
    const dupRes = machine.onDepthDelta({
      connGen: 1,
      recvSeq: 3,
      recvTs: 1030,
      eventTime: 1009,
      U: '100',
      u: '110',
      pu: '99',
      bids: [['1700.10', '999']],
      asks: [],
    });
    expect(dupRes.kind).toBe('duplicate_ignored');
    expect(machine.snapshot()?.bids[0]).toEqual(['1700.10', '2']);

    // Next sequential frame (pu === 110) applies cleanly.
    const okRes = machine.onDepthDelta({
      connGen: 1,
      recvSeq: 4,
      recvTs: 1100,
      eventTime: 1099,
      U: '115',
      u: '120',
      pu: '110',
      bids: [['1700.10', '0']],
      asks: [],
    });
    expect(okRes.kind).toBe('applied');
    expect(machine.snapshot()?.bids[0]).toEqual(['1700.00', '1']);

    // Sequence gap (pu !== 120) must invalidate book immediately.
    const gapRes = machine.onDepthDelta({
      connGen: 1,
      recvSeq: 5,
      recvTs: 1200,
      eventTime: 1199,
      U: '125',
      u: '130',
      pu: '121',
      bids: [['1705.00', '10']],
      asks: [],
    });
    expect(gapRes.kind).toBe('sequence_gap');
    expect(machine.getState()).toBe('INVALID_GAP');
    expect(machine.snapshot()).toBeNull();
  });

  it('requests refetch when snapshot lags behind buffered events and ignores old connection generations after reconnect', () => {
    const machine = new BinanceOrderBookStateMachine();
    machine.onConnectionOpen(1);
    machine.onDepthDelta({
      connGen: 1,
      recvSeq: 1,
      recvTs: 1000,
      eventTime: 999,
      U: '200',
      u: '210',
      pu: '199',
      bids: [['1700', '1']],
      asks: [['1701', '1']],
    });
    const staleSnap = machine.onRestSnapshot({
      connGen: 1,
      fetchedAtMs: 1010,
      lastUpdateId: '150',
      bids: [['1700', '1']],
      asks: [['1701', '1']],
    });
    expect(staleSnap.kind).toBe('bridge_failed_refetch');

    // Reconnect increments connGen; connGen=1 messages must be ignored.
    machine.onConnectionOpen(2);
    expect(machine.onRestSnapshot({
      connGen: 1,
      fetchedAtMs: 1020,
      lastUpdateId: '205',
      bids: [['1700', '1']],
      asks: [['1701', '1']],
    }).kind).toBe('stale_connection_ignored');
  });
});

describe('HyperliquidOrderBookStateMachine & depth walker', () => {
  it('waits for first snapshot on reconnect, rejects backward source timestamps, and never extrapolates past visible depth', () => {
    const machine = new HyperliquidOrderBookStateMachine();
    machine.onConnectionOpen(1);
    expect(machine.snapshot()).toBeNull();

    const first = machine.onSnapshot({
      connGen: 1,
      sourceTs: 2000,
      recvTs: 2100,
      bids: [['1701.0', '0.3']],
      asks: [['1701.1', '0.4']],
    });
    expect(first.kind).toBe('applied');
    if (first.kind === 'applied') expect(first.firstForConnection).toBe(true);

    // Out-of-order older sourceTs must be rejected.
    const stale = machine.onSnapshot({
      connGen: 1,
      sourceTs: 1500,
      recvTs: 2200,
      bids: [['1600.0', '10']],
      asks: [['1600.1', '10']],
    });
    expect(stale.kind).toBe('stale_backward_ignored');
    expect(machine.snapshot()?.bids[0]).toEqual(['1701.0', '0.3']);

    // Depth walk beyond 0.4 visible liquidity must fail without extrapolation.
    const shallow = walkOrderBookDepth(machine.snapshot()!.asks, '0.5');
    expect(shallow).toEqual({
      fillable: false,
      requestedQty: '0.5',
      maxAvailableQty: '0.4',
      visibleLevels: 1,
    });

    // Reconnect resets to WAITING_SNAPSHOT until first valid snapshot of connGen=2 arrives.
    machine.onConnectionOpen(2);
    expect(machine.getState()).toBe('WAITING_SNAPSHOT');
    expect(machine.snapshot()).toBeNull();
    const afterReconnect = machine.onSnapshot({
      connGen: 2,
      sourceTs: 2500,
      recvTs: 2600,
      bids: [['1702.0', '1.0']],
      asks: [['1702.1', '1.0']],
    });
    expect(afterReconnect.kind).toBe('applied');
    if (afterReconnect.kind === 'applied') expect(afterReconnect.firstForConnection).toBe(true);
  });
});

describe('Phase 1 offline replay engine', () => {
  it('separates bbo_v1 vs vwap_taker_v2, detects 0ms vs 100ms gap failure, settles funding, and leaves REST queue null', () => {
    const events: RecordedMarketEvent[] = [
      {
        type: 'fx_rate',
        recvSeq: 1,
        recvTs: 900,
        pair: 'USDC_USDT',
        rate: '1',
        source: 'parity_fallback',
      },
      {
        type: 'conn_event',
        venue: 'BINANCE',
        connGen: 1,
        recvSeq: 2,
        recvTs: 1000,
        status: 'open',
        url: 'wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms',
      },
      {
        type: 'conn_event',
        venue: 'HYPERLIQUID',
        connGen: 1,
        recvSeq: 3,
        recvTs: 1001,
        status: 'open',
        url: 'wss://api.hyperliquid.xyz/ws',
      },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 4,
        recvTs: 1010,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1005,
        U: '100',
        u: '110',
        pu: '99',
        bids: [['1700.00', '5']],
        // Top ask has only 0.1 ETH at 1700.10, remaining 0.4 ETH sits much worse at 1705.00!
        asks: [['1700.10', '0.1'], ['1705.00', '5']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 1,
        recvSeq: 5,
        recvTs: 1020,
        lastUpdateId: '105',
        bids: [['1700.00', '5']],
        asks: [['1700.10', '0.1'], ['1705.00', '5']],
      },
      // HL top bid is 1701.00 (looks like +5.29 bps BBO over BN 1700.10!),
      // so bbo_v1 triggers while VWAP avg buy on BN for 0.5 ETH is ~1704.02 (vwap_taker_v2 rejects!).
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 6,
        recvTs: 1030,
        sourceTs: 1025,
        coin: 'ETH',
        bidLevels: 2,
        askLevels: 1,
        bids: [['1701.00', '0.1'], ['1700.80', '5']],
        asks: [['1701.20', '5']],
      },
      // At t=1080 (inside +100ms arrival window of t=1030!), Binance hits a sequence gap!
      // Therefore at 0ms BN is valid, while at 100ms arrival (t=1130) BN is INVALID_GAP.
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 7,
        recvTs: 1080,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1078,
        U: '150',
        u: '160',
        pu: '111',
        bids: [],
        asks: [],
      },
      // Reconnect & recover cleanly at t=2000 with tight profitable spread for vwap_taker_v2 (+35 bps).
      {
        type: 'conn_event',
        venue: 'BINANCE',
        connGen: 2,
        recvSeq: 8,
        recvTs: 2000,
        status: 'open',
        url: 'wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms',
      },
      {
        type: 'bn_depth_delta',
        connGen: 2,
        recvSeq: 9,
        recvTs: 2010,
        stream: 'ethusdt@depth@100ms',
        eventTime: 2008,
        U: '200',
        u: '210',
        pu: '199',
        bids: [['1699.90', '5']],
        asks: [['1700.00', '5']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 2,
        recvSeq: 10,
        recvTs: 2020,
        lastUpdateId: '205',
        bids: [['1699.90', '5']],
        asks: [['1700.00', '5']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 11,
        recvTs: 2030,
        sourceTs: 2025,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1706.00', '5']],
        asks: [['1706.20', '5']],
      },
      // Crossed funding settlement at t=2500 (short HL receives +0.0001, long BN receives -0.00005).
      {
        type: 'funding_settled',
        venue: 'HYPERLIQUID',
        recvSeq: 12,
        recvTs: 2505,
        source: 'hl_funding_history_api',
        symbol: 'ETH',
        settlementTime: 2500,
        isHistoricalBackfill: false,
        fundingRate: '0.0001',
        markPrice: null,
        premium: '0',
        nearestOraclePriceUsdc: '1703',
        nearestOraclePriceTs: 2505,
        nearestFxUsdcUsdt: '1',
        nearestFxTs: 900,
        nearestFxSource: 'parity_fallback',
      },
      {
        type: 'funding_settled',
        venue: 'BINANCE',
        recvSeq: 13,
        recvTs: 2506,
        source: 'bn_funding_rate_api',
        symbol: 'ETHUSDT',
        settlementTime: 2500,
        isHistoricalBackfill: false,
        fundingRate: '0.00005',
        markPrice: '1703',
        premium: null,
        nearestOraclePriceUsdc: null,
        nearestOraclePriceTs: null,
        nearestFxUsdcUsdt: null,
        nearestFxTs: null,
        nearestFxSource: null,
      },
      // Exit convergence at t=3000: BN bid 1703.00 (cancel prior 1700.00 ask so book is uncrossed), HL ask 1703.00 (exit spread = 0 bps).
      {
        type: 'bn_depth_delta',
        connGen: 2,
        recvSeq: 14,
        recvTs: 3000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 2998,
        U: '211',
        u: '220',
        pu: '210',
        bids: [['1703.00', '5'], ['1699.90', '0']],
        asks: [['1703.10', '5'], ['1700.00', '0']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 15,
        recvTs: 3010,
        sourceTs: 3005,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1702.90', '5']],
        asks: [['1703.00', '5']],
      },
    ];

    const suite = runPhase1Replay(events, {
      plannedQtyEth: '0.500',
      entryBpsList: ['3'],
      hlMaxAgeMsList: [15_000],
      takeProfitBps: '0',
      scenarioExitDepthBufferBps: '1',
      delaysMs: [0, 100],
      cooldownBetweenRejectsMs: 0,
    });

    expect(suite.timelineDiagnostics.binanceBridges).toHaveLength(2);
    expect(suite.timelineDiagnostics.binanceGapCount).toBe(1);

    const bbo0 = suite.summaries.find((s) => s.strategy_version === 'bbo_v1' && s.delay_ms === 0)!;
    const bbo100 = suite.summaries.find((s) => s.strategy_version === 'bbo_v1' && s.delay_ms === 100)!;
    const vwap0 = suite.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 0)!;

    // bbo_v1@0ms triggered on the t=1030 fake BBO, whereas bbo_v1@100ms failed arrival at t=1130 due to gap!
    expect(bbo0.triggered_count).toBe(1);
    expect(bbo100.raw_reject_reasons.EXEC_INVALID_BN_BOOK_INVALID_GAP).toBe(1);

    // vwap_taker_v2@0ms rejected both shallow/low-spread frames (t=1030 and t=2020), then caught t=2030 and completed roundtrip at t=3010!
    expect(vwap0.raw_reject_reasons.NET_EDGE_NOT_POSITIVE).toBe(2);
    expect(vwap0.completed_roundtrips).toBe(1);

    const vwapTrade = suite.rows.find(
      (r) => r.strategy_version === 'vwap_taker_v2' && r.delay_ms === 0 && r.decision === 'TRIGGERED',
    )!;
    expect(vwapTrade.rest_queue_wait_ms).toBeNull();
    expect(vwapTrade.margin_used_actual_usd).toBeNull();
    expect(vwapTrade.funding_events_crossed).toBe(2);
    expect(vwapTrade.funding_legs).toHaveLength(2);
    // Entry: (1706 - 1700) * 0.5 = +3.0; Exit: -(1703 - 1703) * 0.5 = 0;
    // Per-settlement Funding (settlement mark=1703, oracle=1703, fx=1):
    //   HL short receives +0.0001 * 0.5 * 1703 = +0.08515
    //   BN long pays     -0.00005 * 0.5 * 1703 = -0.042575  -> net = +0.042575
    // Fees: BN 0.5*(1700+1703)*0.0005 (=0.85075) + HL 0.5*(1706+1703)*0.00045 (=0.767025) = 1.617775
    // Net PnL = 3.0 + 0.042575 - 1.617775 = 1.4248 USDT
    expect(Number(vwapTrade.roundtrip_net_pnl_usd)).toBeCloseTo(1.4248, 5);
    expect(suite.sampleDelayComparison?.zeroMs.executable).toBe(true);
    expect(suite.sampleDelayComparison?.hundredMs.executable).toBe(false);
    expect(suite.sampleDelayComparison?.hundredMs.rejectReason).toBe('EXEC_INVALID_BN_BOOK_INVALID_GAP');
  });
});

describe('Phase 1 recorder cross-connection snapshot race & safety guards', () => {
  it('allows new connection generation to request snapshot and bridge while delayed connGen=1 response is still pending', async () => {
    const requestedConnGens: number[] = [];
    const emittedEvents: RecordedMarketEvent[] = [];
    let releaseConn1!: (value: {
      lastUpdateId: string;
      bids: Array<[string, string]>;
      asks: Array<[string, string]>;
    }) => void;
    let releaseConn2!: (value: {
      lastUpdateId: string;
      bids: Array<[string, string]>;
      asks: Array<[string, string]>;
    }) => void;

    const recorder = new Phase1MarketRecorder({
      outputDir: '/tmp/unused-unit-test-dir',
      binanceDepthSnapshotFetcher: (_url, connGen) => {
        requestedConnGens.push(connGen);
        return new Promise((resolve) => {
          if (connGen === 1) releaseConn1 = resolve;
          else releaseConn2 = resolve;
        });
      },
      onEvent: (event) => emittedEvents.push(event),
    });

    // ConnGen 1 opens and fires delayed REST request #1.
    recorder.onBinanceConnectionOpened(1, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(requestedConnGens).toEqual([1]);
    expect(recorder.getBinanceSnapshotRequestCountForGeneration(1)).toBe(true);

    // Rotate to connGen 2 while connGen 1's snapshot is still in flight!
    recorder.onBinanceConnectionOpened(2, 0);
    recorder.handleBinanceDepthPayload(2, {
      e: 'depthUpdate',
      E: 2000,
      U: '500',
      u: '510',
      pu: '499',
      b: [['1750.00', '4']],
      a: [['1750.20', '4']],
    });
    await new Promise((r) => setTimeout(r, 10));

    // ConnGen 2 MUST NOT be swallowed by connGen 1's in-flight request.
    expect(requestedConnGens).toEqual([1, 2]);
    expect(recorder.getBinanceBookState().status).toBe('BUFFERING');

    // ConnGen 2 snapshot returns first and bridges connGen 2 cleanly to SYNCED.
    releaseConn2({
      lastUpdateId: '505',
      bids: [['1749.90', '2']],
      asks: [['1750.30', '2']],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(recorder.getBinanceBookState()).toMatchObject({
      status: 'SYNCED',
      connGen: 2,
      lastAppliedU: '510',
    });

    // Delayed connGen 1 snapshot finally arrives after reconnect; must be ignored cleanly.
    releaseConn1({
      lastUpdateId: '100',
      bids: [['1700.00', '1']],
      asks: [['1701.00', '1']],
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(recorder.getBinanceBookState()).toMatchObject({
      status: 'SYNCED',
      connGen: 2,
      lastAppliedU: '510',
    });
    expect(emittedEvents.some(
      (ev) => ev.type === 'bn_book_state' && ev.event === 'stale_snapshot_ignored' && ev.connGen === 1,
    )).toBe(true);
    expect(emittedEvents.some(
      (ev) => ev.type === 'bn_book_state' && ev.event === 'bridge_ready' && ev.connGen === 2,
    )).toBe(true);
    await recorder.stop();
  });

  it('bounds Binance pre-snapshot buffer size and counts overflowed deltas', () => {
    const machine = new BinanceOrderBookStateMachine(3);
    machine.onConnectionOpen(1);
    for (let i = 1; i <= 5; i += 1) {
      machine.onDepthDelta({
        connGen: 1,
        recvSeq: i,
        recvTs: 1000 + i,
        eventTime: 1000 + i,
        U: String(100 + i),
        u: String(100 + i),
        pu: String(99 + i),
        bids: [['1700.00', '1']],
        asks: [],
      });
    }
    expect(machine.getDiagnostics()).toMatchObject({
      status: 'BUFFERING',
      bufferLength: 3,
      droppedOverflowCount: 2,
    });
  });

  it('refuses to overwrite existing capture files unless overwrite is true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase1-overwrite-guard-'));
    try {
      writeFileSync(join(dir, 'events.ndjson'), '{"existing":true}\n');
      const recorder = new Phase1MarketRecorder({ outputDir: dir });
      await expect(recorder.run()).rejects.toThrow(/Refusing to overwrite/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mockBookView(bestBidPrice: string, bestAskPrice: string, sourceTs: number, recvTs: number) {
  const bestBid = [bestBidPrice, '5'] as const;
  const bestAsk = [bestAskPrice, '5'] as const;
  return {
    bestBid,
    bestAsk,
    sourceTs,
    recvTs,
    connGen: 1,
    depthBids: 1,
    depthAsks: 1,
    walkBids: (qty: string) => ({ fillable: true as const, qty, vwapPrice: bestBidPrice, worstPrice: bestBidPrice, notionalQuote: bestBidPrice, levelsUsed: 1 }),
    walkAsks: (qty: string) => ({ fillable: true as const, qty, vwapPrice: bestAskPrice, worstPrice: bestAskPrice, notionalQuote: bestAskPrice, levelsUsed: 1 }),
    snapshot: () => ({ bids: [bestBid], asks: [bestAsk], sourceTs, recvTs, connGen: 1, depthBids: 1, depthAsks: 1 }),
  };
}

describe('Phase 1 Section 9.3 streaming, age-tier, causal, and FX isolation audits', () => {
  it('enforces dual source+recv freshness, bounds coverage overlap across silent gaps, and rejects future/crossed books', () => {
    const staleUnit = evaluateBookValidity(
      mockBookView('1700.0', '1700.1', 1, 20_002),
      20_002,
      { maxRecvAgeMs: 5_000, maxSourceAgeMs: 5_000, futureSourceToleranceMs: 2_000 },
      'SYNCED',
    );
    expect(staleUnit).toEqual({ valid: false, reason: 'STALE_BOOK_SOURCE_OR_RECV' });

    const futureUnit = evaluateBookValidity(
      mockBookView('1700.0', '1700.1', 13_000, 10_000),
      10_000,
      { maxRecvAgeMs: 15_000, maxSourceAgeMs: 15_000, futureSourceToleranceMs: 2_000 },
      'SYNCED',
    );
    expect(futureUnit).toEqual({ valid: false, reason: 'FUTURE_SOURCE_TS_EXCEEDED' });

    const crossedUnit = evaluateBookValidity(
      mockBookView('1700.5', '1700.1', 10_000, 10_000),
      10_000,
      { maxRecvAgeMs: 15_000, maxSourceAgeMs: 15_000, futureSourceToleranceMs: 2_000 },
      'SYNCED',
    );
    expect(crossedUnit).toEqual({ valid: false, reason: 'CROSSED_BOOK' });

    // Full stream case:
    // t=1000: BN snapshot synced (stays valid for BN max 15s -> [1000..16000])
    // t=1000: HL snapshot synced (sourceTs=1000, recvTs=1000) -> valid [1000..16000] (15s), [1000..11000] (10s), [1000..6000] (5s)
    // t=20000: BN delta arrives fresh, while HL is silent for 20s and next HL at t=21000 has sourceTs=1, recvTs=21000 (immediately stale!).
    const events: RecordedMarketEvent[] = [
      { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
      { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 4,
        recvTs: 1000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1000,
        U: '100',
        u: '100',
        pu: '99',
        bids: [['1700.0', '5']],
        asks: [['1700.1', '5']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 1,
        recvSeq: 5,
        recvTs: 1000,
        lastUpdateId: '100',
        bids: [['1700.0', '5']],
        asks: [['1700.1', '5']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 6,
        recvTs: 1000,
        sourceTs: 1000,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1705.0', '5']],
        asks: [['1705.2', '5']],
      },
      // Repeated BN ticks inside silence gap (to test raw reject throttling before cooldown=1000ms).
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 7,
        recvTs: 12_000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 12_000,
        U: '101',
        u: '101',
        pu: '100',
        bids: [['1700.0', '5']],
        asks: [['1700.1', '5']],
      },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 8,
        recvTs: 12_100,
        stream: 'ethusdt@depth@100ms',
        eventTime: 12_100,
        U: '102',
        u: '102',
        pu: '101',
        bids: [['1700.0', '5']],
        asks: [['1700.1', '5']],
      },
      // Stale HL payload whose sourceTs=1 vs recvTs=21_000.
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 9,
        recvTs: 21_000,
        sourceTs: 1,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1706.0', '5']],
        asks: [['1706.2', '5']],
      },
    ];

    const result = runPhase1Replay(events, {
      entryBpsList: ['1'],
      hlMaxAgeMsList: [15_000, 10_000, 5_000],
      delaysMs: [0],
      cooldownBetweenRejectsMs: 1_000,
    });

    const cov15 = result.timelineDiagnostics.coverageByAgeTier.find((c) => c.age_tier === 'hl_15000ms_bn_15000ms')!;
    const cov10 = result.timelineDiagnostics.coverageByAgeTier.find((c) => c.age_tier === 'hl_10000ms_bn_15000ms')!;
    const cov5 = result.timelineDiagnostics.coverageByAgeTier.find((c) => c.age_tier === 'hl_5000ms_bn_15000ms')!;

    expect(cov15.total_window_ms).toBe(20_100);
    expect(cov15.hl_valid_ms).toBe(15_000);
    expect(cov15.valid_overlap_ms).toBe(15_000);
    expect(cov10.hl_valid_ms).toBe(10_000);
    expect(cov10.valid_overlap_ms).toBe(10_000);
    expect(cov5.hl_valid_ms).toBe(5_000);
    expect(cov5.valid_overlap_ms).toBe(5_000);

    // At t=12_000 and t=12_100, tier hl_5000ms had expired HL -> both counted in raw_reject_reasons despite 1000ms cooldown!
    const sum5 = result.summaries.find((s) => s.age_tier === 'hl_5000ms_bn_15000ms' && s.strategy_version === 'vwap_taker_v2')!;
    expect(sum5.raw_reject_reasons.HL_STALE_BOOK_SOURCE_OR_RECV).toBeGreaterThanOrEqual(2);
    // At t=21_000, HL frame has sourceTs=1, so all tiers count HL_STALE_BOOK_SOURCE_OR_RECV!
    const sum15 = result.summaries.find((s) => s.age_tier === 'hl_15000ms_bn_15000ms' && s.strategy_version === 'vwap_taker_v2')!;
    expect(sum15.raw_reject_reasons.HL_STALE_BOOK_SOURCE_OR_RECV).toBeGreaterThanOrEqual(1);
  });

  it('records end-of-window pending orders in inFlightOrdersAtEnd instead of fabricating end-book fills', () => {
    const events: RecordedMarketEvent[] = [
      { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
      { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 4,
        recvTs: 1000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1000,
        U: '100',
        u: '100',
        pu: '99',
        bids: [['1700.0', '5']],
        asks: [['1700.1', '5']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 1,
        recvSeq: 5,
        recvTs: 1000,
        lastUpdateId: '100',
        bids: [['1700.0', '5']],
        asks: [['1700.1', '5']],
      },
      // Last event in file at t=20002 creates a huge spread -> delay=100ms matures at t=20102 > endedAtMs (20002)!
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 6,
        recvTs: 20_002,
        sourceTs: 20_000,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1710.0', '5']],
        asks: [['1710.2', '5']],
      },
    ];

    const result = runPhase1Replay(events, {
      bnMaxRecvAgeMs: 30_000,
      bnMaxSourceAgeMs: 30_000,
      hlMaxAgeMsList: [15_000],
      entryBpsList: ['2'],
      delaysMs: [0, 100],
    });

    const sum100 = result.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 100)!;
    expect(sum100.triggered_count).toBe(0);
    expect(sum100.in_flight_at_end_count).toBe(1);

    const inflight = result.inFlightOrdersAtEnd.find(
      (f) => f.strategy_version === 'vwap_taker_v2' && f.delay_ms === 100,
    )!;
    expect(inflight).toMatchObject({
      kind: 'ENTRY',
      decision_ts: 20_002,
      expected_arrival_ts: 20_102,
      ended_at_ms: 20_002,
      status: 'IN_FLIGHT_AT_END',
    });
  });

  it('isolates native HL contract spread PnL from USDC/USDT collateral FX swings and matches segmented checkpoint replay', async () => {
    const events: RecordedMarketEvent[] = [
      { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1.00', source: 'binance_spot_ticker' },
      { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 4,
        recvTs: 1000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1000,
        U: '100',
        u: '100',
        pu: '99',
        bids: [['1699.9', '5']],
        asks: [['1700.0', '5']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 1,
        recvSeq: 5,
        recvTs: 1000,
        lastUpdateId: '100',
        bids: [['1699.9', '5']],
        asks: [['1700.0', '5']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 6,
        recvTs: 1010,
        sourceTs: 1005,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1706.0', '5']],
        asks: [['1706.2', '5']],
      },
      // Historical backfill funding must be ignored; only live settled counts!
      {
        type: 'funding_settled',
        venue: 'HYPERLIQUID',
        recvSeq: 7,
        recvTs: 1100,
        source: 'hl_funding_history_api',
        symbol: 'ETH',
        settlementTime: 1050,
        isHistoricalBackfill: true,
        fundingRate: '0.005',
        markPrice: null,
        premium: '0',
        nearestOraclePriceUsdc: '1703',
        nearestOraclePriceTs: 1050,
        nearestFxUsdcUsdt: '1.00',
        nearestFxTs: 900,
        nearestFxSource: 'binance_spot_ticker',
      },
      // FX moves +1% before exit:
      // Entry: Long BN @1700.0, Short HL @1706.0 (fx=1.00);
      // Exit: Short BN @1720.0 (bn_contract_pnl=+10.0 USDT), Long HL @1701.0 (hl_contract_pnl_usdc=+2.5 USDC, *1.01=+2.525 USDT).
      // Only realized USDC contract PnL (+2.5) uses settlement FX 1.01; notional (853 USDC) creates ZERO phantom FX PnL!
      { type: 'fx_rate', recvSeq: 8, recvTs: 1900, pair: 'USDC_USDT', rate: '1.01', source: 'binance_spot_ticker' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 9,
        recvTs: 2000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1995,
        U: '101',
        u: '101',
        pu: '100',
        bids: [['1720.0', '5'], ['1699.9', '0']],
        asks: [['1720.1', '5'], ['1700.0', '0']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 10,
        recvTs: 2010,
        sourceTs: 2005,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['1700.9', '5']],
        asks: [['1701.0', '5']],
      },
    ];

    const fullResult = runPhase1Replay(events, {
      plannedQtyEth: '0.500',
      entryBpsList: ['2'],
      hlMaxAgeMsList: [15_000],
      takeProfitBps: '0',
      scenarioExitDepthBufferBps: '1',
      delaysMs: [0],
    });

    const trade = fullResult.rows.find((r) => r.strategy_version === 'vwap_taker_v2' && r.decision === 'TRIGGERED')!;
    expect(trade.is_open_at_end).toBe(false);
    expect(trade.bn_contract_pnl_usdt).toBe('10');
    expect(trade.hl_contract_pnl_usdc).toBe('2.5');
    expect(trade.hl_contract_pnl_usdt).toBe('2.525');
    expect(trade.contract_spread_pnl_usd).toBe('12.525');
    expect(trade.collateral_fx_pnl_usd).toBe('0');
    expect(trade.funding_events_crossed).toBe(0);

    // Segmented checkpoint parity + NDJSON streaming parity:
    const midpoint = 5;
    const seg1 = new StreamingReplayRunner({
      plannedQtyEth: '0.500',
      entryBpsList: ['2'],
      hlMaxAgeMsList: [15_000],
      takeProfitBps: '0',
      scenarioExitDepthBufferBps: '1',
      delaysMs: [0],
    });
    for (const ev of events.slice(0, midpoint)) seg1.processEvent(ev);
    const savedCheckpoint = JSON.parse(JSON.stringify(seg1.exportCheckpoint()));
    const seg2 = StreamingReplayRunner.fromCheckpoint(savedCheckpoint);
    for (const ev of events.slice(midpoint)) seg2.processEvent(ev);
    const segmentedResult = seg2.finalize();

    const normalizeRunId = (rows: typeof fullResult.rows) => rows.map((r) => ({ ...r, run_id: 'normalized' }));
    expect(segmentedResult.summaries).toEqual(fullResult.summaries);
    expect(normalizeRunId(segmentedResult.rows)).toEqual(normalizeRunId(fullResult.rows));
    expect(segmentedResult.timelineDiagnostics.coverageByAgeTier).toEqual(
      fullResult.timelineDiagnostics.coverageByAgeTier,
    );
    expect(segmentedResult.inFlightOrdersAtEnd).toEqual(fullResult.inFlightOrdersAtEnd);

    const tmpDir = mkdtempSync(join(tmpdir(), 'phase1-stream-test-'));
    try {
      const ndjsonPath = join(tmpDir, 'events.ndjson');
      writeFileSync(ndjsonPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
      const streamedResult = await runPhase1ReplayStream(ndjsonPath, {
        plannedQtyEth: '0.500',
        entryBpsList: ['2'],
        hlMaxAgeMsList: [15_000],
        takeProfitBps: '0',
        scenarioExitDepthBufferBps: '1',
        delaysMs: [0],
      });
      expect(streamedResult.summaries).toEqual(fullResult.summaries);
      expect(normalizeRunId(streamedResult.rows)).toEqual(normalizeRunId(fullResult.rows));
      expect(streamedResult.timelineDiagnostics.coverageByAgeTier).toEqual(
        fullResult.timelineDiagnostics.coverageByAgeTier,
      );
      expect(streamedResult.inFlightOrdersAtEnd).toEqual(fullResult.inFlightOrdersAtEnd);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Phase 1 Section 14.2 audit regressions', () => {
  for (const disconnectStatus of ['close', 'injected_disconnect'] as const) {
    it(`invalidates HL book on ${disconnectStatus}, bounds overlap to 20ms, rejects in-flight fill at +100ms, and marks open position unvalued`, () => {
      const events: RecordedMarketEvent[] = [
        { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
        { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
        { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
        {
          type: 'bn_depth_delta',
          connGen: 1,
          recvSeq: 4,
          recvTs: 1000,
          stream: 'ethusdt@depth@100ms',
          eventTime: 1000,
          U: '100',
          u: '100',
          pu: '99',
          bids: [['99.9', '5']],
          asks: [['100.0', '5']],
        },
        {
          type: 'bn_depth_snapshot',
          connGen: 1,
          recvSeq: 5,
          recvTs: 1000,
          lastUpdateId: '100',
          bids: [['99.9', '5']],
          asks: [['100.0', '5']],
        },
        // HL gives profitable quote at t=1030, then disconnects at t=1050 (silent until stream end t=1300).
        {
          type: 'hl_l2book',
          connGen: 1,
          recvSeq: 6,
          recvTs: 1030,
          sourceTs: 1025,
          coin: 'ETH',
          bidLevels: 1,
          askLevels: 1,
          bids: [['101.0', '5']],
          asks: [['101.1', '5']],
        },
        {
          type: 'conn_event',
          venue: 'HYPERLIQUID',
          connGen: 1,
          recvSeq: 7,
          recvTs: 1050,
          status: disconnectStatus,
          url: 'hl',
        },
        // Stale post-disconnect snapshot from disconnected connGen=1 must be ignored.
        {
          type: 'hl_l2book',
          connGen: 1,
          recvSeq: 8,
          recvTs: 1100,
          sourceTs: 1095,
          coin: 'ETH',
          bidLevels: 1,
          askLevels: 1,
          bids: [['101.5', '5']],
          asks: [['101.6', '5']],
        },
        // Binance stays alive & valid through t=1300.
        {
          type: 'bn_depth_delta',
          connGen: 1,
          recvSeq: 9,
          recvTs: 1300,
          stream: 'ethusdt@depth@100ms',
          eventTime: 1300,
          U: '101',
          u: '101',
          pu: '100',
          bids: [['99.9', '5']],
          asks: [['100.0', '5']],
        },
      ];

      const result = runPhase1Replay(events, {
        plannedQtyEth: '0.500',
        entryBpsList: ['2'],
        hlMaxAgeMsList: [15_000],
        delaysMs: [0, 100],
        cooldownBetweenRejectsMs: 0,
      });

      const cov = result.timelineDiagnostics.coverageByAgeTier[0]!;
      expect(cov.hl_valid_ms).toBe(20);
      expect(cov.valid_overlap_ms).toBe(20);

      // 100ms pending order triggered at t=1030 matures at t=1130 -> MUST be rejected (HL disconnected at 1050).
      const vwap100 = result.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 100)!;
      const bbo100 = result.summaries.find((s) => s.strategy_version === 'bbo_v1' && s.delay_ms === 100)!;
      expect(vwap100.triggered_count).toBe(0);
      expect(bbo100.triggered_count).toBe(0);
      expect(vwap100.raw_reject_reasons.EXEC_INVALID_HL_BOOK_NOT_SYNCED).toBe(1);
      expect(bbo100.raw_reject_reasons.EXEC_INVALID_HL_BOOK_NOT_SYNCED).toBe(1);

      // 0ms triggered cleanly at t=1030 before disconnect; at end (t=1300) HL is still disconnected -> MUST be unvalued.
      const vwap0 = result.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 0)!;
      expect(vwap0.triggered_count).toBe(1);
      expect(vwap0.open_at_end_count).toBe(1);
      expect(vwap0.unvalued_open_count).toBe(1);
      expect(vwap0.unvalued_open_qty_eth).toBe('0.5');
      expect(
        result.unvaluedOpenPositions.find((p) => p.strategy_version === 'vwap_taker_v2' && p.delay_ms === 0)?.reason,
      ).toBe('FINAL_BOOK_INVALID_HL_BOOK_NOT_SYNCED');
    });
  }

  it('isolates stale-generation disconnects/opens and blocks reconnect fills until first new-gen snapshot', () => {
    const events: RecordedMarketEvent[] = [
      { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
      { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 4,
        recvTs: 1000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1000,
        U: '100',
        u: '100',
        pu: '99',
        bids: [['99.9', '5']],
        asks: [['100.0', '5']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 1,
        recvSeq: 5,
        recvTs: 1000,
        lastUpdateId: '100',
        bids: [['99.9', '5']],
        asks: [['100.0', '5']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 6,
        recvTs: 1030,
        sourceTs: 1025,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['101.0', '5']],
        asks: [['101.1', '5']],
      },
      // HL disconnects at 1050 and re-opens connGen=2 at 1100 (NO snapshot yet at 1130!).
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 7, recvTs: 1050, status: 'close', url: 'hl' },
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 2, recvSeq: 8, recvTs: 1100, status: 'open', url: 'hl' },
      // Stale connGen=1 snapshot arrives at 1120 -> MUST NOT satisfy connGen=2.
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 9,
        recvTs: 1120,
        sourceTs: 1115,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['101.2', '5']],
        asks: [['101.3', '5']],
      },
      // At t=1200 connGen=2 receives its first valid snapshot -> valid from 1200 onward.
      {
        type: 'hl_l2book',
        connGen: 2,
        recvSeq: 10,
        recvTs: 1200,
        sourceTs: 1195,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['99.9', '5']],
        asks: [['100.0', '5']],
      },
      // Delayed stale connGen=1 close arriving AFTER connGen=2 opened/synced MUST NOT invalidate connGen=2!
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 11, recvTs: 1250, status: 'close', url: 'hl' },
      { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 12, recvTs: 1255, status: 'open', url: 'bn' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 13,
        recvTs: 1300,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1300,
        U: '101',
        u: '101',
        pu: '100',
        bids: [['100.0', '5'], ['99.9', '0']],
        asks: [['100.1', '5'], ['100.0', '0']],
      },
    ];

    const result = runPhase1Replay(events, {
      plannedQtyEth: '0.500',
      entryBpsList: ['2'],
      hlMaxAgeMsList: [15_000],
      takeProfitBps: '0',
      delaysMs: [0, 100],
      cooldownBetweenRejectsMs: 0,
    });

    const cov = result.timelineDiagnostics.coverageByAgeTier[0]!;
    // [1030, 1050] = 20ms + [1200, 1300] = 100ms -> 120ms (unaffected by stale gen=1 close at 1250!)
    expect(cov.hl_valid_ms).toBe(120);
    expect(cov.valid_overlap_ms).toBe(120);

    // 100ms pending order from 1030 maturing at 1130 (between connGen=2 open at 1100 and snapshot at 1200) -> rejected!
    const vwap100 = result.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 100)!;
    expect(vwap100.triggered_count).toBe(0);
    expect(vwap100.raw_reject_reasons.EXEC_INVALID_HL_BOOK_NOT_SYNCED).toBe(1);

    // 0ms opened at 1030, waited through disconnect, closed cleanly on connGen=2 at 1200!
    const vwap0 = result.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 0)!;
    expect(vwap0.completed_roundtrips).toBe(1);
    expect(vwap0.open_at_end_count).toBe(0);
  });

  it('reconciles late-arriving funding settlements identically to early settlements without changing decisions or double-counting', async () => {
    const buildEvents = (fundingRecvTs: number, includeDuplicate: boolean): RecordedMarketEvent[] => {
      const list: RecordedMarketEvent[] = [
        { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
        { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
        { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
        {
          type: 'bn_depth_delta',
          connGen: 1,
          recvSeq: 4,
          recvTs: 1000,
          stream: 'ethusdt@depth@100ms',
          eventTime: 1000,
          U: '100',
          u: '100',
          pu: '99',
          bids: [['99.9', '5']],
          asks: [['100.0', '5']],
        },
        {
          type: 'bn_depth_snapshot',
          connGen: 1,
          recvSeq: 5,
          recvTs: 1000,
          lastUpdateId: '100',
          bids: [['99.9', '5']],
          asks: [['100.0', '5']],
        },
        // Entry at t=1030: Long BN @ 100.0, Short HL @ 101.0 (1 ETH -> spread +1.00 USDT).
        {
          type: 'hl_l2book',
          connGen: 1,
          recvSeq: 6,
          recvTs: 1030,
          sourceTs: 1025,
          coin: 'ETH',
          bidLevels: 1,
          askLevels: 1,
          bids: [['101.0', '5']],
          asks: [['101.1', '5']],
        },
        // Exit convergence at t=1150: Short BN close @ 100.0, Long HL close @ 100.0 (spread 0).
        {
          type: 'bn_depth_delta',
          connGen: 1,
          recvSeq: 7,
          recvTs: 1140,
          stream: 'ethusdt@depth@100ms',
          eventTime: 1138,
          U: '101',
          u: '101',
          pu: '100',
          bids: [['100.0', '5'], ['99.9', '0']],
          asks: [['100.1', '5'], ['100.0', '0']],
        },
        {
          type: 'hl_l2book',
          connGen: 1,
          recvSeq: 8,
          recvTs: 1150,
          sourceTs: 1148,
          coin: 'ETH',
          bidLevels: 1,
          askLevels: 1,
          bids: [['99.9', '5']],
          asks: [['100.0', '5']],
        },
        {
          type: 'funding_settled',
          venue: 'BINANCE',
          recvSeq: 9,
          recvTs: fundingRecvTs,
          source: 'bn_funding_rate_api',
          symbol: 'ETHUSDT',
          settlementTime: 1050,
          isHistoricalBackfill: false,
          fundingRate: '0.001',
          markPrice: '100',
          premium: null,
          nearestOraclePriceUsdc: null,
          nearestOraclePriceTs: null,
          nearestFxUsdcUsdt: null,
          nearestFxTs: null,
          nearestFxSource: null,
        },
      ];
      if (includeDuplicate) {
        list.push({
          type: 'funding_settled',
          venue: 'BINANCE',
          recvSeq: 10,
          recvTs: fundingRecvTs + 10,
          source: 'bn_funding_rate_api',
          symbol: 'ETHUSDT',
          settlementTime: 1050,
          isHistoricalBackfill: false,
          fundingRate: '0.001',
          markPrice: '100',
          premium: null,
          nearestOraclePriceUsdc: null,
          nearestOraclePriceTs: null,
          nearestFxUsdcUsdt: null,
          nearestFxTs: null,
          nearestFxSource: null,
        });
      }
      return list;
    };

    const replayCfg = {
      plannedQtyEth: '1',
      entryBpsList: ['2'],
      hlMaxAgeMsList: [15_000],
      takeProfitBps: '0',
      delaysMs: [0],
      cooldownBetweenRejectsMs: 0,
    };

    const earlyEvents = buildEvents(1080, false);
    const lateEvents = buildEvents(1220, true);
    const earlyRes = runPhase1Replay(earlyEvents, replayCfg);
    const lateRes = runPhase1Replay(lateEvents, replayCfg);

    const normalize = (rows: typeof earlyRes.rows) => rows.map((r) => ({ ...r, run_id: 'norm' }));
    expect(lateRes.summaries).toEqual(earlyRes.summaries);
    expect(normalize(lateRes.rows)).toEqual(normalize(earlyRes.rows));

    const vwapEarly = earlyRes.rows.find((r) => r.strategy_version === 'vwap_taker_v2' && r.decision === 'TRIGGERED')!;
    const vwapLate = lateRes.rows.find((r) => r.strategy_version === 'vwap_taker_v2' && r.decision === 'TRIGGERED')!;
    expect(vwapEarly.funding_events_crossed).toBe(1);
    expect(vwapEarly.funding_net_usd).toBe('-0.1');
    expect(vwapLate.funding_events_crossed).toBe(1);
    expect(vwapLate.funding_net_usd).toBe('-0.1');
    expect(vwapLate.funding_legs).toEqual(vwapEarly.funding_legs);
    expect(vwapLate.roundtrip_net_pnl_usd).toBe(vwapEarly.roundtrip_net_pnl_usd);

    // Also verify streaming NDJSON runner produces identical streamed rows & summaries when funding arrives late.
    const tmpDir = mkdtempSync(join(tmpdir(), 'phase1-late-funding-'));
    try {
      const sortedLate = [...lateEvents].sort((a, b) => a.recvTs - b.recvTs || a.recvSeq - b.recvSeq);
      const ndjsonPath = join(tmpDir, 'events.ndjson');
      writeFileSync(ndjsonPath, `${sortedLate.map((e) => JSON.stringify(e)).join('\n')}\n`);
      const streamedRows: typeof earlyRes.rows = [];
      const streamedRes = await runPhase1ReplayStream(ndjsonPath, replayCfg, {
        retainRowsInMemory: true,
        onFinalizedRow: (row) => streamedRows.push(row),
      });
      expect(streamedRes.summaries).toEqual(earlyRes.summaries);
      expect(normalize(streamedRows)).toEqual(normalize(earlyRes.rows));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('collapses same-price levels across decimal formats without inflating depth and removes them cleanly', () => {
    expect(canonicalPriceKey('100.00')).toBe('100');
    expect(canonicalPriceKey('100.0')).toBe('100');
    expect(canonicalPriceKey('00100.500')).toBe('100.5');

    const side = new SortedBookSide(false);
    side.loadSnapshot([['100.00', '0.3']]);
    side.apply([['100.0', '0.4']]);

    expect(side.size()).toBe(1);
    expect(side.best()).toEqual(['100.0', '0.4']);
    expect(side.getCrossFormatMutationCount()).toBe(1);
    expect(side.walkDepth('0.5')).toEqual({
      fillable: false,
      requestedQty: '0.5',
      maxAvailableQty: '0.4',
      visibleLevels: 1,
    });
    expect(side.walkDepth('0.4')).toMatchObject({
      fillable: true,
      qty: '0.4',
      vwapPrice: '100',
      levelsUsed: 1,
    });

    // Zeroing with another notation must delete the original level.
    side.apply([['100.000', '0']]);
    expect(side.size()).toBe(0);
    expect(side.best()).toBeNull();
    expect(side.getCrossFormatMutationCount()).toBe(2);

    // Direct removal of snapshot "100.00" using "100.0" x 0 must also delete cleanly.
    const directRemovalSide = new SortedBookSide(false);
    directRemovalSide.loadSnapshot([['100.00', '0.3']]);
    directRemovalSide.apply([['100.0', '0']]);
    expect(directRemovalSide.size()).toBe(0);
    expect(directRemovalSide.best()).toBeNull();
    expect(directRemovalSide.getCrossFormatMutationCount()).toBe(1);

    // End-to-end replay must likewise reject 0.5 ETH when 100.00 x 0.3 is replaced by 100.0 x 0.4.
    const events: RecordedMarketEvent[] = [
      { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
      { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
      { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 4,
        recvTs: 1000,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1000,
        U: '100',
        u: '100',
        pu: '99',
        bids: [['99.50', '5']],
        asks: [['100.00', '0.3']],
      },
      {
        type: 'bn_depth_snapshot',
        connGen: 1,
        recvSeq: 5,
        recvTs: 1000,
        lastUpdateId: '100',
        bids: [['99.50', '5']],
        asks: [['100.00', '0.3']],
      },
      {
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 6,
        recvTs: 1010,
        stream: 'ethusdt@depth@100ms',
        eventTime: 1010,
        U: '101',
        u: '101',
        pu: '100',
        bids: [],
        asks: [['100.0', '0.4']],
      },
      {
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 7,
        recvTs: 1020,
        sourceTs: 1015,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [['101.0', '5']],
        asks: [['101.2', '5']],
      },
    ];

    const res = runPhase1Replay(events, {
      plannedQtyEth: '0.500',
      entryBpsList: ['2'],
      hlMaxAgeMsList: [15_000],
      delaysMs: [0],
      cooldownBetweenRejectsMs: 0,
    });
    const vwap = res.summaries.find((s) => s.strategy_version === 'vwap_taker_v2')!;
    expect(vwap.triggered_count).toBe(0);
    expect(vwap.raw_reject_reasons.INSUFFICIENT_DEPTH_BINANCE).toBe(1);
    expect(res.timelineDiagnostics.crossFormatPriceUpdates.binance).toBe(1);
  });
});
