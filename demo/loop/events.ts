// Tails demo/state/events.jsonl, which the monitor and ./demo.sh append to.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { DemoEvent, SourceStatus } from './types.ts';
import { isObj, str } from './json.ts';

export type ParseResult = { events: DemoEvent[]; bad: number };

export function parseEventLines(text: string): ParseResult {
  const events: DemoEvent[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (!isObj(v) || typeof v.type !== 'string' || typeof v.ts !== 'string' || Number.isNaN(Date.parse(v.ts))) {
        bad += 1;
        continue;
      }
      events.push({ ts: str(v.ts), type: v.type, data: isObj(v.data) ? v.data : {} });
    } catch {
      bad += 1;
    }
  }
  return { events, bad };
}

/** Keeps only what follows the last reset, so a long-lived file stays cheap to fold. */
export function sinceLastReset(events: DemoEvent[]): DemoEvent[] {
  let last = -1;
  events.forEach((e, i) => {
    if (e.type === 'reset') last = i;
  });
  return last >= 0 ? events.slice(last) : events;
}

export type EventsTail = { stop: () => void; pollOnce: () => void };

export function createEventsTail(opts: {
  file: string;
  intervalMs: number;
  onEvents: (events: DemoEvent[], reset: boolean) => void;
  onStatus: (s: SourceStatus) => void;
}): EventsTail {
  let offset = 0;
  let partial = '';
  let events: DemoEvent[] = [];
  let bad = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const pollOnce = (): void => {
    let size: number;
    try {
      size = statSync(opts.file).size;
    } catch {
      if (offset !== 0 || events.length > 0) {
        offset = 0;
        partial = '';
        events = [];
        opts.onEvents(events, true);
      }
      opts.onStatus({ state: 'waiting', note: 'no events file yet' });
      return;
    }
    let reset = false;
    if (size < offset) {
      offset = 0;
      partial = '';
      events = [];
      reset = true;
    }
    if (size > offset) {
      const fd = openSync(opts.file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const chunk = partial + buf.toString('utf8');
        const cut = chunk.lastIndexOf('\n');
        partial = cut >= 0 ? chunk.slice(cut + 1) : chunk;
        const parsed = parseEventLines(cut >= 0 ? chunk.slice(0, cut) : '');
        bad += parsed.bad;
        if (parsed.events.some((e) => e.type === 'reset')) reset = true;
        events = sinceLastReset([...events, ...parsed.events]);
      } finally {
        closeSync(fd);
      }
      opts.onEvents(events, reset);
    } else if (reset) {
      opts.onEvents(events, true);
    }
    opts.onStatus(bad > 0 ? { state: 'error', note: `${bad} unreadable line${bad === 1 ? '' : 's'}` } : { state: 'ok', note: '' });
  };

  const loop = (): void => {
    if (stopped) return;
    pollOnce();
    timer = setTimeout(loop, opts.intervalMs);
  };
  loop();
  return {
    pollOnce,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
