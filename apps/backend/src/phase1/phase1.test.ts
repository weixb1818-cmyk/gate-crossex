import { describe, expect, it } from 'vitest';
import {
  BinanceOrderBookStateMachine,
  HyperliquidOrderBookStateMachine,
  walkOrderBookDepth,
} from './orderbook-state.js';
import { stripProcessProxyEnv } from './proxy-free.js';
import { buildReplayTimeline, runPhase1Replay } from './replay.js';
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
        fundingRate: '0.0001',
        referencePriceOrPremium: '0',
      },
      {
        type: 'funding_settled',
        venue: 'BINANCE',
        recvSeq: 13,
        recvTs: 2506,
        source: 'bn_funding_rate_api',
        symbol: 'ETHUSDT',
        settlementTime: 2500,
        fundingRate: '0.00005',
        referencePriceOrPremium: '1703',
      },
      // Exit convergence at t=3000: BN bid 1703.00, HL ask 1703.00 (exit spread = 0 bps).
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
        bids: [['1703.00', '5']],
        asks: [['1703.10', '5']],
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

    const timeline = buildReplayTimeline(events);
    expect(timeline.diagnostics.binanceBridges).toHaveLength(2);
    expect(timeline.diagnostics.binanceGapCount).toBe(1);

    const suite = runPhase1Replay(events, {
      plannedQtyEth: '0.500',
      entryBps: '3',
      takeProfitBps: '0',
      scenarioExitDepthBufferBps: '1',
      delaysMs: [0, 100],
      cooldownBetweenRejectsMs: 0,
    });

    const bbo0 = suite.summaries.find((s) => s.strategy_version === 'bbo_v1' && s.delay_ms === 0)!;
    const bbo100 = suite.summaries.find((s) => s.strategy_version === 'bbo_v1' && s.delay_ms === 100)!;
    const vwap0 = suite.summaries.find((s) => s.strategy_version === 'vwap_taker_v2' && s.delay_ms === 0)!;

    // bbo_v1@0ms triggered on the t=1030 fake BBO, whereas bbo_v1@100ms failed arrival at t=1130 due to gap!
    expect(bbo0.triggered_count).toBe(1);
    expect(bbo100.reject_reasons.EXEC_BOOK_INVALID_AT_ARRIVAL).toBe(1);

    // vwap_taker_v2@0ms rejected both shallow/low-spread frames (t=1030 and t=2020), then caught t=2030 and completed roundtrip at t=3010!
    expect(vwap0.reject_reasons.NET_EDGE_NOT_POSITIVE).toBe(2);
    expect(vwap0.completed_roundtrips).toBe(1);

    const vwapTrade = suite.rows.find(
      (r) => r.strategy_version === 'vwap_taker_v2' && r.delay_ms === 0 && r.decision === 'TRIGGERED',
    )!;
    expect(vwapTrade.rest_queue_wait_ms).toBeNull();
    expect(vwapTrade.margin_used_actual_usd).toBeNull();
    expect(vwapTrade.funding_events_crossed).toBe(2);
    // Entry: (1706 - 1700) * 0.5 = +3.0; Exit: -(1703 - 1703) * 0.5 = 0;
    // Funding: (0.0001 - 0.00005) * (0.5 * 1700) = +0.0425;
    // Fees: BN 0.5*(1700+1703)*0.0005 (=0.85075) + HL 0.5*(1706+1703)*0.00045 (=0.767025) = 1.617775
    // Net PnL = 3.0 + 0.0425 - 1.617775 = 1.424725 USDT
    expect(Number(vwapTrade.roundtrip_net_pnl_usd)).toBeCloseTo(1.424725, 5);
    expect(suite.sampleDelayComparison?.zeroMs.executable).toBe(true);
    expect(suite.sampleDelayComparison?.hundredMs.executable).toBe(false);
    expect(suite.sampleDelayComparison?.hundredMs.rejectReason).toBe('BOOK_INVALID_AT_ARRIVAL');
  });
});
