import { mkdirSync, createWriteStream, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import WebSocket from 'ws';
import {
  BinanceOrderBookStateMachine,
  HyperliquidOrderBookStateMachine,
  type PriceLevel,
} from './orderbook-state.js';
import { stripProcessProxyEnv } from './proxy-free.js';
import type {
  CaptureCatalogMeta,
  CrossExSymbolRuleMeta,
  RecordedMarketEvent,
  RecorderEndpointsConfig,
} from './types.js';

export const DEFAULT_PHASE1_ENDPOINTS: RecorderEndpointsConfig = {
  binanceWsUrl: 'wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms',
  binanceStreamName: 'ethusdt@depth@100ms',
  binanceRestDepthUrl: 'https://fapi.binance.com/fapi/v1/depth?symbol=ETHUSDT&limit=1000',
  binancePremiumIndexUrl: 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT',
  binanceFundingRateUrl: 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=30',
  binanceExchangeInfoUrl: 'https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=ETHUSDT',
  hyperliquidWsUrl: 'wss://api.hyperliquid.xyz/ws',
  hyperliquidInfoUrl: 'https://api.hyperliquid.xyz/info',
  crossexWsUrl: 'wss://api.gateio.ws/ws/crossex/public',
  crossexRuleSymbolsUrl: 'https://api.gateio.ws/api/v4/crossex/rule/symbols',
  fxSpotUrl: 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=USDC_USDT',
};

export interface RecorderOptions {
  outputDir: string;
  durationMs?: number;
  injectDisconnectAtMs?: number;
  fundingPollIntervalMs?: number;
  endpoints?: Partial<RecorderEndpointsConfig>;
  includeCrossexBypass?: boolean;
  onEvent?: (event: RecordedMarketEvent) => void;
}

export interface RecorderRunSummary {
  outputDir: string;
  eventsPath: string;
  manifestPath: string;
  startedAtIso: string;
  endedAtIso: string;
  durationMs: number;
  totalEvents: number;
  countsByType: Record<string, number>;
  catalog: CaptureCatalogMeta;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent': 'gate-crossex-phase1-recorder/1.0',
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPhase1CatalogMeta(endpoints: RecorderEndpointsConfig): Promise<CaptureCatalogMeta> {
  const targetSymbols = new Set([
    'BINANCE_FUTURE_ETH_USDT',
    'HYPERLIQUID_FUTURE_ETH_USDC',
    'GATE_FUTURE_ETH_USDT',
  ]);
  const [rawCrossEx, rawBinanceInfo, rawHlMeta] = await Promise.all([
    fetchJsonWithTimeout<unknown>(endpoints.crossexRuleSymbolsUrl),
    fetchJsonWithTimeout<{ symbols?: Array<{ symbol: string; filters?: Array<Record<string, string>> }> }>(
      endpoints.binanceExchangeInfoUrl,
    ),
    fetchJsonWithTimeout<[ { universe?: Array<{ name: string; szDecimals: number; maxLeverage: number }> }, unknown[] ]>(
      endpoints.hyperliquidInfoUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      },
    ),
  ]);

  const cxList = Array.isArray(rawCrossEx)
    ? rawCrossEx
    : ((rawCrossEx as { results?: unknown[] }).results ?? []);
  const crossexRules: CrossExSymbolRuleMeta[] = [];
  for (const item of cxList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const symbol = String(row.symbol ?? '');
    if (!targetSymbols.has(symbol)) continue;
    crossexRules.push({
      symbol,
      exchangeType: String(row.exchange_type ?? ''),
      businessType: String(row.business_type ?? ''),
      state: String(row.state ?? ''),
      minSize: String(row.min_size ?? ''),
      minNotional: row.min_notional == null ? null : String(row.min_notional),
      lotSize: String(row.lot_size ?? ''),
      tickSize: String(row.tick_size ?? ''),
      maxMarketSize: row.max_market_size == null ? null : String(row.max_market_size),
      maxLimitSize: row.max_limit_size == null ? null : String(row.max_limit_size),
      contractSize: row.contract_size == null ? null : String(row.contract_size),
    });
  }

  const bnSym = rawBinanceInfo.symbols?.find((s) => s.symbol === 'ETHUSDT');
  const lotFilter = bnSym?.filters?.find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = bnSym?.filters?.find((f) => f.filterType === 'PRICE_FILTER');
  const notionalFilter = bnSym?.filters?.find((f) => f.filterType === 'MIN_NOTIONAL');

  const hlEth = rawHlMeta?.[0]?.universe?.find((u) => u.name === 'ETH');

  const bnCx = crossexRules.find((r) => r.symbol === 'BINANCE_FUTURE_ETH_USDT');
  const hlCx = crossexRules.find((r) => r.symbol === 'HYPERLIQUID_FUTURE_ETH_USDC');
  const lotSteps = [bnCx?.lotSize, hlCx?.lotSize, lotFilter?.stepSize].filter(
    (v): v is string => Boolean(v && new Decimal(v).gt(0)),
  );
  const commonLotStep = lotSteps.length > 0
    ? lotSteps.reduce((max, cur) => (new Decimal(cur).gt(max) ? cur : max))
    : '0.001';
  const notionals = [bnCx?.minNotional, hlCx?.minNotional, notionalFilter?.notional].filter(
    (v): v is string => Boolean(v && new Decimal(v).gt(0)),
  );
  const commonMinNotionalUsd = notionals.length > 0
    ? notionals.reduce((max, cur) => (new Decimal(cur).gt(max) ? cur : max))
    : '20';

  return {
    fetchedAt: new Date().toISOString(),
    asset: 'ETH',
    commonLotStep,
    commonMinNotionalUsd,
    unitMultiplier: '1',
    crossexRules,
    ...(bnSym
      ? {
          binanceExchangeInfo: {
            symbol: bnSym.symbol,
            stepSize: lotFilter?.stepSize ?? '0.001',
            tickSize: priceFilter?.tickSize ?? '0.01',
            minQty: lotFilter?.minQty ?? '0.001',
            minNotional: notionalFilter?.notional ?? null,
          },
        }
      : {}),
    ...(hlEth
      ? {
          hyperliquidMeta: {
            coin: hlEth.name,
            szDecimals: hlEth.szDecimals,
            maxLeverage: hlEth.maxLeverage,
          },
        }
      : {}),
  };
}

/**
 * Multi-source background recorder capturing Binance USD-M, Hyperliquid, and CrossEx
 * raw websocket feeds, periodic funding predictions/settlements, and USDC/USDT FX.
 */
export class Phase1MarketRecorder {
  private readonly endpoints: RecorderEndpointsConfig;
  private readonly bnBook = new BinanceOrderBookStateMachine();
  private readonly hlBook = new HyperliquidOrderBookStateMachine();
  private stream: WriteStream | null = null;
  private recvSeq = 0;
  private totalEvents = 0;
  private countsByType: Record<string, number> = {};
  private stopped = false;

  private bnConnGen = 0;
  private hlConnGen = 0;
  private cxConnGen = 0;

  private bnSocket: WebSocket | null = null;
  private hlSocket: WebSocket | null = null;
  private cxSocket: WebSocket | null = null;

  private bnResyncInFlight = false;
  private bnSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private bnReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hlReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cxReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hlPingTimer: ReturnType<typeof setInterval> | null = null;
  private cxPingTimer: ReturnType<typeof setInterval> | null = null;
  private fundingPollTimer: ReturnType<typeof setInterval> | null = null;

  private seenSettlementKeys = new Set<string>();
  private catalogMeta: CaptureCatalogMeta | null = null;
  private startedAtMs = 0;
  private startedAtIso = '';

  constructor(private readonly options: RecorderOptions) {
    this.endpoints = { ...DEFAULT_PHASE1_ENDPOINTS, ...options.endpoints };
  }

  private emit(event: RecordedMarketEvent): void {
    this.totalEvents += 1;
    this.countsByType[event.type] = (this.countsByType[event.type] ?? 0) + 1;
    this.stream?.write(`${JSON.stringify(event)}\n`);
    this.options.onEvent?.(event);
  }

  private nextSeq(): { recvSeq: number; recvTs: number } {
    this.recvSeq += 1;
    return { recvSeq: this.recvSeq, recvTs: Date.now() };
  }

  async run(): Promise<RecorderRunSummary> {
    const proxyReport = stripProcessProxyEnv();
    mkdirSync(this.options.outputDir, { recursive: true });
    const eventsPath = join(this.options.outputDir, 'events.ndjson');
    const manifestPath = join(this.options.outputDir, 'manifest.json');
    this.stream = createWriteStream(eventsPath, { flags: 'w' });

    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
    this.catalogMeta = await fetchPhase1CatalogMeta(this.endpoints);

    this.emit({
      type: 'session_meta',
      ...this.nextSeq(),
      startedAtIso: this.startedAtIso,
      proxyStrippedKeys: proxyReport.removedKeys,
      endpoints: this.endpoints,
      catalog: this.catalogMeta,
    });

    this.connectBinance();
    this.connectHyperliquid();
    if (this.options.includeCrossexBypass !== false) {
      this.connectCrossexBypass();
    }

    await this.pollFundingAndFx().catch(() => undefined);
    const pollMs = this.options.fundingPollIntervalMs ?? 30_000;
    this.fundingPollTimer = setInterval(() => {
      void this.pollFundingAndFx().catch(() => undefined);
    }, pollMs);
    this.fundingPollTimer.unref?.();

    const injectTimer = this.options.injectDisconnectAtMs !== undefined
      ? setTimeout(() => {
          this.injectDisconnect();
        }, this.options.injectDisconnectAtMs)
      : null;

    if (this.options.durationMs !== undefined && this.options.durationMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), this.options.durationMs);
      });
    } else {
      await new Promise<void>((resolve) => {
        const stopHandler = () => {
          process.off('SIGINT', stopHandler);
          process.off('SIGTERM', stopHandler);
          resolve();
        };
        process.on('SIGINT', stopHandler);
        process.on('SIGTERM', stopHandler);
      });
    }

    if (injectTimer) clearTimeout(injectTimer);
    await this.pollFundingAndFx().catch(() => undefined);
    const summary = await this.stop();
    writeFileSync(manifestPath, JSON.stringify(summary, null, 2));
    return summary;
  }

  injectDisconnect(): void {
    const now = this.nextSeq();
    if (this.bnSocket && this.bnSocket.readyState === WebSocket.OPEN) {
      this.emit({
        type: 'conn_event',
        venue: 'BINANCE',
        connGen: this.bnConnGen,
        ...now,
        status: 'injected_disconnect',
        url: this.endpoints.binanceWsUrl,
        detail: 'Simulated disconnect for Phase 1 recovery verification',
      });
      this.bnSocket.terminate();
    }
    if (this.hlSocket && this.hlSocket.readyState === WebSocket.OPEN) {
      const hlSeq = this.nextSeq();
      this.emit({
        type: 'conn_event',
        venue: 'HYPERLIQUID',
        connGen: this.hlConnGen,
        ...hlSeq,
        status: 'injected_disconnect',
        url: this.endpoints.hyperliquidWsUrl,
        detail: 'Simulated disconnect for Phase 1 recovery verification',
      });
      this.hlSocket.terminate();
    }
  }

  async stop(): Promise<RecorderRunSummary> {
    this.stopped = true;
    if (this.bnSnapshotTimer) clearTimeout(this.bnSnapshotTimer);
    if (this.bnReconnectTimer) clearTimeout(this.bnReconnectTimer);
    if (this.hlReconnectTimer) clearTimeout(this.hlReconnectTimer);
    if (this.cxReconnectTimer) clearTimeout(this.cxReconnectTimer);
    if (this.hlPingTimer) clearInterval(this.hlPingTimer);
    if (this.cxPingTimer) clearInterval(this.cxPingTimer);
    if (this.fundingPollTimer) clearInterval(this.fundingPollTimer);
    this.bnSocket?.close();
    this.hlSocket?.close();
    this.cxSocket?.close();

    if (this.stream) {
      const wsStream = this.stream;
      this.stream = null;
      await new Promise<void>((resolve) => {
        wsStream.end(() => resolve());
      });
    }

    const endedAtMs = Date.now();
    return {
      outputDir: this.options.outputDir,
      eventsPath: join(this.options.outputDir, 'events.ndjson'),
      manifestPath: join(this.options.outputDir, 'manifest.json'),
      startedAtIso: this.startedAtIso,
      endedAtIso: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - this.startedAtMs,
      totalEvents: this.totalEvents,
      countsByType: { ...this.countsByType },
      catalog: this.catalogMeta!,
    };
  }

  private connectBinance(): void {
    if (this.stopped) return;
    const connGen = ++this.bnConnGen;
    const socket = new WebSocket(this.endpoints.binanceWsUrl);
    this.bnSocket = socket;

    socket.on('open', () => {
      if (this.stopped || connGen !== this.bnConnGen) return;
      this.bnBook.onConnectionOpen(connGen);
      this.emit({
        type: 'conn_event',
        venue: 'BINANCE',
        connGen,
        ...this.nextSeq(),
        status: 'open',
        url: this.endpoints.binanceWsUrl,
      });
      if (this.bnSnapshotTimer) clearTimeout(this.bnSnapshotTimer);
      // Buffer ~250ms of deltas first so the REST snapshot bridges cleanly inside the buffer.
      this.bnSnapshotTimer = setTimeout(() => {
        void this.fetchAndBridgeBinanceSnapshot(connGen);
      }, 250);
    });

    socket.on('message', (raw) => {
      if (this.stopped || connGen !== this.bnConnGen) return;
      const stamp = this.nextSeq();
      try {
        const parsed = JSON.parse(raw.toString()) as {
          stream?: string;
          data?: Record<string, unknown>;
          e?: string;
          E?: number;
          T?: number;
          U?: number | string;
          u?: number | string;
          pu?: number | string;
          b?: PriceLevel[];
          a?: PriceLevel[];
        };
        const d = (parsed.data ?? parsed) as Record<string, unknown>;
        if (d.e !== 'depthUpdate') return;
        const U = String(d.U);
        const u = String(d.u);
        const pu = String(d.pu);
        const bids = (d.b ?? []) as PriceLevel[];
        const asks = (d.a ?? []) as PriceLevel[];
        const eventTime = Number(d.E ?? stamp.recvTs);
        const transactionTime = d.T === undefined ? undefined : Number(d.T);

        this.emit({
          type: 'bn_depth_delta',
          connGen,
          ...stamp,
          stream: parsed.stream ?? this.endpoints.binanceStreamName,
          eventTime,
          ...(transactionTime !== undefined ? { transactionTime } : {}),
          U,
          u,
          pu,
          bids,
          asks,
        });

        const res = this.bnBook.onDepthDelta({
          connGen,
          recvSeq: stamp.recvSeq,
          recvTs: stamp.recvTs,
          eventTime,
          ...(transactionTime !== undefined ? { transactionTime } : {}),
          U,
          u,
          pu,
          bids,
          asks,
        });
        if (res.kind === 'bridge_ready') {
          this.emit({ type: 'bn_book_state', connGen, ...this.nextSeq(), event: 'bridge_ready', detail: res.proof });
        } else if (res.kind === 'bridge_failed_refetch') {
          this.emit({
            type: 'bn_book_state',
            connGen,
            ...this.nextSeq(),
            event: 'bridge_failed_refetch',
            detail: res,
          });
          this.scheduleBinanceResync(connGen, 200);
        } else if (res.kind === 'sequence_gap') {
          this.emit({
            type: 'bn_book_state',
            connGen,
            ...this.nextSeq(),
            event: 'sequence_gap',
            detail: res,
          });
          this.bnBook.markGapResyncing();
          this.emit({
            type: 'bn_book_state',
            connGen,
            ...this.nextSeq(),
            event: 'resync_started',
            detail: { reason: 'sequence_gap' },
          });
          this.scheduleBinanceResync(connGen, 200);
        } else if (res.kind === 'duplicate_ignored') {
          this.emit({
            type: 'bn_book_state',
            connGen,
            ...this.nextSeq(),
            event: 'duplicate_ignored',
            detail: res,
          });
        }
      } catch {
        // Ignore malformed frame safely.
      }
    });

    socket.on('error', (err) => {
      if (this.stopped || connGen !== this.bnConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'BINANCE',
        connGen,
        ...this.nextSeq(),
        status: 'error',
        url: this.endpoints.binanceWsUrl,
        detail: err instanceof Error ? err.message : String(err),
      });
    });

    socket.on('close', (code, reason) => {
      if (connGen !== this.bnConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'BINANCE',
        connGen,
        ...this.nextSeq(),
        status: 'close',
        url: this.endpoints.binanceWsUrl,
        detail: `code=${String(code)} reason=${String(reason ?? '')}`,
      });
      if (this.stopped) return;
      this.bnReconnectTimer = setTimeout(() => this.connectBinance(), 600);
      this.bnReconnectTimer.unref?.();
    });
  }

  private scheduleBinanceResync(connGen: number, delayMs: number): void {
    if (this.stopped || connGen !== this.bnConnGen) return;
    if (this.bnSnapshotTimer) clearTimeout(this.bnSnapshotTimer);
    this.bnSnapshotTimer = setTimeout(() => {
      void this.fetchAndBridgeBinanceSnapshot(connGen);
    }, delayMs);
  }

  private async fetchAndBridgeBinanceSnapshot(connGen: number): Promise<void> {
    if (this.stopped || connGen !== this.bnConnGen || this.bnResyncInFlight) return;
    this.bnResyncInFlight = true;
    try {
      const snap = await fetchJsonWithTimeout<{
        lastUpdateId: number | string;
        E?: number;
        T?: number;
        bids: PriceLevel[];
        asks: PriceLevel[];
      }>(this.endpoints.binanceRestDepthUrl);
      if (this.stopped || connGen !== this.bnConnGen) return;
      const stamp = this.nextSeq();
      this.emit({
        type: 'bn_depth_snapshot',
        connGen,
        ...stamp,
        lastUpdateId: String(snap.lastUpdateId),
        ...(snap.E !== undefined ? { eventTime: snap.E } : {}),
        ...(snap.T !== undefined ? { transactionTime: snap.T } : {}),
        bids: snap.bids,
        asks: snap.asks,
      });
      const res = this.bnBook.onRestSnapshot({
        connGen,
        fetchedAtMs: stamp.recvTs,
        lastUpdateId: snap.lastUpdateId,
        bids: snap.bids,
        asks: snap.asks,
      });
      if (res.kind === 'bridge_ready') {
        this.emit({ type: 'bn_book_state', connGen, ...this.nextSeq(), event: 'bridge_ready', detail: res.proof });
      } else if (res.kind === 'bridge_failed_refetch') {
        this.emit({ type: 'bn_book_state', connGen, ...this.nextSeq(), event: 'bridge_failed_refetch', detail: res });
        this.scheduleBinanceResync(connGen, 300);
      }
    } catch {
      if (!this.stopped && connGen === this.bnConnGen) {
        this.scheduleBinanceResync(connGen, 1_000);
      }
    } finally {
      this.bnResyncInFlight = false;
    }
  }

  private connectHyperliquid(): void {
    if (this.stopped) return;
    const connGen = ++this.hlConnGen;
    const socket = new WebSocket(this.endpoints.hyperliquidWsUrl);
    this.hlSocket = socket;

    socket.on('open', () => {
      if (this.stopped || connGen !== this.hlConnGen) return;
      this.hlBook.onConnectionOpen(connGen);
      this.emit({
        type: 'conn_event',
        venue: 'HYPERLIQUID',
        connGen,
        ...this.nextSeq(),
        status: 'open',
        url: this.endpoints.hyperliquidWsUrl,
      });
      socket.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin: 'ETH' },
      }));
      if (this.hlPingTimer) clearInterval(this.hlPingTimer);
      this.hlPingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ method: 'ping' }));
        }
      }, 25_000);
      this.hlPingTimer.unref?.();
    });

    socket.on('message', (raw) => {
      if (this.stopped || connGen !== this.hlConnGen) return;
      const stamp = this.nextSeq();
      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: string;
          data?: {
            coin?: string;
            time?: number;
            levels?: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>];
          };
        };
        if (msg.channel !== 'l2Book' || !msg.data?.levels) return;
        const bids: PriceLevel[] = msg.data.levels[0].map((lvl) => [lvl.px, lvl.sz]);
        const asks: PriceLevel[] = msg.data.levels[1].map((lvl) => [lvl.px, lvl.sz]);
        const sourceTs = Number(msg.data.time ?? stamp.recvTs);

        this.emit({
          type: 'hl_l2book',
          connGen,
          ...stamp,
          sourceTs,
          coin: msg.data.coin ?? 'ETH',
          bidLevels: bids.length,
          askLevels: asks.length,
          bids,
          asks,
        });

        const res = this.hlBook.onSnapshot({
          connGen,
          sourceTs,
          recvTs: stamp.recvTs,
          bids,
          asks,
        });
        if (res.kind === 'applied') {
          this.emit({
            type: 'hl_book_state',
            connGen,
            ...this.nextSeq(),
            event: 'applied',
            firstForConnection: res.firstForConnection,
            sourceTs,
            bidLevels: bids.length,
            askLevels: asks.length,
          });
        } else if (res.kind === 'stale_backward_ignored' || res.kind === 'duplicate_timestamp_ignored') {
          this.emit({
            type: 'hl_book_state',
            connGen,
            ...this.nextSeq(),
            event: res.kind,
            firstForConnection: false,
            sourceTs,
            ...(res.kind === 'stale_backward_ignored' ? { lastSourceTs: res.lastSourceTs } : {}),
          });
        }
      } catch {
        // Ignore non-JSON/pong safely.
      }
    });

    socket.on('error', (err) => {
      if (this.stopped || connGen !== this.hlConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'HYPERLIQUID',
        connGen,
        ...this.nextSeq(),
        status: 'error',
        url: this.endpoints.hyperliquidWsUrl,
        detail: err instanceof Error ? err.message : String(err),
      });
    });

    socket.on('close', (code, reason) => {
      if (this.hlPingTimer) clearInterval(this.hlPingTimer);
      this.hlPingTimer = null;
      if (connGen !== this.hlConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'HYPERLIQUID',
        connGen,
        ...this.nextSeq(),
        status: 'close',
        url: this.endpoints.hyperliquidWsUrl,
        detail: `code=${String(code)} reason=${String(reason ?? '')}`,
      });
      if (this.stopped) return;
      this.hlReconnectTimer = setTimeout(() => this.connectHyperliquid(), 600);
      this.hlReconnectTimer.unref?.();
    });
  }

  private connectCrossexBypass(): void {
    if (this.stopped) return;
    const connGen = ++this.cxConnGen;
    const socket = new WebSocket(this.endpoints.crossexWsUrl);
    this.cxSocket = socket;
    const symbols = [
      'BINANCE_FUTURE_ETH_USDT',
      'HYPERLIQUID_FUTURE_ETH_USDC',
      'GATE_FUTURE_ETH_USDT',
    ];

    socket.on('open', () => {
      if (this.stopped || connGen !== this.cxConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'CROSSEX',
        connGen,
        ...this.nextSeq(),
        status: 'open',
        url: this.endpoints.crossexWsUrl,
      });
      const time = Math.floor(Date.now() / 1_000);
      for (const channel of ['ticker', 'funding_rate', 'order_book_update']) {
        socket.send(JSON.stringify({ time, event: 'subscribe', channel, payload: symbols }));
      }
      if (this.cxPingTimer) clearInterval(this.cxPingTimer);
      this.cxPingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 25_000);
      this.cxPingTimer.unref?.();
    });

    socket.on('message', (raw) => {
      if (this.stopped || connGen !== this.cxConnGen) return;
      const stamp = this.nextSeq();
      try {
        const msg = JSON.parse(raw.toString()) as {
          event?: string;
          channel?: string;
          result?: Record<string, unknown>;
        };
        if (msg.event !== 'update' || !msg.result) return;
        if (
          msg.channel !== 'ticker'
          && msg.channel !== 'funding_rate'
          && msg.channel !== 'order_book_update'
        ) {
          return;
        }
        const symbol = String(msg.result.s ?? '');
        this.emit({
          type: 'cx_raw',
          connGen,
          ...stamp,
          channel: msg.channel,
          symbol,
          payload: msg.result,
        });
      } catch {
        // Ignore malformed frame safely.
      }
    });

    socket.on('error', (err) => {
      if (this.stopped || connGen !== this.cxConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'CROSSEX',
        connGen,
        ...this.nextSeq(),
        status: 'error',
        url: this.endpoints.crossexWsUrl,
        detail: err instanceof Error ? err.message : String(err),
      });
    });

    socket.on('close', (code, reason) => {
      if (this.cxPingTimer) clearInterval(this.cxPingTimer);
      this.cxPingTimer = null;
      if (connGen !== this.cxConnGen) return;
      this.emit({
        type: 'conn_event',
        venue: 'CROSSEX',
        connGen,
        ...this.nextSeq(),
        status: 'close',
        url: this.endpoints.crossexWsUrl,
        detail: `code=${String(code)} reason=${String(reason ?? '')}`,
      });
      if (this.stopped) return;
      this.cxReconnectTimer = setTimeout(() => this.connectCrossexBypass(), 1_000);
      this.cxReconnectTimer.unref?.();
    });
  }

  private async pollFundingAndFx(): Promise<void> {
    const startMs = Math.max(0, this.startedAtMs - 9 * 3600_000);
    const [bnPred, bnSettled, hlMetaCtx, hlHist, fxRes] = await Promise.allSettled([
      fetchJsonWithTimeout<{
        symbol: string;
        markPrice: string;
        indexPrice: string;
        lastFundingRate: string;
        nextFundingTime: number;
      }>(this.endpoints.binancePremiumIndexUrl),
      fetchJsonWithTimeout<Array<{
        symbol: string;
        fundingTime: number;
        fundingRate: string;
        markPrice: string;
      }>>(this.endpoints.binanceFundingRateUrl),
      fetchJsonWithTimeout<[
        { universe: Array<{ name: string }> },
        Array<{ funding: string; markPx: string; oraclePx: string }>
      ]>(this.endpoints.hyperliquidInfoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      }),
      fetchJsonWithTimeout<Array<{
        coin: string;
        fundingRate: string;
        premium: string;
        time: number;
      }>>(this.endpoints.hyperliquidInfoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin: 'ETH', startTime: startMs }),
      }),
      fetchJsonWithTimeout<Array<{ currency_pair: string; last: string }>>(this.endpoints.fxSpotUrl),
    ]);

    if (bnPred.status === 'fulfilled') {
      const p = bnPred.value;
      this.emit({
        type: 'funding_pred',
        venue: 'BINANCE',
        ...this.nextSeq(),
        source: 'bn_premium_index',
        symbol: 'ETHUSDT',
        fundingRate: p.lastFundingRate,
        nextFundingTime: Number(p.nextFundingTime),
        intervalHours: 8,
        markPrice: p.markPrice,
        indexOrOraclePrice: p.indexPrice,
      });
    }

    if (hlMetaCtx.status === 'fulfilled') {
      const idx = hlMetaCtx.value[0].universe.findIndex((u) => u.name === 'ETH');
      const ctx = idx >= 0 ? hlMetaCtx.value[1][idx] : undefined;
      if (ctx) {
        const now = Date.now();
        const nextHour = Math.floor(now / 3_600_000 + 1) * 3_600_000;
        this.emit({
          type: 'funding_pred',
          venue: 'HYPERLIQUID',
          ...this.nextSeq(),
          source: 'hl_meta_ctx',
          symbol: 'ETH',
          fundingRate: ctx.funding,
          nextFundingTime: nextHour,
          intervalHours: 1,
          markPrice: ctx.markPx,
          indexOrOraclePrice: ctx.oraclePx,
        });
      }
    }

    if (bnSettled.status === 'fulfilled') {
      for (const row of bnSettled.value) {
        const key = `BN:${row.fundingTime}`;
        if (this.seenSettlementKeys.has(key)) continue;
        this.seenSettlementKeys.add(key);
        this.emit({
          type: 'funding_settled',
          venue: 'BINANCE',
          ...this.nextSeq(),
          source: 'bn_funding_rate_api',
          symbol: row.symbol,
          settlementTime: Number(row.fundingTime),
          fundingRate: row.fundingRate,
          referencePriceOrPremium: row.markPrice,
        });
      }
    }

    if (hlHist.status === 'fulfilled') {
      for (const row of hlHist.value) {
        const key = `HL:${row.time}`;
        if (this.seenSettlementKeys.has(key)) continue;
        this.seenSettlementKeys.add(key);
        this.emit({
          type: 'funding_settled',
          venue: 'HYPERLIQUID',
          ...this.nextSeq(),
          source: 'hl_funding_history_api',
          symbol: row.coin,
          settlementTime: Number(row.time),
          fundingRate: row.fundingRate,
          referencePriceOrPremium: row.premium,
        });
      }
    }

    if (fxRes.status === 'fulfilled' && fxRes.value[0]?.last) {
      this.emit({
        type: 'fx_rate',
        ...this.nextSeq(),
        pair: 'USDC_USDT',
        rate: fxRes.value[0].last,
        source: 'gate_spot_ticker',
      });
    } else {
      this.emit({
        type: 'fx_rate',
        ...this.nextSeq(),
        pair: 'USDC_USDT',
        rate: '1',
        source: 'parity_fallback',
      });
    }
  }
}
