import { describe, expect, it } from 'vitest';
import { closeOrder, runStamp } from './reset.ts';

describe('reset helpers', () => {
  it('closes stacked check/ pull requests before their fix/ base', () => {
    const pulls = [{ head: { ref: 'fix/yen' } }, { head: { ref: 'check/yen' } }];
    expect(closeOrder(pulls).map((p) => p.head.ref)).toEqual(['check/yen', 'fix/yen']);
  });

  it('names archived runs by UTC time, safe for file names', () => {
    expect(runStamp(new Date('2026-11-03T10:15:02.123Z'))).toBe('2026-11-03T10-15-02Z');
  });
});
