// The timings ./demo.sh times prints, from the last snapshot of a recorded run.

import type { Milestones } from './types.ts';
import type { Run } from './timeline.ts';
import { clockText, dateTime, ms } from './time.ts';

export type Timing = { label: string; from: keyof Milestones; to: keyof Milestones; targetMs?: number; limitMs?: number; ms: number | null; verdict: string };

const ROWS: Omit<Timing, 'ms' | 'verdict'>[] = [
  { label: 'Break to alert', from: 'break', to: 'alert' },
  { label: 'Alert to run started', from: 'alert', to: 'runStarted' },
  { label: 'Alert to triage', from: 'alert', to: 'triage' },
  { label: 'Alert to approval request', from: 'alert', to: 'approvalRequested', targetMs: 9 * 60_000, limitMs: 9 * 60_000 + 55_000 },
  { label: 'Approval to merge', from: 'approved', to: 'merged' },
  { label: 'Merge to deploy', from: 'merged', to: 'deployDone' },
  { label: 'Approval to alert cleared', from: 'approved', to: 'alertCleared', targetMs: 3 * 60_000 },
  { label: 'Signal to confirmed fix', from: 'alert', to: 'alertCleared' },
];

export function computeTimes(m: Milestones): Timing[] {
  return ROWS.map((row) => {
    const a = m[row.from];
    const b = m[row.to];
    const d = a !== null && b !== null ? ms(b) - ms(a) : null;
    let verdict = '';
    if (d !== null && row.targetMs !== undefined) {
      if (d <= row.targetMs) verdict = `pass (target ${clockText(row.targetMs)})`;
      else if (row.limitMs !== undefined && d <= row.limitMs) verdict = `over target ${clockText(row.targetMs)}, under limit ${clockText(row.limitMs)}`;
      else verdict = `FAIL (target ${clockText(row.targetMs)}${row.limitMs !== undefined ? `, limit ${clockText(row.limitMs)}` : ''})`;
    } else if (d === null && row.targetMs !== undefined) {
      verdict = 'not reached';
    }
    return { ...row, ms: d, verdict };
  });
}

export function formatTimes(run: Run, file: string): string {
  const last = run.frames[run.frames.length - 1];
  if (last === undefined) return `No snapshots in run ${run.index} of ${file}`;
  const m = last.state.milestones;
  const start = m.break ?? m.alert ?? last.at;
  const lines = [`Timings for run ${run.index} (${run.source}, broken ${dateTime(start)}) from ${file}`];
  if (m.approvalRequested === null && m.waitStarted !== null) {
    lines.push('  No "Approval needed" reply was seen; the wait started when the checks went green.');
  }
  const rows = computeTimes(m);
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    const value = r.ms === null ? 'not reached' : clockText(r.ms);
    lines.push(`  ${r.label.padEnd(width)}  ${value.padStart(11)}${r.verdict !== '' && r.ms !== null ? `  ${r.verdict}` : ''}`);
  }
  lines.push(`  People: ${countDecisions(last.state.summary)}`);
  return lines.join('\n');
}

function countDecisions(summary: string): string {
  const m = /People: (.+)$/.exec(summary);
  return m?.[1] ?? 'not confirmed yet';
}
