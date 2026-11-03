import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { files } from './paths.ts';

export type EventType =
  | 'up'
  | 'break'
  | 'alert_fired'
  | 'alert_resolved'
  | 'deploy_started'
  | 'deploy_done'
  | 'reset';

export type DemoEvent = {
  ts: string;
  type: EventType;
  data: Record<string, unknown>;
};

export function makeEvent(type: EventType, data: Record<string, unknown>, now = new Date()): DemoEvent {
  return { ts: now.toISOString(), type, data };
}

/** Appends one event line to demo/state/events.jsonl and returns it. */
export function appendEvent(type: EventType, data: Record<string, unknown>, file = files.events()): DemoEvent {
  const event = makeEvent(type, data);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  return event;
}
