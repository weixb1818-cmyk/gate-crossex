import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_REPLAY_CONFIG,
  loadEventsFromFile,
  runPhase1Replay,
  type ReplaySuiteResult,
  type TradeScorecardRow,
} from './replay.js';

function readArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function renderScorecardCsv(rows: readonly TradeScorecardRow[]): string {
  const headers = [
    'run_id',
    'strategy_version',
    'delay_ms',
    'delay_model',
    'opportunity_id',
    'group_id',
    'asset',
    'direction',
    'long_venue',
    'short_venue',
    'decision',
    'reject_reason',
    'trigger_ts',
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
    'entry_spread_pnl_usd',
    'exit_spread_pnl_usd',
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

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function renderAuditMarkdownReport(result: ReplaySuiteResult, eventsPath: string): string {
  const d = result.timelineDiagnostics;
  const firstBridge = d.binanceBridges[0] ?? null;
  const firstHlReconnect = d.hyperliquidReconnectFirstValid[0] ?? null;
  const sampleTrade = result.rows.find((r) => r.decision === 'TRIGGERED') ?? null;

  const lines: string[] = [
    '# Phase 1 Offline Replay & Audit Report (ETH · Binance USD-M + Hyperliquid)',
    '',
    `- **Run ID**: \`${result.runId}\``,
    `- **Generated At**: ${result.generatedAtIso}`,
    `- **Source Capture**: \`${eventsPath}\``,
    `- **Simulation Mode**: Native venue public order book simulation (offline read-only)`,
    `- **Capture Window**: ${d.startedAtIso} → ${d.endedAtIso} (total ${d.totalWindowMs} ms, dual-book valid overlap ${d.validOverlapMs} ms)`,
    `- **Binance Streams Used**: ${d.binanceChannelsUsed.join(' | ') || 'N/A'}`,
    `- **CrossEx Bypass Frames Captured**: ${d.crossexBypassCount}`,
    `- **Binance Sequence Gaps**: ${d.binanceGapCount} | **Hyperliquid Stale Backward Rejected**: ${d.hyperliquidStaleRejectedCount}`,
    '',
    '## 1. Fee & Denominator Assumptions',
    '',
    `- **Fee Source**: \`${result.config.fees.source}\` — ${result.config.fees.note}`,
    `- **Binance Contract/Role/Rate**: \`${result.config.fees.binanceContract}\` / \`${result.config.fees.binanceRole}\` / \`${result.config.fees.binanceTakerFeeRate}\``,
    `- **Hyperliquid Contract/Role/Rate**: \`${result.config.fees.hyperliquidContract}\` / \`${result.config.fees.hyperliquidRole}\` / \`${result.config.fees.hyperliquidTakerFeeRate}\``,
    `- **Unique BPS Denominator**: \`planned_notional_usdt = Q_plan (${result.config.plannedQtyEth} ETH) × long_ref_price_in_usdt\``,
    `- **Capital Budget (Reference Only)**: \`${result.config.budgetUsdt} USDT\``,
    '',
    '## 2. Summary Comparison (`bbo_v1` vs `vwap_taker_v2` @ `0 ms` & `100 ms`)',
    '',
    '| Strategy | Delay (ms) | Candidates | Triggered | Rejected | Completed | Open at End | Realized Net PnL (USDT) | Mark-to-Close Open (USDT) | Fees (USDT) | Realized Net (bps) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];

  for (const s of result.summaries) {
    lines.push(
      `| \`${s.strategy_version}\` | ${s.delay_ms} | ${s.total_candidates} | ${s.triggered_count} | ${s.rejected_count} | ${s.completed_roundtrips} | ${s.open_at_end_count} | ${s.realized_roundtrip_pnl_usd} | ${s.mark_to_close_open_pnl_usd} | ${s.total_fees_usd} | ${s.realized_net_bps ?? 'N/A'} |`,
    );
  }

  lines.push('', '## 3. Required Audit Proofs & Examples', '');
  lines.push('### 3.1 Binance Snapshot Bridge & Resync Trace');
  lines.push('```json');
  lines.push(JSON.stringify({
    initialBridge: firstBridge,
    allBridges: d.binanceBridges,
    gaps: d.binanceGaps,
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 3.2 Hyperliquid First Valid Snapshot After Reconnect');
  lines.push('```json');
  lines.push(JSON.stringify(firstHlReconnect, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 3.3 Same Opportunity Under `0 ms` vs `100 ms` Delay');
  lines.push('```json');
  lines.push(JSON.stringify(result.sampleDelayComparison, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### 3.4 Hand-Verifiable Trade / Valuation Sample');
  lines.push('```json');
  lines.push(JSON.stringify(sampleTrade, null, 2));
  lines.push('```');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  const inputPath = readArg(args, '--in') ?? '.local-data/phase1/latest/events.ndjson';
  const outDir = readArg(args, '--out') ?? '.local-data/phase1/latest/replay';
  const qtyEth = readArg(args, '--qty') ?? DEFAULT_REPLAY_CONFIG.plannedQtyEth;
  const entryBps = readArg(args, '--entry-bps') ?? DEFAULT_REPLAY_CONFIG.entryBps;
  const takeProfitBps = readArg(args, '--tp-bps') ?? DEFAULT_REPLAY_CONFIG.takeProfitBps;
  const budgetUsdt = readArg(args, '--budget-usdt') ?? DEFAULT_REPLAY_CONFIG.budgetUsdt;

  const events = loadEventsFromFile(inputPath);
  const result = runPhase1Replay(events, {
    plannedQtyEth: qtyEth,
    entryBps,
    takeProfitBps,
    budgetUsdt,
  });

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'scorecard.json');
  const csvPath = join(outDir, 'trades.csv');
  const mdPath = join(outDir, 'report.md');

  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(csvPath, renderScorecardCsv(result.rows));
  writeFileSync(mdPath, renderAuditMarkdownReport(result, inputPath));

  console.log(JSON.stringify({
    jsonPath,
    csvPath,
    mdPath,
    summaries: result.summaries,
    diagnostics: {
      validOverlapMs: result.timelineDiagnostics.validOverlapMs,
      totalWindowMs: result.timelineDiagnostics.totalWindowMs,
      binanceBridges: result.timelineDiagnostics.binanceBridges.length,
      binanceGaps: result.timelineDiagnostics.binanceGapCount,
      hlReconnects: result.timelineDiagnostics.hyperliquidReconnectFirstValid.length,
    },
  }, null, 2));
}

main();
