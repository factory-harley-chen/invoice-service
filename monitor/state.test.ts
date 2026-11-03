import { describe, expect, it } from 'vitest';
import type { Mismatch } from './check.ts';
import { decide, emptyState, type MonitorState, type Observation } from './state.ts';

const mismatch: Mismatch = {
  bookingId: 'B-1042',
  customer: 'Sakura Lane Design',
  item: 'Kyoto hotel',
  unit: 'night',
  quantity: 1,
  currency: 'JPY',
  expected: { minor: 12000, formatted: '¥12,000' },
  actual: { minor: 1200000, formatted: '¥1,200,000' },
};

const open: MonitorState = {
  incident: { channel: 'C0TEST0001', ts: '1.0', permalink: '', firstSeen: '2026-11-11T13:02:31Z', mismatch },
  okStreak: 0,
};

const ok: Observation = { kind: 'ok' };
const bad: Observation = { kind: 'mismatch', mismatch };
const unknown: Observation = { kind: 'unknown', reason: 'connection refused' };

/** Feeds observations through decide the way the monitor does, opening and closing incidents. */
function replay(observations: Observation[]): string[] {
  let state = emptyState();
  return observations.map((observation) => {
    const decision = decide(state, observation);
    state = { ...state, okStreak: decision.okStreak };
    if (decision.action === 'fire') state = { ...open };
    if (decision.action === 'resolve') state = emptyState();
    return decision.action;
  });
}

describe('decide', () => {
  it('stays quiet while everything matches', () => {
    expect(replay([ok, ok, ok])).toEqual(['none', 'none', 'none']);
  });

  it('fires once per incident, however long it lasts', () => {
    expect(replay([ok, bad, bad, bad])).toEqual(['none', 'fire', 'none', 'none']);
  });

  it('resolves after two matching polls in a row', () => {
    expect(replay([bad, ok, ok])).toEqual(['fire', 'none', 'resolve']);
  });

  it('starts the count again when a mismatch or an unreadable poll comes between', () => {
    expect(replay([bad, ok, bad, ok, unknown, ok, ok])).toEqual(['fire', 'none', 'none', 'none', 'none', 'none', 'resolve']);
  });

  it('never fires or resolves on a poll that could not read staging', () => {
    expect(decide(emptyState(), unknown).action).toBe('none');
    expect(decide({ ...open, okStreak: 5 }, unknown)).toEqual({ action: 'none', okStreak: 0 });
  });

  it('fires again for a new incident after the last one resolved', () => {
    expect(replay([bad, ok, ok, bad])).toEqual(['fire', 'none', 'resolve', 'fire']);
  });

  it('keeps an open incident from a saved state (no second alert after a restart)', () => {
    expect(decide(open, bad).action).toBe('none');
  });
});
