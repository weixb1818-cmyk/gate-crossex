import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault } from '../credential-vault.js';
import type { GateCrossExAccount } from '../crossex-client.js';
import { openDatabase } from '../database.js';
import type { CaptureCatalogMeta, RecordedMarketEvent } from '../phase1/types.js';
import { TradingRuntime } from '../trading-runtime.js';
import { TradingSession } from '../trading-session.js';
import {
  DEFAULT_NATIVE_ADAPTER_CONFIG,
  NativeDualMarketAdapter,
} from './native-market-adapter.js';
import {
  buildCrossExShadowOrderIntent,
  SimulatedCrossExGateway,
} from './shadow-gateway.js';
import {
  evaluateFundingStrategyPathComparison,
  extractLatestComparableFromCxRaw,
  Phase2ShadowCoordinator,
} from './shadow-runner.js';
import {
  DEFAULT_SHADOW_RISK_LIMITS,
  SharedMarginCoordinator,
  summarizeAccountSnapshot,
} from './shared-margin-coordinator.js';

function createEthCatalog(state = 'live'): CaptureCatalogMeta {
  return {
    fetchedAt: '2026-11-28T09:00:00.000Z',
    asset: 'ETH',
    commonLotStep: '0.001',
    commonMinNotionalUsd: '20',
    unitMultiplier: '1',
    crossexRules: [
      {
        symbol: 'BINANCE_FUTURE_ETH_USDT',
        exchangeType: 'BINANCE',
        businessType: 'FUTURE',
        state,
        minSize: '0.001',
        minNotional: '20',
        lotSize: '0.001',
        tickSize: '0.01',
        maxMarketSize: '100',
        maxLimitSize: '100',
        contractSize: '1',
      },
      {
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        exchangeType: 'HYPERLIQUID',
        businessType: 'FUTURE',
        state,
        minSize: '0.001',
        minNotional: '10',
        lotSize: '0.001',
        tickSize: '0.01',
        maxMarketSize: '100',
        maxLimitSize: '100',
        contractSize: '1',
      },
    ],
  };
}

function createHealthyAdapter(baseTs = 1_783_600_000_000): NativeDualMarketAdapter {
  const adapter = new NativeDualMarketAdapter({ ...DEFAULT_NATIVE_ADAPTER_CONFIG });
  adapter.setCatalog(createEthCatalog('live'));

  adapter.bnMachine.onConnectionOpen(1);
  adapter.bnMachine.onDepthDelta({
    connGen: 1,
    recvSeq: 1,
    recvTs: baseTs,
    eventTime: baseTs - 10,
    U: '100',
    u: '105',
    pu: '99',
    bids: [['3000.00', '2.0']],
    asks: [['3000.50', '2.0']],
  });
  adapter.bnMachine.onRestSnapshot({
    connGen: 1,
    fetchedAtMs: baseTs - 5,
    lastUpdateId: '102',
    bids: [['3000.00', '2.0']],
    asks: [['3000.50', '2.0']],
  });

  adapter.hlMachine.onConnectionOpen(1);
  adapter.hlMachine.onSnapshot({
    connGen: 1,
    sourceTs: baseTs - 10,
    recvTs: baseTs,
    bids: [['3001.20', '2.0']],
    asks: [['3001.80', '2.0']],
  });

  adapter.onFxRate('1.0001', baseTs, 'gate_spot_ticker');
  return adapter;
}

const runtimeCleanups: Array<{ database: Database.Database; directory: string }> = [];

afterEach(() => {
  for (const item of runtimeCleanups.splice(0)) {
    item.database.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe('Phase 2 NativeDualMarketAdapter', () => {
  it('validates healthy synced dual books, FX, catalog, and CrossEx quote agreement', () => {
    const baseTs = 1_783_600_000_000;
    const adapter = createHealthyAdapter(baseTs);
    adapter.onCrossExComparableQuote({
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      bidPrice: '3000.05',
      askPrice: '3000.55',
      sourceTs: baseTs - 20,
      recvTs: baseTs,
    });

    const health = adapter.evaluateHealth(baseTs + 100, '0.500');
    expect(health.valid).toBe(true);
    expect(health.allowNewRisk).toBe(true);
    expect(health.reasons).toEqual([]);
    expect(health.bnView?.bestBid).toEqual(['3000.00', '2.0']);
    expect(health.hlView?.bestAsk).toEqual(['3001.80', '2.0']);
    expect(health.crossexComparison.bnDeviationBps).not.toBeNull();
  });

  it('freezes new risk on catalog contract mismatch, disconnect, staleness, shallow depth, or CrossEx divergence', () => {
    const baseTs = 1_783_600_000_000;

    // 1. Catalog contract not live
    const badCatalog = createHealthyAdapter(baseTs);
    badCatalog.setCatalog(createEthCatalog('delisted'));
    const rCat = badCatalog.evaluateHealth(baseTs + 50, '0.500');
    expect(rCat.allowNewRisk).toBe(false);
    expect(rCat.reasons).toContain('CATALOG_CONTRACT_MISSING_OR_INACTIVE_BINANCE_FUTURE_ETH_USDT');

    // 2. HL disconnect immediately freezes opening risk
    const disconnected = createHealthyAdapter(baseTs);
    disconnected.hlMachine.onConnectionDisconnect(1);
    const rDisc = disconnected.evaluateHealth(baseTs + 50, '0.500');
    expect(rDisc.allowNewRisk).toBe(false);
    expect(rDisc.reasons.some((r) => r.startsWith('HL_'))).toBe(true);

    // 3. Stale timestamps / stale FX
    const stale = createHealthyAdapter(baseTs);
    const rStale = stale.evaluateHealth(baseTs + 200_000, '0.500');
    expect(rStale.allowNewRisk).toBe(false);
    expect(rStale.reasons).toContain('FX_STALE');

    // 4. Depth below required qty
    const shallow = createHealthyAdapter(baseTs);
    const rShallow = shallow.evaluateHealth(baseTs + 50, '5.000');
    expect(rShallow.allowNewRisk).toBe(false);
    expect(rShallow.reasons).toContain('BN_INSUFFICIENT_VISIBLE_DEPTH');
    expect(rShallow.reasons).toContain('HL_INSUFFICIENT_VISIBLE_DEPTH');

    // 5. Native vs CrossEx quote divergence (> 50 bps default)
    const diverged = createHealthyAdapter(baseTs);
    diverged.onCrossExComparableQuote({
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      bidPrice: '3030.00',
      askPrice: '3030.50',
      sourceTs: baseTs - 10,
      recvTs: baseTs,
    });
    const rDiv = diverged.evaluateHealth(baseTs + 50, '0.500');
    expect(rDiv.allowNewRisk).toBe(false);
    expect(rDiv.reasons).toContain('BN_CROSSEX_DEVIATION_EXCEEDED');
  });

  it('extracts comparable top-of-book quotes from cx_raw ticker events', () => {
    const tickerEvent: RecordedMarketEvent = {
      type: 'cx_raw',
      connGen: 1,
      recvSeq: 12,
      recvTs: 1_783_600_005_000,
      channel: 'ticker',
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      payload: {
        symbol: 'BINANCE_FUTURE_ETH_USDT',
        highest_bid: '3000.1',
        lowest_ask: '3000.6',
      },
    };
    const nonTickerEvent: RecordedMarketEvent = {
      type: 'cx_raw',
      connGen: 1,
      recvSeq: 13,
      recvTs: 1_783_600_005_010,
      channel: 'order_book_update',
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      payload: {},
    };

    expect(extractLatestComparableFromCxRaw(tickerEvent)).toEqual({
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      bidPrice: '3000.1',
      askPrice: '3000.6',
      recvTs: 1_783_600_005_000,
    });
    expect(extractLatestComparableFromCxRaw(nonTickerEvent)).toBeNull();
  });
});

describe('Phase 2 CrossEx Order Semantics & Payload Validation', () => {
  it('constructs schema-valid PROTECTIVE_LIMIT_IOC, MAKER_POC, MARKET_IOC, and reduce_only payloads', () => {
    const catalog = createEthCatalog('live');

    const buyProtective = buildCrossExShadowOrderIntent({
      intentId: 'clip-1-bn',
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      side: 'BUY',
      semantics: 'PROTECTIVE_LIMIT_IOC',
      qtyEth: '0.5009',
      referencePrice: '3000.00',
      protectiveSlippageBps: '10',
      reduceOnly: false,
      catalog,
      decisionTs: 1_783_600_000_000,
    });
    expect(buyProtective.request.type).toBe('LIMIT');
    expect(buyProtective.request.time_in_force).toBe('IOC');
    expect(buyProtective.request.qty).toBe('0.5');
    expect(buyProtective.request.price).toBe('3003');
    expect(buyProtective.request.reduce_only).toBe('false');
    expect(buyProtective.unboundedPriceRisk).toBe(false);

    const makerPoc = buildCrossExShadowOrderIntent({
      intentId: 'clip-1-hl-maker',
      symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
      side: 'SELL',
      semantics: 'MAKER_POC',
      qtyEth: '0.250',
      referencePrice: '3001.20',
      reduceOnly: false,
      catalog,
      decisionTs: 1_783_600_000_000,
    });
    expect(makerPoc.request.type).toBe('LIMIT');
    expect(makerPoc.request.time_in_force).toBe('POC');
    expect(makerPoc.request.price).toBe('3001.2');
    expect(makerPoc.unboundedPriceRisk).toBe(false);

    const marketReduceOnly = buildCrossExShadowOrderIntent({
      intentId: 'clip-1-flatten',
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      side: 'SELL',
      semantics: 'MARKET_IOC',
      qtyEth: '0.250',
      referencePrice: '3000.00',
      reduceOnly: true,
      catalog,
      decisionTs: 1_783_600_000_000,
    });
    expect(marketReduceOnly.request.type).toBe('MARKET');
    expect(marketReduceOnly.request.time_in_force).toBe('IOC');
    expect(marketReduceOnly.request.price).toBeUndefined();
    expect(marketReduceOnly.request.reduce_only).toBe('true');
    expect(marketReduceOnly.unboundedPriceRisk).toBe(true);
  });
});

describe('Phase 2 SharedMarginCoordinator & Risk Guardrails', () => {
  it('enforces liveOpenNotionalCapUsd = 0, single-writer contention across strategies, and partial settlement', () => {
    const coordinator = new SharedMarginCoordinator({
      ...DEFAULT_SHADOW_RISK_LIMITS,
      liveOpenNotionalCapUsd: '0',
      shadowAccountBudgetUsd: '1000',
      minAvailableMarginBufferRatio: '0.15',
      maxOrderNotionalUsd: '1000',
      maxPairNotionalUsd: '2000',
    });

    // Live submissions strictly rejected when live cap is zero
    const liveAttempt = coordinator.tryReserve({
      reservationId: 'live-1',
      strategyId: 'arb-eth',
      mode: 'LIVE',
      leverage: '5',
      perLegNotionalUsd: '500',
      atMs: 1_000,
    });
    expect(liveAttempt).toEqual({ ok: false, reason: 'LIVE_OPEN_CAP_ZERO_SHADOW_ONLY' });

    // Strategy A reserves 500 per leg (1000 dual / 5 * 1.10 = 220 margin)
    const rA = coordinator.tryReserve({
      reservationId: 'res-a',
      strategyId: 'strat-a',
      mode: 'SHADOW',
      leverage: '5',
      perLegNotionalUsd: '500',
      atMs: 1_000,
    });
    expect(rA.ok).toBe(true);

    // Strategy B reserves 1000 per leg (2000 dual / 5 * 1.10 = 440 margin; total 660 <= 850 usable)
    const rB = coordinator.tryReserve({
      reservationId: 'res-b',
      strategyId: 'strat-b',
      mode: 'SHADOW',
      leverage: '5',
      perLegNotionalUsd: '1000',
      atMs: 1_001,
    });
    expect(rB.ok).toBe(true);

    // Strategy C asking for 500 per leg (220 margin) hits INSUFFICIENT_SHARED_MARGIN (660 + 220 = 880 > 850)
    const rCRejected = coordinator.tryReserve({
      reservationId: 'res-c',
      strategyId: 'strat-c',
      mode: 'SHADOW',
      leverage: '5',
      perLegNotionalUsd: '500',
      atMs: 1_002,
    });
    expect(rCRejected).toEqual({ ok: false, reason: 'INSUFFICIENT_SHARED_MARGIN' });

    // Partial fill (50%) on Strategy B returns 220 margin back to the pool -> Strategy C now fits
    const settledB = coordinator.settleReservation('res-b', '0.5');
    expect(settledB?.reservedMarginUsd).toBe('220');

    const rCAdmitted = coordinator.tryReserve({
      reservationId: 'res-c-retry',
      strategyId: 'strat-c',
      mode: 'SHADOW',
      leverage: '5',
      perLegNotionalUsd: '500',
      atMs: 1_003,
    });
    expect(rCAdmitted.ok).toBe(true);
  });

  it('detects all guardrail breaches, summarizes account snapshot, and gates restart reconciliation', () => {
    const coordinator = new SharedMarginCoordinator();
    const account: GateCrossExAccount = {
      available_margin: '100',
      margin_balance: '1000',
      initial_margin: '500',
      maintenance_margin: '900',
      initial_margin_rate: '0.5',
      maintenance_margin_rate: '0.9',
      position_mode: 'ONE_WAY',
      account_mode: 'CROSS_EXCHANGE',
      exchange_type: 'ALL',
      update_time: '1783600000000',
      assets: [
        {
          exchange_type: 'BINANCE',
          coin: 'USDT',
          balance: '250',
          upnl: '0',
          equity: '250',
          futures_initial_margin: '250',
          futures_maintenance_margin: '450',
          borrowing_initial_margin: '0',
          borrowing_maintenance_margin: '0',
          available_balance: '50',
          liability: '12.5',
        },
      ],
    };

    const snapshot = summarizeAccountSnapshot(
      account,
      [
        {
          position_id: 'mp-1',
          symbol: 'BINANCE_SPOT_USDT',
          position_side: 'NONE',
          initial_margin: '0',
          maintenance_margin: '0',
          asset_qty: '100',
          asset_coin: 'USDT',
          position_value: '100',
          liability: '12.5',
          liability_coin: 'USDT',
          interest: '0.125',
          max_position_qty: '1000',
          entry_price: '1',
          index_price: '1',
          upnl: '0',
          upnl_rate: '0',
          leverage: '5',
          max_leverage: '5',
          create_time: '1',
          update_time: '2',
        },
      ],
      '2026-11-28T09:00:00.000Z',
    );
    expect(snapshot.marginPositionInterestUsd).toBe('0.125');
    expect(snapshot.assetLiabilities[0]?.liability).toBe('12.5');

    const breaches = coordinator.evaluateGuardrails({
      nakedNotionalUsd: '1500',
      nakedDurationMs: 6_000,
      realizedPlusUnrealizedPnlUsd: '-26',
      account,
    });
    expect(breaches.map((b) => b.code)).toEqual([
      'NAKED_NOTIONAL_EXCEEDED',
      'NAKED_DURATION_EXCEEDED',
      'TRIAL_LOSS_EXCEEDED',
      'MAINTENANCE_MARGIN_BUFFER_BREACH',
    ]);
    expect(breaches.every((b) => b.action === 'CANCEL_OPEN_ORDERS_AND_REDUCE_ONLY_FLATTEN')).toBe(true);

    const blockedRestart = coordinator.reconcileAfterRestart({
      openRemoteOrderIds: ['ord-99'],
      exchangePositions: [
        {
          position_id: 'p-1',
          symbol: 'BINANCE_FUTURE_ETH_USDT',
          position_side: 'LONG',
          initial_margin: '300',
          maintenance_margin: '15',
          position_qty: '0.5',
          position_value: '1500',
          upnl: '0',
          upnl_rate: '0',
          entry_price: '3000',
          mark_price: '3000',
          leverage: '5',
          max_leverage: '25',
          risk_limit: '100000',
          fee: '0',
          funding_fee: '0',
          funding_time: '0',
          create_time: '0',
          update_time: '0',
          closed_pnl: '0',
        },
      ],
      expectedPositionsBySymbol: { BINANCE_FUTURE_ETH_USDT: '0' },
    });
    expect(blockedRestart.safeToResumeOpening).toBe(false);
    expect(blockedRestart.blockingReasons).toHaveLength(2);

    const cleanRestart = coordinator.reconcileAfterRestart({
      openRemoteOrderIds: [],
      exchangePositions: [],
      expectedPositionsBySymbol: { BINANCE_FUTURE_ETH_USDT: '0' },
    });
    expect(cleanRestart.safeToResumeOpening).toBe(true);
  });
});

describe('Phase 2 SimulatedCrossExGateway Fault Scenarios & TradingRuntime Recovery', () => {
  it('handles zero-fill IOC without reserving ghost margin', async () => {
    let clock = 1_783_600_000_000;
    const adapter = createHealthyAdapter(clock);
    const margin = new SharedMarginCoordinator();
    const gateway = new SimulatedCrossExGateway({ nowMs: () => (clock += 5) });
    gateway.enqueueFaultScript({ kind: 'ZERO_FILL_IOC' });

    const coordinator = new Phase2ShadowCoordinator({ adapter, margin, gateway });
    const result = await coordinator.runShadowEntryClip({
      clipId: 'clip-zero',
      strategyId: 'eth-arb',
      direction: 'LONG_BN_SHORT_HL',
      qtyEth: '0.200',
      atMs: clock,
      mode: 'TAKER_TAKER',
      executeOnSimulator: true,
    });

    expect(result.admitted).toBe(true);
    expect(result.residualExposureEth).toBe('0');
    expect(result.settledReservationMarginUsd).toBe('0');
    expect(margin.getTotalReservedMarginUsd()).toBe('0');
    expect(gateway.submittedRequests).toHaveLength(1);
  });

  it('repairs partial hedge fill via protective reduce_only IOC flatten and records 5-stage timestamps', async () => {
    let clock = 1_783_600_000_000;
    const adapter = createHealthyAdapter(clock);
    const margin = new SharedMarginCoordinator();
    const gateway = new SimulatedCrossExGateway({ nowMs: () => (clock += 10) });
    gateway.enqueueFaultScript(
      { kind: 'FILL', fillPrice: '3000.50' },
      { kind: 'PARTIAL_FILL_IOC', fillQty: '0.080', fillPrice: '3001.20' },
      { kind: 'FILL', fillPrice: '3000.00' },
    );

    const coordinator = new Phase2ShadowCoordinator({ adapter, margin, gateway });
    const result = await coordinator.runShadowEntryClip({
      clipId: 'clip-partial',
      strategyId: 'eth-arb',
      direction: 'LONG_BN_SHORT_HL',
      qtyEth: '0.200',
      atMs: clock,
      mode: 'TAKER_TAKER',
      executeOnSimulator: true,
    });

    expect(result.admitted).toBe(true);
    expect(result.residualExposureEth).toBe('0');
    expect(gateway.submittedRequests).toHaveLength(3);
    expect(gateway.submittedRequests[2]?.reduce_only).toBe('true');
    expect(gateway.submittedRequests[2]?.qty).toBe('0.12');

    // Verify 5-stage timestamps are populated deterministically
    const timestamps = Array.from(gateway.orderTimestamps.values());
    expect(timestamps).toHaveLength(3);
    expect(timestamps[0]?.decisionTs).toBeLessThanOrEqual(timestamps[0]!.queuedTs);
    expect(timestamps[0]?.queuedTs).toBeLessThanOrEqual(timestamps[0]!.dispatchedTs);
    expect(timestamps[0]?.ackedTs).not.toBeNull();
    expect(timestamps[0]?.terminalFillTs).not.toBeNull();
  });

  it('hedges exact confirmed qty when resting MAKER_POC receives a late fill during cancellation', async () => {
    let clock = 1_783_600_000_000;
    const adapter = createHealthyAdapter(clock);
    const margin = new SharedMarginCoordinator();
    const gateway = new SimulatedCrossExGateway({ nowMs: () => (clock += 10) });
    gateway.enqueueFaultScript(
      { kind: 'RESTING_POC', lateFillOnCancelQty: '0.075', lateFillPrice: '3000.00' },
      { kind: 'FILL', fillPrice: '3001.20' },
    );

    const coordinator = new Phase2ShadowCoordinator({ adapter, margin, gateway });
    const result = await coordinator.runShadowEntryClip({
      clipId: 'clip-late-cancel',
      strategyId: 'eth-arb',
      direction: 'LONG_BN_SHORT_HL',
      qtyEth: '0.200',
      atMs: clock,
      mode: 'MAKER_TAKER',
      makerLeg: 'BINANCE',
      executeOnSimulator: true,
    });

    expect(result.admitted).toBe(true);
    expect(result.residualExposureEth).toBe('0');
    expect(gateway.submittedRequests).toHaveLength(2);
    expect(gateway.submittedRequests[0]?.time_in_force).toBe('POC');
    expect(gateway.submittedRequests[1]?.qty).toBe('0.075');

    const pocTs = Array.from(gateway.orderTimestamps.values())[0]!;
    expect(pocTs.cancelRequestedTs).not.toBeNull();
    expect(pocTs.cancelConfirmedTs).not.toBeNull();
  });

  it('integrates SimulatedCrossExGateway with real TradingRuntime to recover AMBIGUOUS_SUBMIT_THEN_FILLED & quiesce POC orders', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-phase2-'));
    const config = loadConfig({
      GCT_DATA_DIR: directory,
      GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
    });
    const session = new TradingSession();
    session.set('live');
    const database = openDatabase(config.databasePath, config.migrationsDir);
    runtimeCleanups.push({ database, directory });

    const vault = new MemoryCredentialVault();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'sim-key', apiSecret: 'sim-secret' });

    const gateway = new SimulatedCrossExGateway();
    gateway.enqueueFaultScript(
      { kind: 'AMBIGUOUS_SUBMIT_THEN_FILLED', fillQty: '0.100', fillPrice: '3000.50' },
      { kind: 'RESTING_POC' },
    );

    const runtime = new TradingRuntime(database, session, vault, gateway, {
      submitResolvePollMs: 10,
      submitResolveMaxAttempts: 20,
    });

    // 1. Ambiguous submit error -> createOrder rethrows while persisting PENDING_SUBMIT and scheduling remote polling to FILLED
    await expect(runtime.createOrder({
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: '0.100',
      price: '3001.00',
    })).rejects.toThrow('UPSTREAM_GATEWAY_TIMEOUT');
    const ambiguous = runtime.listOrders()[0]!;
    expect(['PENDING_SUBMIT', 'FILLED']).toContain(ambiguous.state);
    const resolved = await runtime.awaitTerminalOrder(ambiguous.id, 2_000);
    expect(resolved.state).toBe('FILLED');
    expect(resolved.executedQuantity).toBe('0.1');

    // 2. Resting POC canceled cleanly via runtime.quiesceOpenOrders
    const resting = await runtime.createOrder({
      symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
      side: 'SELL',
      type: 'LIMIT',
      timeInForce: 'POC',
      quantity: '0.100',
      price: '3002.00',
    });
    expect(resting.state).toBe('NEW');
    const quiesced = await runtime.quiesceOpenOrders();
    expect(quiesced.resolved).toHaveLength(1);
    const refreshed = await runtime.getOrder(resting.id);
    expect(refreshed?.state).toBe('CANCELLED');
  });
});

describe('Phase 2 Funding Strategy Path Simulator', () => {
  it('compares point-in-time predicted hold EV vs close cost and settles exclusively from actual settled records', () => {
    const holdEval = evaluateFundingStrategyPathComparison({
      qtyEth: '0.500',
      direction: 'LONG_BN_SHORT_HL',
      bnPred: {
        type: 'funding_pred',
        venue: 'BINANCE',
        recvSeq: 1,
        recvTs: 1_000,
        source: 'bn_premium_index',
        symbol: 'BINANCE_FUTURE_ETH_USDT',
        markPrice: '3000',
        indexOrOraclePrice: '3000',
        fundingRate: '0.0001',
        nextFundingTime: 28_800_000,
        nextFundingTimeSource: 'api_premium_index',
        intervalHours: 8,
        intervalSource: 'api_funding_info',
      },
      hlPred: {
        type: 'funding_pred',
        venue: 'HYPERLIQUID',
        recvSeq: 2,
        recvTs: 1_000,
        source: 'hl_meta_ctx',
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        fundingRate: '0.0010',
        nextFundingTime: 3_600_000,
        nextFundingTimeSource: 'derived_utc_hour',
        markPrice: '3000',
        indexOrOraclePrice: '3000',
        intervalHours: 1,
        intervalSource: 'protocol_hourly_spec',
      },
      fxRate: '1.0000',
      currentCloseSpreadCostUsd: '0.90',
      projectedNextCloseSpreadCostUsd: '0.20',
      borrowingCostPerHourUsd: '0.05',
      settledDuringHold: [
        {
          type: 'funding_settled',
          venue: 'HYPERLIQUID',
          recvSeq: 3,
          recvTs: 500,
          source: 'hl_funding_history_api',
          symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
          settlementTime: 0,
          fundingRate: '0.0020',
          markPrice: null,
          premium: null,
          nearestOraclePriceUsdc: null,
          nearestOraclePriceTs: null,
          nearestFxUsdcUsdt: null,
          nearestFxTs: null,
          nearestFxSource: null,
          isHistoricalBackfill: true,
        },
        {
          type: 'funding_settled',
          venue: 'HYPERLIQUID',
          recvSeq: 4,
          recvTs: 3_600_000,
          source: 'hl_funding_history_api',
          symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
          settlementTime: 3_600_000,
          fundingRate: '0.0010',
          markPrice: null,
          premium: null,
          nearestOraclePriceUsdc: '3000',
          nearestOraclePriceTs: 3_599_000,
          nearestFxUsdcUsdt: '1.0000',
          nearestFxTs: 3_599_000,
          nearestFxSource: 'gate_spot_ticker',
          isHistoricalBackfill: false,
        },
      ],
    });

    // BN hourly = -(0.5*3000*0.0001)/8 = -0.01875; HL hourly = +(0.5*3000*0.001) = +1.50; borrow -0.05 -> 1.43125
    // holdEv = 1.43125 - 0.20 = 1.23125 > closeNowEv = -0.90 -> HOLD
    expect(holdEval.decision).toBe('HOLD');
    expect(holdEval.predictedNetNextPeriodUsd).toBe('1.43125');
    // Only non-backfill settlement (1.50 USD) is counted
    expect(holdEval.realizedSettledFundingUsd).toBe('1.5');

    const exitEval = evaluateFundingStrategyPathComparison({
      qtyEth: '0.500',
      direction: 'LONG_BN_SHORT_HL',
      bnPred: {
        type: 'funding_pred',
        venue: 'BINANCE',
        recvSeq: 1,
        recvTs: 1_000,
        source: 'bn_premium_index',
        symbol: 'BINANCE_FUTURE_ETH_USDT',
        markPrice: '3000',
        indexOrOraclePrice: '3000',
        fundingRate: '0.0008',
        nextFundingTime: 28_800_000,
        nextFundingTimeSource: 'api_premium_index',
        intervalHours: 8,
        intervalSource: 'api_funding_info',
      },
      hlPred: {
        type: 'funding_pred',
        venue: 'HYPERLIQUID',
        recvSeq: 2,
        recvTs: 1_000,
        source: 'hl_meta_ctx',
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        fundingRate: '0.0001',
        nextFundingTime: 3_600_000,
        nextFundingTimeSource: 'derived_utc_hour',
        markPrice: '3000',
        indexOrOraclePrice: '3000',
        intervalHours: 1,
        intervalSource: 'protocol_hourly_spec',
      },
      fxRate: '1.0000',
      currentCloseSpreadCostUsd: '0.05',
      projectedNextCloseSpreadCostUsd: '0.15',
      borrowingCostPerHourUsd: '0.05',
    });
    expect(exitEval.decision).toBe('EXIT');
  });
});
