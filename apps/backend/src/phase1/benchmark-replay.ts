import { createWriteStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { StreamingReplayRunner, runPhase1ReplayStream } from './replay.js';
import type { RecordedMarketEvent } from './types.js';

function readArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function readVmHwmMb(): number | null {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) return null;
    return Number((Number(match[1]) / 1024).toFixed(2));
  } catch {
    return null;
  }
}

async function generateSyntheticNdjson(params: {
  path: string;
  eventCount: number;
  depthLevels: number;
}): Promise<{ bytes: number; eventsWritten: number; writeMs: number }> {
  const startMs = Date.now();
  const stream = createWriteStream(params.path, { encoding: 'utf8', highWaterMark: 1024 * 1024 });

  const writeLine = async (ev: RecordedMarketEvent): Promise<void> => {
    const ok = stream.write(`${JSON.stringify(ev)}\n`);
    if (!ok) await once(stream, 'drain');
  };

  let seq = 1;
  let ts = 1_700_000_000_000;

  await writeLine({
    type: 'fx_rate',
    recvSeq: seq++,
    recvTs: ts,
    pair: 'USDC_USDT',
    rate: '1.0001',
    source: 'binance_spot_ticker',
  });
  await writeLine({
    type: 'conn_event',
    venue: 'BINANCE',
    connGen: 1,
    recvSeq: seq++,
    recvTs: ts,
    status: 'open',
    url: 'wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms',
  });
  await writeLine({
    type: 'conn_event',
    venue: 'HYPERLIQUID',
    connGen: 1,
    recvSeq: seq++,
    recvTs: ts,
    status: 'open',
    url: 'wss://api.hyperliquid.xyz/ws',
  });

  const initialBids: Array<[string, string]> = [];
  const initialAsks: Array<[string, string]> = [];
  for (let i = 0; i < params.depthLevels; i += 1) {
    initialBids.push([(2000 - i * 0.05).toFixed(2), '2.5']);
    initialAsks.push([(2000.1 + i * 0.05).toFixed(2), '2.5']);
  }
  await writeLine({
    type: 'bn_depth_delta',
    connGen: 1,
    recvSeq: seq++,
    recvTs: ts + 3,
    stream: 'ethusdt@depth@100ms',
    eventTime: ts + 1,
    U: '100',
    u: '100',
    pu: '99',
    bids: [['1999.95', '3.1']],
    asks: [['2000.15', '3.1']],
  });
  await writeLine({
    type: 'bn_depth_snapshot',
    connGen: 1,
    recvSeq: seq++,
    recvTs: ts + 5,
    lastUpdateId: '100',
    bids: initialBids,
    asks: initialAsks,
  });

  const hlBids: Array<[string, string]> = [];
  const hlAsks: Array<[string, string]> = [];
  for (let i = 0; i < 20; i += 1) {
    hlBids.push([(2000.8 - i * 0.1).toFixed(2), '1.2']);
    hlAsks.push([(2001.0 + i * 0.1).toFixed(2), '1.2']);
  }
  await writeLine({
    type: 'hl_l2book',
    connGen: 1,
    recvSeq: seq++,
    recvTs: ts + 10,
    sourceTs: ts + 8,
    coin: 'ETH',
    bidLevels: 20,
    askLevels: 20,
    bids: hlBids,
    asks: hlAsks,
  });

  let updateId = 100;
  let written = 5;
  while (written < params.eventCount) {
    ts += 15;
    if (written % 25 === 0) {
      const wave = (written % 200) < 100 ? 0.8 : -0.6;
      const bids: Array<[string, string]> = [];
      const asks: Array<[string, string]> = [];
      for (let i = 0; i < 20; i += 1) {
        bids.push([(2000.0 + wave - i * 0.1).toFixed(2), '1.2']);
        asks.push([(2000.2 + wave + i * 0.1).toFixed(2), '1.2']);
      }
      await writeLine({
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: seq++,
        recvTs: ts,
        sourceTs: ts - 2,
        coin: 'ETH',
        bidLevels: 20,
        askLevels: 20,
        bids,
        asks,
      });
    } else {
      const pu = String(updateId);
      const nextU = updateId + 2;
      updateId = nextU;
      await writeLine({
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: seq++,
        recvTs: ts,
        stream: 'ethusdt@depth@100ms',
        eventTime: ts - 2,
        U: String(Number(pu) + 1),
        u: String(nextU),
        pu,
        bids: [['1999.95', '3.1'], ['1999.80', '0'], ['1999.85', '2.0']],
        asks: [['2000.15', '3.1'], ['2000.30', '0'], ['2000.25', '2.0']],
      });
    }
    written += 1;
  }

  stream.end();
  await once(stream, 'finish');
  const bytes = statSync(params.path).size;
  return { bytes, eventsWritten: written, writeMs: Date.now() - startMs };
}

async function runSegmentedParityCheck(sliceEvents: number): Promise<boolean> {
  const events: RecordedMarketEvent[] = [
    { type: 'fx_rate', recvSeq: 1, recvTs: 900, pair: 'USDC_USDT', rate: '1', source: 'parity_fallback' },
    { type: 'conn_event', venue: 'BINANCE', connGen: 1, recvSeq: 2, recvTs: 1000, status: 'open', url: 'bn' },
    { type: 'conn_event', venue: 'HYPERLIQUID', connGen: 1, recvSeq: 3, recvTs: 1000, status: 'open', url: 'hl' },
    {
      type: 'bn_depth_delta',
      connGen: 1,
      recvSeq: 4,
      recvTs: 1003,
      stream: 'ethusdt@depth@100ms',
      eventTime: 1001,
      U: '100',
      u: '100',
      pu: '99',
      bids: [['1999.9', '5']],
      asks: [['2000.0', '5']],
    },
    {
      type: 'bn_depth_snapshot',
      connGen: 1,
      recvSeq: 5,
      recvTs: 1005,
      lastUpdateId: '100',
      bids: [['1999.9', '5']],
      asks: [['2000.0', '5']],
    },
  ];
  let uid = 100;
  for (let i = 0; i < sliceEvents; i += 1) {
    const ts = 1020 + i * 20;
    if (i % 20 === 0) {
      const edge = (i % 80) < 40 ? 2.0 : -0.5;
      events.push({
        type: 'hl_l2book',
        connGen: 1,
        recvSeq: 10 + i,
        recvTs: ts,
        sourceTs: ts - 2,
        coin: 'ETH',
        bidLevels: 1,
        askLevels: 1,
        bids: [[(2000.0 + edge).toFixed(2), '5']],
        asks: [[(2000.2 + edge).toFixed(2), '5']],
      });
    } else {
      const pu = String(uid);
      uid += 1;
      events.push({
        type: 'bn_depth_delta',
        connGen: 1,
        recvSeq: 10 + i,
        recvTs: ts,
        stream: 'ethusdt@depth@100ms',
        eventTime: ts - 2,
        U: String(uid),
        u: String(uid),
        pu,
        bids: [['1999.9', '5']],
        asks: [['2000.0', '5']],
      });
    }
  }

  const fullRunner = new StreamingReplayRunner();
  for (const ev of events) fullRunner.processEvent(ev);
  const fullRes = fullRunner.finalize();

  const mid = Math.floor(events.length / 2);
  const seg1 = new StreamingReplayRunner();
  for (const ev of events.slice(0, mid)) seg1.processEvent(ev);
  const cp = JSON.parse(JSON.stringify(seg1.exportCheckpoint()));
  const seg2 = StreamingReplayRunner.fromCheckpoint(cp);
  for (const ev of events.slice(mid)) seg2.processEvent(ev);
  const segRes = seg2.finalize();

  const normalizeRows = (rows: typeof fullRes.rows) => rows.map((r) => ({ ...r, run_id: 'normalized' }));
  return (
    JSON.stringify(fullRes.summaries) === JSON.stringify(segRes.summaries)
    && JSON.stringify(normalizeRows(fullRes.rows)) === JSON.stringify(normalizeRows(segRes.rows))
    && JSON.stringify(fullRes.timelineDiagnostics.coverageByAgeTier)
      === JSON.stringify(segRes.timelineDiagnostics.coverageByAgeTier)
    && JSON.stringify(fullRes.inFlightOrdersAtEnd) === JSON.stringify(segRes.inFlightOrdersAtEnd)
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const eventCount = Math.max(10_000, Math.trunc(Number(readArg(args, '--events') ?? '1500000')));
  const depthLevels = Math.max(20, Math.trunc(Number(readArg(args, '--levels') ?? '1000')));
  const tmpDir = mkdtempSync(join(tmpdir(), 'phase1-replay-bench-'));

  try {
    const ndjsonPath = join(tmpDir, 'synthetic-events.ndjson');
    const gen = await generateSyntheticNdjson({ path: ndjsonPath, eventCount, depthLevels });

    let peakHeapMb = 0;
    let peakRssMb = 0;
    const sampler = setInterval(() => {
      const mem = process.memoryUsage();
      peakHeapMb = Math.max(peakHeapMb, mem.heapUsed / (1024 * 1024));
      peakRssMb = Math.max(peakRssMb, mem.rss / (1024 * 1024));
    }, 100);

    let streamedRowsCount = 0;
    const replayStart = Date.now();
    const result = await runPhase1ReplayStream(ndjsonPath, {}, {
      retainRowsInMemory: false,
      onFinalizedRow: () => {
        streamedRowsCount += 1;
      },
    });
    const replayMs = Date.now() - replayStart;
    clearInterval(sampler);

    const memEnd = process.memoryUsage();
    peakHeapMb = Math.max(peakHeapMb, memEnd.heapUsed / (1024 * 1024));
    peakRssMb = Math.max(peakRssMb, memEnd.rss / (1024 * 1024));

    const segmentedParity = await runSegmentedParityCheck(10_000);

    console.log(JSON.stringify({
      eventsProcessed: result.timelineDiagnostics.eventsProcessed,
      depthLevelsPerSide: depthLevels,
      ndjsonSizeMb: Number((gen.bytes / (1024 * 1024)).toFixed(2)),
      ndjsonGenerateMs: gen.writeMs,
      streamingReplayMs: replayMs,
      eventsPerSec: Math.round((result.timelineDiagnostics.eventsProcessed / Math.max(1, replayMs)) * 1000),
      peakHeapUsedMb: Number(peakHeapMb.toFixed(2)),
      peakRssSampledMb: Number(peakRssMb.toFixed(2)),
      linuxVmHwmMb: readVmHwmMb(),
      coverageTiersCount: result.timelineDiagnostics.coverageByAgeTier.length,
      summariesCount: result.summaries.length,
      rowsStreamedCount: streamedRowsCount,
      rowsRetainedInRamCount: result.rows.length,
      segmentedCheckpointParityExact: segmentedParity,
    }, null, 2));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Phase 1 benchmark failed:', err);
  process.exitCode = 1;
});
