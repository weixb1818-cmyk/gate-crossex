import type { BinanceBridgeProof, PriceLevel } from './orderbook-state.js';

export type RecorderVenue = 'BINANCE' | 'HYPERLIQUID' | 'CROSSEX';

export interface CrossExSymbolRuleMeta {
  symbol: string;
  exchangeType: string;
  businessType: string;
  state: string;
  minSize: string;
  minNotional: string | null;
  lotSize: string;
  tickSize: string;
  maxMarketSize: string | null;
  maxLimitSize: string | null;
  contractSize: string | null;
}

export interface CaptureCatalogMeta {
  fetchedAt: string;
  asset: 'ETH';
  commonLotStep: string;
  commonMinNotionalUsd: string;
  unitMultiplier: '1';
  crossexRules: CrossExSymbolRuleMeta[];
  binanceExchangeInfo?: {
    symbol: string;
    stepSize: string;
    tickSize: string;
    minQty: string;
    minNotional: string | null;
  };
  hyperliquidMeta?: {
    coin: string;
    szDecimals: number;
    maxLeverage: number;
  };
}

export interface RecorderEndpointsConfig {
  binanceWsUrl: string;
  binanceStreamName: string;
  binanceRestDepthUrl: string;
  binancePremiumIndexUrl: string;
  binanceFundingRateUrl: string;
  binanceExchangeInfoUrl: string;
  hyperliquidWsUrl: string;
  hyperliquidInfoUrl: string;
  crossexWsUrl: string;
  crossexRuleSymbolsUrl: string;
  fxSpotUrl: string;
}

export interface SessionMetaEvent {
  type: 'session_meta';
  recvSeq: number;
  recvTs: number;
  startedAtIso: string;
  proxyStrippedKeys: string[];
  endpoints: RecorderEndpointsConfig;
  catalog: CaptureCatalogMeta;
}

export interface ConnectionLifecycleEvent {
  type: 'conn_event';
  venue: RecorderVenue;
  connGen: number;
  recvSeq: number;
  recvTs: number;
  status: 'open' | 'close' | 'error' | 'injected_disconnect';
  url: string;
  detail?: string;
}

export interface BinanceDepthDeltaRecorded {
  type: 'bn_depth_delta';
  connGen: number;
  recvSeq: number;
  recvTs: number;
  stream: string;
  eventTime: number;
  transactionTime?: number;
  U: string;
  u: string;
  pu: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface BinanceDepthSnapshotRecorded {
  type: 'bn_depth_snapshot';
  connGen: number;
  recvSeq: number;
  recvTs: number;
  lastUpdateId: string;
  eventTime?: number;
  transactionTime?: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface BinanceBookStateRecorded {
  type: 'bn_book_state';
  connGen: number;
  recvSeq: number;
  recvTs: number;
  event: 'bridge_ready' | 'bridge_failed_refetch' | 'sequence_gap' | 'resync_started' | 'duplicate_ignored';
  detail: Record<string, unknown> | BinanceBridgeProof;
}

export interface HyperliquidL2BookRecorded {
  type: 'hl_l2book';
  connGen: number;
  recvSeq: number;
  recvTs: number;
  sourceTs: number;
  coin: string;
  bidLevels: number;
  askLevels: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface HyperliquidBookStateRecorded {
  type: 'hl_book_state';
  connGen: number;
  recvSeq: number;
  recvTs: number;
  event: 'applied' | 'stale_backward_ignored' | 'duplicate_timestamp_ignored';
  firstForConnection: boolean;
  sourceTs: number;
  lastSourceTs?: number;
  bidLevels?: number;
  askLevels?: number;
}

export interface CrossExRawRecorded {
  type: 'cx_raw';
  connGen: number;
  recvSeq: number;
  recvTs: number;
  channel: 'ticker' | 'funding_rate' | 'order_book_update';
  symbol: string;
  payload: Record<string, unknown>;
}

export interface FundingPredictionRecorded {
  type: 'funding_pred';
  venue: 'BINANCE' | 'HYPERLIQUID';
  recvSeq: number;
  recvTs: number;
  source: 'bn_premium_index' | 'hl_meta_ctx';
  symbol: string;
  fundingRate: string;
  nextFundingTime: number;
  intervalHours: number;
  markPrice: string;
  indexOrOraclePrice: string;
}

export interface FundingSettledRecorded {
  type: 'funding_settled';
  venue: 'BINANCE' | 'HYPERLIQUID';
  recvSeq: number;
  recvTs: number;
  source: 'bn_funding_rate_api' | 'hl_funding_history_api';
  symbol: string;
  settlementTime: number;
  fundingRate: string;
  referencePriceOrPremium: string | null;
}

export interface FxRateRecorded {
  type: 'fx_rate';
  recvSeq: number;
  recvTs: number;
  pair: 'USDC_USDT';
  rate: string;
  source: 'gate_spot_ticker' | 'binance_spot_ticker' | 'parity_fallback';
}

export type RecordedMarketEvent =
  | SessionMetaEvent
  | ConnectionLifecycleEvent
  | BinanceDepthDeltaRecorded
  | BinanceDepthSnapshotRecorded
  | BinanceBookStateRecorded
  | HyperliquidL2BookRecorded
  | HyperliquidBookStateRecorded
  | CrossExRawRecorded
  | FundingPredictionRecorded
  | FundingSettledRecorded
  | FxRateRecorded;
