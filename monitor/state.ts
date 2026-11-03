import type { Mismatch } from './check.ts';

export type Incident = {
  channel: string;
  ts: string;
  permalink: string;
  firstSeen: string;
  mismatch: Mismatch;
};

export type MonitorState = {
  incident: Incident | null;
  okStreak: number;
};

export type Observation = { kind: 'unknown'; reason: string } | { kind: 'ok' } | { kind: 'mismatch'; mismatch: Mismatch };

export type Decision = { action: 'none' | 'fire' | 'resolve'; okStreak: number };

export const okPollsToResolve = 2;

export const emptyState = (): MonitorState => ({ incident: null, okStreak: 0 });

/**
 * One alert per incident: fire on the first mismatch, then stay quiet until
 * every invoice matches on two polls in a row. A poll that could not read
 * staging counts as neither a match nor a mismatch, and breaks the streak.
 */
export function decide(state: MonitorState, observation: Observation): Decision {
  if (observation.kind === 'unknown') return { action: 'none', okStreak: 0 };
  if (observation.kind === 'mismatch') {
    return { action: state.incident ? 'none' : 'fire', okStreak: 0 };
  }
  if (!state.incident) return { action: 'none', okStreak: 0 };
  const okStreak = state.okStreak + 1;
  return { action: okStreak >= okPollsToResolve ? 'resolve' : 'none', okStreak };
}
