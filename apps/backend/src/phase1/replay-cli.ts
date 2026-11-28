import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  DEFAULT_REPLAY_CONFIG,
  DEFAULT_VIP0_FEES,
  buildVariantHourlyBreakdown,
  computeCounterfactualFeeImpactOnFixedTrades,
  resolveFeeScheduleFromSnapshot,
  runPhase1ReplayStream,
  type CounterfactualFeeRowImpact,
  type HourlyBreakdownEntry,
  type ReplaySuiteResult,
  type SanitizedFeeSnapshotInput,
  type TradeScorecardRow,
} from './replay.js';

function readArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseStringList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw) return [...fallback];
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

function parseNumberList(raw: string | undefined, fallback: readonly number[]): number[] {
  if (!raw) return [...fallback];
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

const SCORECARD_CSV_HEADERS = [
  'run_id',
  'age_tier',
  'entry_bps_threshold',
  'strategy_version',
  'delay_ms',
  'delay_model',
  'opportunity_id',
  'group_id',
  'asset',
  'direction',
  'long_venue',
  'short_venue',
  'long_symbol',
  'short_symbol',
  'decision',
  'reject_reason',
  'trigger_ts',
  'exec_arrival_ts',
  'exit_decision_ts',
  'exit_exec_arrival_ts',
  'event_ts_left',
  'event_ts_right',
  'recv_ts_left',
  'recv_ts_right',
  'budget_usdt',
  'planned_qty',
  'actual_filled_qty',
  'unit_multiplier_normalized',
  'long_ref_price_usdt',
  'planned_notional_usdt',
  'fx_usdc_usdt',
  'fx_source',
  'fee_source',
  'bbo_entry_spread_bps',
  'vwap_entry_spread_bps',
  'est_exit_spread_bps',
  'bn_contract_pnl_usdt',
  'hl_contract_pnl_usdc',
  'hl_contract_pnl_usdt',
  'contract_spread_pnl_usd',
  'collateral_fx_pnl_usd',
  'fees_4leg_usd',
  'funding_events_crossed',
  'funding_net_usd',
  'borrowing_cost_est_usd',
  'roundtrip_net_pnl_usd',
  'roundtrip_net_bps',
  'budget_roi_pct',
  'is_open_at_end',
  'mark_to_close_usd',
  'unvalued_qty',
  'max_naked_leg_ms',
  'rest_queue_wait_ms',
  'margin_used_est_usd',
  'margin_used_actual_usd',
  'book_gap_count',
  'manual_intervention_count',
  'manual_notes',
] as const;

function renderScorecardCsvRow(row: TradeScorecardRow): string {
  return `${SCORECARD_CSV_HEADERS.map((h) => csvEscape(row[h])).join(',')}\n`;
}

const FUNDING_LEGS_CSV_HEADERS = [
  'run_id',
  'age_tier',
  'entry_bps_threshold',
  'strategy_version',
  'delay_ms',
  'opportunity_id',
  'group_id',
  'direction',
  'is_open_at_end',
  'entry_exec_ts',
  'exit_exec_ts',
  'venue',
  'position_side',
  'settlement_time',
  'settlement_time_iso',
  'funding_rate',
  'qty_eth',
  'ref_price_native',
  'price_currency',
  'price_source',
  'fx_rate',
  'fx_source',
  'cashflow_native',
  'cashflow_usdt',
] as const;

function renderFundingLegCsvRows(row: TradeScorecardRow): string[] {
  if (row.decision !== 'TRIGGERED' || row.funding_legs.length === 0) return [];
  return row.funding_legs.map((leg) => {
    const positionSide = leg.venue === row.long_venue ? 'LONG' : 'SHORT';
    const fields = [
      row.run_id,
      row.age_tier,
      row.entry_bps_threshold,
      row.strategy_version,
      row.delay_ms,
      row.opportunity_id,
      row.group_id,
      row.direction,
      row.is_open_at_end,
      row.exec_arrival_ts,
      row.exit_exec_arrival_ts,
      leg.venue,
      positionSide,
      leg.settlementTime,
      new Date(leg.settlementTime).toISOString(),
      leg.fundingRate,
      leg.qtyEth,
      leg.refPriceNative,
      leg.priceCurrency,
      leg.priceSource,
      leg.fxRate,
      leg.fxSource,
      leg.cashflowNative,
      leg.cashflowUsdt,
    ];
    return `${fields.map((v) => csvEscape(v)).join(',')}\n`;
  });
}

export function renderAuditMarkdownReport(
  result: ReplaySuiteResult,
  eventsPath: string,
  extras?: {
    primaryHourlyBreakdown?: HourlyBreakdownEntry[];
    counterfactualFeeImpact?: CounterfactualFeeRowImpact[];
    compareFeeLabel?: string;
  },
): string {
  const d = result.timelineDiagnostics;
  const firstBridge = d.binanceBridges[0] ?? null;
  const firstHlReconnect = d.hyperliquidReconnectFirstValid[0] ?? null;
  const sampleTrade = result.rows.find(
    (r) => r.decision === 'TRIGGERED' && r.strategy_version === 'vwap_taker_v2' && !r.is_open_at_end,
  ) ?? result.rows.find((r) => r.decision === 'TRIGGERED') ?? null;

  const lines: string[] = [
    '# Phase 1 Offline Replay & Audit Report (ETH · Binance USD-M + Hyperliquid)',
    '',
    `- **Run ID**: \`${result.runId}\``,
    `- **Generated At**: ${result.generatedAtIso}`,
    `- **Source Capture**: \`${eventsPath}\``,
    `- **Simulation Mode**: Streaming causal offline replay over native venue order books (read-only)`,
    `- **Capture Window**: ${d.startedAtIso} → ${d.endedAtIso} (events processed: ${d.eventsProcessed})`,
    `- **Binance Streams Used**: ${d.binanceChannelsUsed.join(' | ') || 'N/A'}`,
    `- **CrossEx Bypass Frames Captured**: ${d.crossexBypassCount}`,
    `- **Binance Sequence Gaps**: ${d.binanceGapCount} | **Hyperliquid Stale Backward Rejected**: ${d.hyperliquidStaleRejectedCount}`,
    `- **Funding Settlement Records**: live=${d.liveSettledFundingCount} | historicalBackfill=${d.historicalBackfillFundingCount}`,
    `- **Cross-Format Same-Price Book Updates**: total=${d.crossFormatPriceUpdates.total} (binance=${d.crossFormatPriceUpdates.binance}, hyperliquid=${d.crossFormatPriceUpdates.hyperliquid})`,
    '',
    '## 1. Fee & Denominator Assumptions',
    '',
    `- **Fee Source**: \`${result.config.fees.source}\` — ${result.config.fees.note}`,
    `- **Binance Contract/Role/Rate**: \`${result.config.fees.binanceContract}\` / \`${result.config.fees.binanceRole}\` / \`${result.config.fees.binanceTakerFeeRate}\``,
    `- **Hyperliquid Contract/Role/Rate**: \`${result.config.fees.hyperliquidContract}\` / \`${result.config.fees.hyperliquidRole}\` / \`${result.config.fees.hyperliquidTakerFeeRate}\``,
    `- **Unique BPS Denominator**: \`planned_notional_usdt = Q_plan (${result.config.plannedQtyEth} ETH) × long_ref_price_usdt\``,
    `- **Capital Budget (Reference Only)**: \`${result.config.budgetUsdt} USDT\` (assumed leverage: \`${result.config.assumedLeverage}x\`)`,
    `- **Entry Thresholds Tested (bps)**: \`${result.config.entryBpsList.join(', ')}\``,
    `- **Future Source Clock Tolerance (ms)**: \`${result.config.futureSourceToleranceMs}\``,
    '',
    '## 2. Dual-Leg Freshness Coverage (`coverageByAgeTier`)',
    '',
    '| Age Tier | BN Max Recv/Source (ms) | HL Max Recv/Source (ms) | Total Window (ms) | BN Valid (ms) | HL Valid (ms) | Dual Valid Overlap (ms) | Overlap (%) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];

  for (const cov of d.coverageByAgeTier) {
    lines.push(
      `| \`${cov.age_tier}\` | ${cov.bn_max_recv_age_ms}/${cov.bn_max_source_age_ms} | ${cov.hl_max_recv_age_ms}/${cov.hl_max_source_age_ms} | ${cov.total_window_ms} | ${cov.bn_valid_ms} | ${cov.hl_valid_ms} | ${cov.valid_overlap_ms} | ${cov.overlap_ratio_pct}% |`,
    );
  }

  lines.push(
    '',
    '## 3. Summary Comparison Across Age Tiers, Entry Thresholds, and Delays',
    '',
    '| Age Tier | Entry (bps) | Strategy | Delay (ms) | Raw Ticks | Raw Cand | Logged Cand | Triggered | Raw Rejects | Completed | Open End | In-Flight End | Unvalued Open | Realized Net (USD) | Mark-to-Close (USD) | Fees (USD) | Funding Net (USD) | Realized Net (bps) |',
    '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  );

  for (const s of result.summaries) {
    lines.push(
      `| \`${s.age_tier}\` | ${s.entry_bps_threshold} | \`${s.strategy_version}\` | ${s.delay_ms} | ${s.raw_decision_ticks_evaluated} | ${s.raw_candidates} | ${s.logged_candidates} | ${s.triggered_count} | ${s.raw_reject_count} | ${s.completed_roundtrips} | ${s.open_at_end_count} | ${s.in_flight_at_end_count} | ${s.unvalued_open_count} | ${s.realized_roundtrip_pnl_usd} | ${s.mark_to_close_open_pnl_usd} | ${s.total_fees_usd} | ${s.total_funding_net_usd} | ${s.realized_net_bps ?? 'N/A'} |`,
    );
  }

  if (extras?.primaryHourlyBreakdown && extras.primaryHourlyBreakdown.length > 0) {
    lines.push(
      '',
      '### 3.1 Primary Variant UTC Hourly PnL & Open Carry (`hl_15000ms_bn_15000ms | 2 bps | vwap_taker_v2 | 100 ms`)',
      '',
      '| Hour Start (UTC) | Entries | Completed | Open At Hour End | Realized Net (USD) | Fees (USD) | Funding Net (USD) | Open End Mark (USD) |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
    );
    for (const h of extras.primaryHourlyBreakdown) {
      lines.push(
        `| ${h.hourStartIso} | ${h.entriesTriggered} | ${h.completedInHour} | ${h.openAtHourEnd} | ${h.realizedNetUsd} | ${h.feesUsd} | ${h.fundingNetUsd} | ${h.markToCloseOpenEndUsd} |`,
      );
    }
  }

  if (extras?.counterfactualFeeImpact && extras.counterfactualFeeImpact.length > 0) {
    lines.push(
      '',
      `### 3.2 Fixed-Trade Counterfactual Fee Sensitivity (${extras.compareFeeLabel ?? 'compared_fee_snapshot'})`,
      '',
      '| Age Tier | Entry (bps) | Strategy | Delay (ms) | Completed | Baseline Net (USD) | Baseline Fees (USD) | Counterfactual Fees (USD) | Fee Delta (USD) | Counterfactual Net (USD) | Counterfactual Net (bps) |',
      '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    );
    for (const cf of extras.counterfactualFeeImpact) {
      lines.push(
        `| \`${cf.age_tier}\` | ${cf.entry_bps_threshold} | \`${cf.strategy_version}\` | ${cf.delay_ms} | ${cf.completed_roundtrips} | ${cf.baseline_realized_net_usd} | ${cf.baseline_fees_usd} | ${cf.counterfactual_fees_usd} | ${cf.fee_delta_usd} | ${cf.counterfactual_realized_net_usd} | ${cf.counterfactual_realized_net_bps ?? 'N/A'} |`,
      );
    }
  }

  lines.push('', '## 4. End-of-Window In-Flight Orders & Unvalued Positions', '');
  lines.push('### 4.1 In-Flight Orders At End (`inFlightOrdersAtEnd`)');
  lines.push('```json');
  lines.push(JSON.stringify(result.inFlightOrdersAtEnd, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 4.2 Unvalued Open Positions (`unvaluedOpenPositions`)');
  lines.push('```json');
  lines.push(JSON.stringify(result.unvaluedOpenPositions, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## 5. Required Audit Proofs & Examples', '');
  lines.push('### 5.1 Binance Snapshot Bridge & Resync Trace');
  lines.push('```json');
  lines.push(JSON.stringify({
    initialBridge: firstBridge,
    allBridges: d.binanceBridges,
    gaps: d.binanceGaps,
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 5.2 Hyperliquid First Valid Snapshot After Reconnect');
  lines.push('```json');
  lines.push(JSON.stringify(firstHlReconnect, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 5.3 Same Opportunity Under `0 ms` vs `100 ms` Delay');
  lines.push('```json');
  lines.push(JSON.stringify(result.sampleDelayComparison, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 5.4 Hand-Verifiable Trade / Native Contract PnL & Funding Sample');
  lines.push('```json');
  lines.push(JSON.stringify(sampleTrade, null, 2));
  lines.push('```');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputPath = readArg(args, '--in') ?? '.local-data/phase1/latest/events.ndjson';
  const outDir = readArg(args, '--out') ?? '.local-data/phase1/latest/replay';
  const qtyEth = readArg(args, '--qty') ?? DEFAULT_REPLAY_CONFIG.plannedQtyEth;
  const entryBpsRaw = readArg(args, '--entry-bps-list') ?? readArg(args, '--entry-bps');
  const entryBpsList = parseStringList(entryBpsRaw, DEFAULT_REPLAY_CONFIG.entryBpsList);
  const takeProfitBps = readArg(args, '--tp-bps') ?? DEFAULT_REPLAY_CONFIG.takeProfitBps;
  const budgetUsdt = readArg(args, '--budget-usdt') ?? DEFAULT_REPLAY_CONFIG.budgetUsdt;
  const assumedLeverage = readArg(args, '--leverage') ?? DEFAULT_REPLAY_CONFIG.assumedLeverage;
  const bnMaxAgeFallback = parsePositiveInt(readArg(args, '--bn-max-age-ms'), DEFAULT_REPLAY_CONFIG.bnMaxRecvAgeMs);
  const bnMaxRecvAgeMs = parsePositiveInt(readArg(args, '--bn-max-recv-age-ms'), bnMaxAgeFallback);
  const bnMaxSourceAgeMs = parsePositiveInt(readArg(args, '--bn-max-source-age-ms'), bnMaxAgeFallback);
  const hlMaxAgeMsList = parseNumberList(readArg(args, '--hl-max-age-ms-list'), DEFAULT_REPLAY_CONFIG.hlMaxAgeMsList);
  const futureSourceToleranceMs = parsePositiveInt(
    readArg(args, '--future-tol-ms'),
    DEFAULT_REPLAY_CONFIG.futureSourceToleranceMs,
  );
  const delaysMs = parseNumberList(readArg(args, '--delays-ms'), DEFAULT_REPLAY_CONFIG.delaysMs);
  const feeSnapshotPath = readArg(args, '--fee-snapshot');
  const compareFeeSnapshotPath = readArg(args, '--compare-fee-snapshot');
  const fees = feeSnapshotPath
    ? resolveFeeScheduleFromSnapshot(
        JSON.parse(readFileSync(feeSnapshotPath, 'utf8')) as SanitizedFeeSnapshotInput,
      )
    : DEFAULT_VIP0_FEES;
  const compareFees = compareFeeSnapshotPath
    ? resolveFeeScheduleFromSnapshot(
        JSON.parse(readFileSync(compareFeeSnapshotPath, 'utf8')) as SanitizedFeeSnapshotInput,
      )
    : null;

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'scorecard.json');
  const csvPath = join(outDir, 'trades.csv');
  const fundingLegsPath = join(outDir, 'funding_legs.csv');
  const mdPath = join(outDir, 'report.md');

  const csvStream = createWriteStream(csvPath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  csvStream.write(`${SCORECARD_CSV_HEADERS.join(',')}\n`);
  const fundingLegsStream = createWriteStream(fundingLegsPath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  fundingLegsStream.write(`${FUNDING_LEGS_CSV_HEADERS.join(',')}\n`);
  let csvRowsWritten = 0;
  let fundingLegRowsWritten = 0;
  const primaryTriggeredRows: TradeScorecardRow[] = [];
  const allTriggeredForCounterfactual: TradeScorecardRow[] = [];

  const result = await runPhase1ReplayStream(
    inputPath,
    {
      plannedQtyEth: qtyEth,
      entryBpsList,
      takeProfitBps,
      budgetUsdt,
      assumedLeverage,
      bnMaxRecvAgeMs,
      bnMaxSourceAgeMs,
      hlMaxAgeMsList,
      futureSourceToleranceMs,
      delaysMs,
      fees,
    },
    {
      retainRowsInMemory: true,
      maxRetainedRows: 2_000,
      onFinalizedRow: (row) => {
        csvRowsWritten += 1;
        csvStream.write(renderScorecardCsvRow(row));
        for (const legLine of renderFundingLegCsvRows(row)) {
          fundingLegRowsWritten += 1;
          fundingLegsStream.write(legLine);
        }
        if (row.decision === 'TRIGGERED') {
          if (compareFees) allTriggeredForCounterfactual.push(row);
          if (
            row.age_tier === 'hl_15000ms_bn_15000ms'
            && row.entry_bps_threshold === '2'
            && row.strategy_version === 'vwap_taker_v2'
            && row.delay_ms === 100
          ) {
            primaryTriggeredRows.push(row);
          }
        }
      },
    },
  );

  csvStream.end();
  fundingLegsStream.end();
  await Promise.all([once(csvStream, 'finish'), once(fundingLegsStream, 'finish')]);

  const primaryHourlyBreakdown = buildVariantHourlyBreakdown(
    primaryTriggeredRows,
    result.timelineDiagnostics.startedAtMs,
    result.timelineDiagnostics.endedAtMs,
  );
  const counterfactualFeeImpact = compareFees
    ? computeCounterfactualFeeImpactOnFixedTrades(allTriggeredForCounterfactual, compareFees)
    : undefined;

  writeFileSync(jsonPath, JSON.stringify({
    ...result,
    primaryHourlyBreakdown,
    ...(counterfactualFeeImpact ? { counterfactualFeeImpact } : {}),
  }, null, 2));
  writeFileSync(mdPath, renderAuditMarkdownReport(result, inputPath, {
    primaryHourlyBreakdown,
    ...(counterfactualFeeImpact ? { counterfactualFeeImpact, compareFeeLabel: compareFees!.note } : {}),
  }));

  console.log(JSON.stringify({
    jsonPath,
    csvPath,
    fundingLegsPath,
    mdPath,
    csvRowsWritten,
    fundingLegRowsWritten,
    coverageByAgeTier: result.timelineDiagnostics.coverageByAgeTier,
    summaries: result.summaries,
    inFlightOrdersAtEnd: result.inFlightOrdersAtEnd.length,
    unvaluedOpenPositions: result.unvaluedOpenPositions.length,
    diagnostics: {
      eventsProcessed: result.timelineDiagnostics.eventsProcessed,
      binanceBridges: result.timelineDiagnostics.binanceBridges.length,
      binanceGaps: result.timelineDiagnostics.binanceGapCount,
      hlReconnects: result.timelineDiagnostics.hyperliquidReconnectFirstValid.length,
      liveSettledFundingCount: result.timelineDiagnostics.liveSettledFundingCount,
      historicalBackfillFundingCount: result.timelineDiagnostics.historicalBackfillFundingCount,
      crossFormatPriceUpdates: result.timelineDiagnostics.crossFormatPriceUpdates,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error('Phase 1 replay failed:', err);
  process.exitCode = 1;
});
