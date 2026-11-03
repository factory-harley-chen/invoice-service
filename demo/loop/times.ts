// node demo/loop/times.ts [timeline.jsonl] [--run N]
// Prints the timings of a recorded run (default: the last run in demo/state/timeline.jsonl).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pickRun, readTimeline } from './timeline.ts';
import { formatTimes } from './timings.ts';

function main(argv: string[]): number {
  let file = resolve(import.meta.dirname, '../state/timeline.jsonl');
  let index: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node demo/loop/times.ts [timeline.jsonl] [--run N]\n');
      return 0;
    }
    if (a === '--run') {
      index = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--dry-run') {
      process.stdout.write(`Would read ${file}\n`);
      return 0;
    } else {
      file = resolve(a);
    }
  }
  if (!existsSync(file)) {
    process.stderr.write(`No timeline at ${file}\n`);
    return 1;
  }
  const runs = readTimeline(file);
  const run = pickRun(runs, index);
  if (run === null) {
    process.stderr.write(runs.length === 0 ? `No runs recorded in ${file}\n` : `No run ${index ?? ''} in ${file} (it has ${runs.length})\n`);
    return 1;
  }
  process.stdout.write(`${formatTimes(run, file)}\n`);
  if (runs.length > 1) process.stdout.write(`  (${runs.length} runs in the file; --run N picks another)\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
