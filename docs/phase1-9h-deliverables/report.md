# Phase 1 Offline Replay & Audit Report (ETH · Binance USD-M + Hyperliquid)

- **Run ID**: `replay-2026-11-28T07-11-49-879Z`
- **Generated At**: 2026-11-28T07:14:48.437Z
- **Source Capture**: `/home/ubuntu/gatex/gate-crossex/.local-data/phase1/long-run-20261127-1428/events.ndjson`
- **Simulation Mode**: Streaming causal offline replay over native venue order books (read-only)
- **Capture Window**: 2026-11-27T06:28:58.078Z → 2026-11-27T15:28:58.173Z (events processed: 2622792)
- **Binance Streams Used**: wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms | ethusdt@depth@100ms
- **CrossEx Bypass Frames Captured**: 2297179
- **Binance Sequence Gaps**: 0 | **Hyperliquid Stale Backward Rejected**: 0
- **Funding Settlement Records**: live=10 | historicalBackfill=39
- **Cross-Format Same-Price Book Updates**: total=0 (binance=0, hyperliquid=0)

## 1. Fee & Denominator Assumptions

- **Fee Source**: `vip0_fallback` — Native venue fallback fees (not CrossEx account-tier rates): Binance USD-M VIP0 Taker (5 bps) and Hyperliquid Tier-0 Taker (4.5 bps)
- **Binance Contract/Role/Rate**: `BINANCE_FUTURE_ETH_USDT (ETHUSDT)` / `TAKER` / `0.0005`
- **Hyperliquid Contract/Role/Rate**: `HYPERLIQUID_FUTURE_ETH_USDC (ETH)` / `TAKER` / `0.00045`
- **Unique BPS Denominator**: `planned_notional_usdt = Q_plan (0.500 ETH) × long_ref_price_usdt`
- **Capital Budget (Reference Only)**: `2000 USDT` (assumed leverage: `5x`)
- **Entry Thresholds Tested (bps)**: `2, 1`
- **Future Source Clock Tolerance (ms)**: `2000`

## 2. Dual-Leg Freshness Coverage (`coverageByAgeTier`)

| Age Tier | BN Max Recv/Source (ms) | HL Max Recv/Source (ms) | Total Window (ms) | BN Valid (ms) | HL Valid (ms) | Dual Valid Overlap (ms) | Overlap (%) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `hl_15000ms_bn_15000ms` | 15000/15000 | 15000/15000 | 32400095 | 32398863 | 32396515 | 32396066 | 99.99% |
| `hl_10000ms_bn_15000ms` | 15000/15000 | 10000/10000 | 32400095 | 32398863 | 25440786 | 25440337 | 78.52% |
| `hl_5000ms_bn_15000ms` | 15000/15000 | 5000/5000 | 32400095 | 32398863 | 12310409 | 12309960 | 37.99% |

## 3. Summary Comparison Across Age Tiers, Entry Thresholds, and Delays

| Age Tier | Entry (bps) | Strategy | Delay (ms) | Raw Ticks | Raw Cand | Logged Cand | Triggered | Raw Rejects | Completed | Open End | In-Flight End | Unvalued Open | Realized Net (USD) | Mark-to-Close (USD) | Fees (USD) | Funding Net (USD) | Realized Net (bps) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `hl_15000ms_bn_15000ms` | 2 | `bbo_v1` | 0 | 319683 | 162 | 162 | 162 | 50 | 161 | 1 | 0 | 0 | -143.554723 | -1.924975 | 257.397084 | 0.030439 | -10.6633 |
| `hl_15000ms_bn_15000ms` | 2 | `bbo_v1` | 100 | 319683 | 162 | 162 | 162 | 50 | 161 | 1 | 0 | 0 | -143.473566 | -1.924975 | 257.398336 | 0.030439 | -10.6574 |
| `hl_15000ms_bn_15000ms` | 2 | `vwap_taker_v2` | 0 | 319683 | 51635 | 5229 | 53 | 51632 | 52 | 1 | 0 | 0 | 11.041193 | -1.099563 | 84.194319 | 0.019589 | 2.5399 |
| `hl_15000ms_bn_15000ms` | 2 | `vwap_taker_v2` | 100 | 319683 | 51627 | 5228 | 53 | 51624 | 52 | 1 | 0 | 0 | 7.811108 | -1.099563 | 84.194892 | 0.019589 | 1.7968 |
| `hl_15000ms_bn_15000ms` | 1 | `bbo_v1` | 0 | 319683 | 191 | 191 | 191 | 50 | 190 | 1 | 0 | 0 | -189.606197 | -1.924975 | 303.612605 | 0.030439 | -11.9287 |
| `hl_15000ms_bn_15000ms` | 1 | `bbo_v1` | 100 | 319683 | 189 | 189 | 189 | 50 | 188 | 1 | 0 | 0 | -186.710376 | -1.924975 | 300.337401 | 0.030439 | -11.8754 |
| `hl_15000ms_bn_15000ms` | 1 | `vwap_taker_v2` | 0 | 319683 | 52303 | 5286 | 53 | 52300 | 52 | 1 | 0 | 0 | 11.041193 | -1.099563 | 84.194319 | 0.019589 | 2.5399 |
| `hl_15000ms_bn_15000ms` | 1 | `vwap_taker_v2` | 100 | 319683 | 52291 | 5284 | 53 | 52288 | 52 | 1 | 0 | 0 | 7.811108 | -1.099563 | 84.194892 | 0.019589 | 1.7968 |
| `hl_10000ms_bn_15000ms` | 2 | `bbo_v1` | 0 | 319683 | 123 | 123 | 123 | 68100 | 122 | 1 | 0 | 0 | -101.019308 | -1.644867 | 195.613857 | 0.030439 | -9.8928 |
| `hl_10000ms_bn_15000ms` | 2 | `bbo_v1` | 100 | 319683 | 122 | 122 | 121 | 68099 | 120 | 1 | 0 | 0 | -98.511828 | -1.699895 | 192.443391 | 0.030439 | -9.8076 |
| `hl_10000ms_bn_15000ms` | 2 | `vwap_taker_v2` | 0 | 319683 | 23909 | 2578 | 40 | 91969 | 39 | 1 | 0 | 0 | 8.500614 | -1.124607 | 63.57966 | 0.019589 | 2.6053 |
| `hl_10000ms_bn_15000ms` | 2 | `vwap_taker_v2` | 100 | 319683 | 24307 | 2622 | 39 | 92367 | 38 | 1 | 0 | 0 | 8.386137 | -1.124607 | 61.982009 | 0.019589 | 2.6382 |
| `hl_10000ms_bn_15000ms` | 1 | `bbo_v1` | 0 | 319683 | 147 | 147 | 147 | 68100 | 146 | 1 | 0 | 0 | -140.93823 | -1.644867 | 233.81749 | 0.030439 | -11.5313 |
| `hl_10000ms_bn_15000ms` | 1 | `bbo_v1` | 100 | 319683 | 145 | 145 | 145 | 68099 | 144 | 1 | 0 | 0 | -137.789062 | -1.699895 | 230.595186 | 0.030439 | -11.4323 |
| `hl_10000ms_bn_15000ms` | 1 | `vwap_taker_v2` | 0 | 319683 | 24363 | 2620 | 40 | 92423 | 39 | 1 | 0 | 0 | 8.500614 | -1.124607 | 63.57966 | 0.019589 | 2.6053 |
| `hl_10000ms_bn_15000ms` | 1 | `vwap_taker_v2` | 100 | 319683 | 24786 | 2663 | 39 | 92846 | 38 | 1 | 0 | 0 | 8.386137 | -1.124607 | 61.982009 | 0.019589 | 2.6382 |
| `hl_5000ms_bn_15000ms` | 2 | `bbo_v1` | 0 | 319683 | 52 | 52 | 52 | 196660 | 51 | 1 | 0 | 0 | -38.484527 | -2.015779 | 82.87753 | 0.030439 | -8.9925 |
| `hl_5000ms_bn_15000ms` | 2 | `bbo_v1` | 100 | 319683 | 49 | 49 | 49 | 196659 | 48 | 1 | 0 | 0 | -36.313036 | -1.645197 | 78.096151 | 0.030439 | -9.0157 |
| `hl_5000ms_bn_15000ms` | 2 | `vwap_taker_v2` | 0 | 319683 | 60092 | 6491 | 21 | 256731 | 20 | 1 | 0 | 0 | 4.947159 | -1.124607 | 33.425995 | -0.01287 | 2.9518 |
| `hl_5000ms_bn_15000ms` | 2 | `vwap_taker_v2` | 100 | 319683 | 59952 | 6473 | 20 | 256591 | 19 | 1 | 0 | 0 | 5.01868 | -1.124607 | 31.813932 | -0.01287 | 3.1545 |
| `hl_5000ms_bn_15000ms` | 1 | `bbo_v1` | 0 | 319683 | 63 | 63 | 63 | 196660 | 62 | 1 | 0 | 0 | -52.628669 | -2.015779 | 100.448521 | 0.030439 | -10.1122 |
| `hl_5000ms_bn_15000ms` | 1 | `bbo_v1` | 100 | 319683 | 59 | 59 | 58 | 196659 | 57 | 1 | 0 | 0 | -48.455357 | -1.645197 | 92.417284 | 0.030439 | -10.1338 |
| `hl_5000ms_bn_15000ms` | 1 | `vwap_taker_v2` | 0 | 319683 | 60274 | 6511 | 21 | 256913 | 20 | 1 | 0 | 0 | 4.947159 | -1.124607 | 33.425995 | -0.01287 | 2.9518 |
| `hl_5000ms_bn_15000ms` | 1 | `vwap_taker_v2` | 100 | 319683 | 60114 | 6492 | 20 | 256753 | 19 | 1 | 0 | 0 | 5.01868 | -1.124607 | 31.813932 | -0.01287 | 3.1545 |

## 4. End-of-Window In-Flight Orders & Unvalued Positions

### 4.1 In-Flight Orders At End (`inFlightOrdersAtEnd`)
```json
[]
```

### 4.2 Unvalued Open Positions (`unvaluedOpenPositions`)
```json
[]
```

## 5. Required Audit Proofs & Examples

### 5.1 Binance Snapshot Bridge & Resync Trace
```json
{
  "initialBridge": {
    "connGen": 1,
    "snapshotLastUpdateId": "12254968038883",
    "droppedPreSnapshotCount": 2,
    "bridgeEvent": {
      "U": "12254968036412",
      "u": "12254968041630",
      "pu": "12254968036310",
      "recvSeq": 71,
      "recvTs": 1795760938421
    },
    "appliedBufferedCount": 1,
    "bidLevels": 1011,
    "askLevels": 1004,
    "bestBid": "1736.14",
    "bestAsk": "1736.15"
  },
  "allBridges": [
    {
      "connGen": 1,
      "snapshotLastUpdateId": "12254968038883",
      "droppedPreSnapshotCount": 2,
      "bridgeEvent": {
        "U": "12254968036412",
        "u": "12254968041630",
        "pu": "12254968036310",
        "recvSeq": 71,
        "recvTs": 1795760938421
      },
      "appliedBufferedCount": 1,
      "bidLevels": 1011,
      "askLevels": 1004,
      "bestBid": "1736.14",
      "bestAsk": "1736.15"
    },
    {
      "connGen": 2,
      "snapshotLastUpdateId": "12255166948778",
      "droppedPreSnapshotCount": 1,
      "bridgeEvent": {
        "U": "12255166943824",
        "u": "12255166948778",
        "pu": "12255166943758",
        "recvSeq": 124460,
        "recvTs": 1795762739015
      },
      "appliedBufferedCount": 1,
      "bidLevels": 1010,
      "askLevels": 1005,
      "bestBid": "1734.60",
      "bestAsk": "1734.61"
    }
  ],
  "gaps": []
}
```

### 5.2 Hyperliquid First Valid Snapshot After Reconnect
```json
{
  "recvTs": 1795762738813,
  "connGen": 2,
  "sourceTs": 1795762738460,
  "bidLevels": 20,
  "askLevels": 20
}
```

### 5.3 Same Opportunity Under `0 ms` vs `100 ms` Delay
```json
{
  "opportunityId": "bbo_v1-0ms-0001",
  "direction": "LONG_BN_SHORT_HL",
  "decisionTs": 1795760938421,
  "zeroMs": {
    "delayMs": 0,
    "delayModel": "zero_delay_last_synced_book",
    "decisionTs": 1795760938421,
    "arrivalTs": 1795760938421,
    "executable": true,
    "rejectReason": null,
    "longFill": {
      "venue": "BINANCE",
      "symbol": "BINANCE_FUTURE_ETH_USDT",
      "side": "BUY",
      "qtyEth": "0.500",
      "avgPriceNative": "1736.15",
      "priceCurrency": "USDT",
      "fxAtExec": "1",
      "fxSource": "native_usdt",
      "avgPriceUsdt": "1736.15",
      "feeRate": "0.0005",
      "feeNative": "0.4340375",
      "feeUsdt": "0.4340375",
      "execTs": 1795760938421,
      "bookSourceTs": 1795760938419,
      "bookRecvTs": 1795760938421,
      "levelsUsed": 1
    },
    "shortFill": {
      "venue": "HYPERLIQUID",
      "symbol": "HYPERLIQUID_FUTURE_ETH_USDC",
      "side": "SELL",
      "qtyEth": "0.500",
      "avgPriceNative": "1735.9",
      "priceCurrency": "USDC",
      "fxAtExec": "1.00127",
      "fxSource": "gate_spot_ticker",
      "avgPriceUsdt": "1738.104593",
      "feeRate": "0.00045",
      "feeNative": "0.3905775",
      "feeUsdt": "0.39107353",
      "execTs": 1795760938421,
      "bookSourceTs": 1795760937598,
      "bookRecvTs": 1795760938184,
      "levelsUsed": 1
    },
    "entrySpreadBpsAtArrival": "11.2582",
    "entrySpreadUsdAtArrival": "0.9772965",
    "entryFeesUsd": "0.82511103"
  },
  "hundredMs": {
    "delayMs": 100,
    "delayModel": "fixed_one_way_delay_100ms_per_leg",
    "decisionTs": 1795760938421,
    "arrivalTs": 1795760938521,
    "executable": true,
    "rejectReason": null,
    "longFill": {
      "venue": "BINANCE",
      "symbol": "BINANCE_FUTURE_ETH_USDT",
      "side": "BUY",
      "qtyEth": "0.500",
      "avgPriceNative": "1736.15",
      "priceCurrency": "USDT",
      "fxAtExec": "1",
      "fxSource": "native_usdt",
      "avgPriceUsdt": "1736.15",
      "feeRate": "0.0005",
      "feeNative": "0.4340375",
      "feeUsdt": "0.4340375",
      "execTs": 1795760938521,
      "bookSourceTs": 1795760938419,
      "bookRecvTs": 1795760938421,
      "levelsUsed": 1
    },
    "shortFill": {
      "venue": "HYPERLIQUID",
      "symbol": "HYPERLIQUID_FUTURE_ETH_USDC",
      "side": "SELL",
      "qtyEth": "0.500",
      "avgPriceNative": "1735.9",
      "priceCurrency": "USDC",
      "fxAtExec": "1.00127",
      "fxSource": "gate_spot_ticker",
      "avgPriceUsdt": "1738.104593",
      "feeRate": "0.00045",
      "feeNative": "0.3905775",
      "feeUsdt": "0.39107353",
      "execTs": 1795760938521,
      "bookSourceTs": 1795760937598,
      "bookRecvTs": 1795760938184,
      "levelsUsed": 1
    },
    "entrySpreadBpsAtArrival": "11.2582",
    "entrySpreadUsdAtArrival": "0.9772965",
    "entryFeesUsd": "0.82511103"
  }
}
```

### 5.4 Hand-Verifiable Trade / Native Contract PnL & Funding Sample
```json
{
  "run_id": "replay-2026-11-28T07-11-49-879Z",
  "age_tier": "hl_15000ms_bn_15000ms",
  "entry_bps_threshold": "2",
  "strategy_version": "vwap_taker_v2",
  "delay_ms": 0,
  "delay_model": "zero_delay_last_synced_book",
  "opportunity_id": "vwap_taker_v2-0ms-1849",
  "group_id": "grp-vwap_taker_v2-0ms-0001",
  "asset": "ETH",
  "direction": "LONG_BN_SHORT_HL",
  "long_venue": "BINANCE",
  "short_venue": "HYPERLIQUID",
  "long_symbol": "BINANCE_FUTURE_ETH_USDT",
  "short_symbol": "HYPERLIQUID_FUTURE_ETH_USDC",
  "decision": "TRIGGERED",
  "reject_reason": null,
  "trigger_ts": 1795762827516,
  "exec_arrival_ts": 1795762827516,
  "exit_decision_ts": 1795767457629,
  "exit_exec_arrival_ts": 1795767457629,
  "event_ts_left": 1795762827513,
  "event_ts_right": 1795762815573,
  "recv_ts_left": 1795762827516,
  "recv_ts_right": 1795762815916,
  "budget_usdt": "2000",
  "planned_qty": "0.500",
  "actual_filled_qty": "0.500",
  "unit_multiplier_normalized": "1",
  "long_ref_price_usdt": "1732.18",
  "planned_notional_usdt": "866.09",
  "denominator_rule": "planned_notional_usdt = Q_plan * long_ref_price_in_usdt",
  "fx_usdc_usdt": "1.0013",
  "fx_source": "gate_spot_ticker",
  "fee_source": "vip0_fallback",
  "fee_assumption_detail": "BINANCE_FUTURE_ETH_USDT (ETHUSDT) 0.0005; HYPERLIQUID_FUTURE_ETH_USDC (ETH) 0.00045",
  "exit_assumption": "Pre-trade scenario only: takeProfitBps(0) + exitDepthBuffer(1 bps)",
  "bbo_entry_spread_bps": "20.6304",
  "vwap_entry_spread_bps": "20.6304",
  "est_exit_spread_bps": "1",
  "entry_long_fill": {
    "venue": "BINANCE",
    "symbol": "BINANCE_FUTURE_ETH_USDT",
    "side": "BUY",
    "qtyEth": "0.500",
    "avgPriceNative": "1732.18",
    "priceCurrency": "USDT",
    "fxAtExec": "1",
    "fxSource": "native_usdt",
    "avgPriceUsdt": "1732.18",
    "feeRate": "0.0005",
    "feeNative": "0.433045",
    "feeUsdt": "0.433045",
    "execTs": 1795762827516,
    "bookSourceTs": 1795762827513,
    "bookRecvTs": 1795762827516,
    "levelsUsed": 1
  },
  "entry_short_fill": {
    "venue": "HYPERLIQUID",
    "symbol": "HYPERLIQUID_FUTURE_ETH_USDC",
    "side": "SELL",
    "qtyEth": "0.500",
    "avgPriceNative": "1733.5",
    "priceCurrency": "USDC",
    "fxAtExec": "1.0013",
    "fxSource": "gate_spot_ticker",
    "avgPriceUsdt": "1735.75355",
    "feeRate": "0.00045",
    "feeNative": "0.3900375",
    "feeUsdt": "0.39054455",
    "execTs": 1795762827516,
    "bookSourceTs": 1795762815573,
    "bookRecvTs": 1795762815916,
    "levelsUsed": 1
  },
  "exit_long_fill": {
    "venue": "BINANCE",
    "symbol": "BINANCE_FUTURE_ETH_USDT",
    "side": "SELL",
    "qtyEth": "0.500",
    "avgPriceNative": "1740.71",
    "priceCurrency": "USDT",
    "fxAtExec": "1",
    "fxSource": "native_usdt",
    "avgPriceUsdt": "1740.71",
    "feeRate": "0.0005",
    "feeNative": "0.4351775",
    "feeUsdt": "0.4351775",
    "execTs": 1795767457629,
    "bookSourceTs": 1795767457467,
    "bookRecvTs": 1795767457629,
    "levelsUsed": 1
  },
  "exit_short_fill": {
    "venue": "HYPERLIQUID",
    "symbol": "HYPERLIQUID_FUTURE_ETH_USDC",
    "side": "BUY",
    "qtyEth": "0.500",
    "avgPriceNative": "1738.3",
    "priceCurrency": "USDC",
    "fxAtExec": "1.00126",
    "fxSource": "gate_spot_ticker",
    "avgPriceUsdt": "1740.490258",
    "feeRate": "0.00045",
    "feeNative": "0.3911175",
    "feeUsdt": "0.39161031",
    "execTs": 1795767457629,
    "bookSourceTs": 1795767455619,
    "bookRecvTs": 1795767455911,
    "levelsUsed": 1
  },
  "bn_contract_pnl_usdt": "4.265",
  "hl_contract_pnl_usdc": "-2.4",
  "hl_contract_pnl_usdt": "-2.403024",
  "contract_spread_pnl_usd": "1.861976",
  "collateral_fx_pnl_usd": "0",
  "collateral_fx_note": "offline_collateral_fx_pnl_assumed_zero_no_wallet_balance",
  "fees_4leg_usd": "1.65037736",
  "funding_events_crossed": 2,
  "funding_net_usd": "-0.05556374",
  "funding_legs": [
    {
      "venue": "BINANCE",
      "settlementTime": 1795766400001,
      "fundingRate": "0.00007048",
      "qtyEth": "0.500",
      "refPriceNative": "1734.64503876",
      "priceCurrency": "USDT",
      "priceSource": "settlement_mark_price",
      "fxRate": "1",
      "fxSource": "native_usdt",
      "cashflowNative": "-0.06112889",
      "cashflowUsdt": "-0.06112889"
    },
    {
      "venue": "HYPERLIQUID",
      "settlementTime": 1795766400029,
      "fundingRate": "0.0000064069",
      "qtyEth": "0.500",
      "refPriceNative": "1735.05",
      "priceCurrency": "USDC",
      "priceSource": "settlement_nearest_oracle",
      "fxRate": "1.00126",
      "fxSource": "gate_spot_ticker",
      "cashflowNative": "0.00555815",
      "cashflowUsdt": "0.00556515"
    }
  ],
  "borrowing_cost_est_usd": "0",
  "borrowing_note": "offline_borrowing_assumed_zero_no_wallet_liability",
  "roundtrip_net_pnl_usd": "0.1560349",
  "roundtrip_net_bps": "1.8016",
  "budget_roi_pct": "0.0078",
  "is_open_at_end": false,
  "mark_to_close_usd": null,
  "unvalued_qty": "0",
  "max_naked_leg_ms": "0",
  "rest_queue_wait_ms": null,
  "margin_used_est_usd": "346.436",
  "margin_used_actual_usd": null,
  "book_gap_count": 0,
  "manual_intervention_count": 0,
  "manual_notes": "Simultaneous dual-taker assumption (0ms skew between legs) under zero_delay_last_synced_book"
}
```

