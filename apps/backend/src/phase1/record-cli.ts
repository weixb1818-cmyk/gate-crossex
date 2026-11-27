import { Phase1MarketRecorder } from './recorder.js';

function readArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputDir = readArg(args, '--out') ?? '.local-data/phase1/latest';
  const durationSecRaw = readArg(args, '--duration-sec');
  const durationMs = durationSecRaw !== undefined ? Number(durationSecRaw) * 1_000 : undefined;
  const injectDisconnectSecRaw = readArg(args, '--inject-disconnect-sec');
  const injectDisconnectAtMs = injectDisconnectSecRaw !== undefined
    ? Number(injectDisconnectSecRaw) * 1_000
    : undefined;
  const pollSecRaw = readArg(args, '--funding-poll-sec');
  const fundingPollIntervalMs = pollSecRaw !== undefined ? Number(pollSecRaw) * 1_000 : undefined;
  const noCrossex = args.includes('--no-crossex');

  const recorder = new Phase1MarketRecorder({
    outputDir,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(injectDisconnectAtMs !== undefined ? { injectDisconnectAtMs } : {}),
    ...(fundingPollIntervalMs !== undefined ? { fundingPollIntervalMs } : {}),
    includeCrossexBypass: !noCrossex,
  });

  const summary = await recorder.run();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
