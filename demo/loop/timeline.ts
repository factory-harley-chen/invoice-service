// The timeline: what the screen showed, one snapshot per change, for replay
// and for the timings. Format, one JSON object per line:
//   {"kind":"meta","version":1,"source":"live"|"rehearsal"|"simulate","startedAt":ISO}
//   {"kind":"state","at":ISO,"state":LoopState}
// "at" is when the screen changed, in the run's own time.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoopState } from './types.ts';
import { isObj, str } from './json.ts';

export type Frame = { at: string; state: LoopState };
export type Run = { index: number; runKey: string; source: string; lead: Frame | null; frames: Frame[] };

export type TimelineWriter = { meta: (source: string, startedAt: string) => void; write: (at: string, state: LoopState) => void };

export function createTimelineWriter(file: string): TimelineWriter {
  mkdirSync(dirname(file), { recursive: true });
  return {
    meta: (source, startedAt) => appendFileSync(file, `${JSON.stringify({ kind: 'meta', version: 1, source, startedAt })}\n`),
    write: (at, state) => appendFileSync(file, `${JSON.stringify({ kind: 'state', at, state })}\n`),
  };
}

/** Groups snapshots into runs by runKey; source comes from the last meta line before the run. */
export function parseTimeline(text: string): Run[] {
  const runs: Run[] = [];
  let source = 'unknown';
  let previous: Frame | null = null;
  let current: Run | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(v)) continue;
    if (v.kind === 'meta') {
      source = str(v.source, 'unknown');
      continue;
    }
    if (v.kind !== 'state' || !isObj(v.state) || typeof v.at !== 'string') continue;
    const frame: Frame = { at: v.at, state: v.state as LoopState };
    const key = frame.state.runKey;
    if (key === null) {
      current = null;
    } else if (current !== null && current.runKey === key) {
      current.frames.push(frame);
    } else {
      current = { index: runs.length + 1, runKey: key, source, lead: previous, frames: [frame] };
      runs.push(current);
    }
    previous = frame;
  }
  return runs;
}

export function readTimeline(file: string): Run[] {
  return parseTimeline(readFileSync(file, 'utf8'));
}

export function pickRun(runs: Run[], index: number | null): Run | null {
  if (index === null) return runs[runs.length - 1] ?? null;
  return runs.find((r) => r.index === index) ?? null;
}
