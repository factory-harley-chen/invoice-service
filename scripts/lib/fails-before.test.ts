import { describe, expect, it } from 'vitest';
import { changedTests, jobSummary, verdict } from './fails-before.ts';

describe('changedTests', () => {
  it('keeps only test files', () => {
    expect(changedTests('src/money.ts\nsrc/invoice.test.ts\n\nsrc/rates.test.ts\n')).toEqual(['src/invoice.test.ts', 'src/rates.test.ts']);
    expect(changedTests('')).toEqual([]);
  });
});

describe('verdict', () => {
  it('passes when a test fails on the base code', () => {
    expect(verdict(1, ' Test Files  1 failed (1)\n      Tests  1 failed | 7 passed (8)\n').ok).toBe(true);
  });

  it('fails when the tests pass on the base code', () => {
    const result = verdict(0, '      Tests  8 passed (8)\n');
    expect(result.ok).toBe(false);
    expect(result.line).toContain("don't show the fault");
  });

  it('fails when the tests never ran', () => {
    const result = verdict(1, ' Test Files  1 failed (1)\n      Tests  no tests\n');
    expect(result.ok).toBe(false);
    expect(result.line).toContain('proves nothing');
  });
});

describe('jobSummary', () => {
  it('gives the verdict, the files and the output', () => {
    const summary = jobSummary('origin/main', ['src/invoice.test.ts'], { ok: true, line: 'It fails.' }, 'out\n');
    expect(summary).toBe(
      ['## Fails without the fix', '', 'It fails.', '', 'Tests from this pull request: `src/invoice.test.ts`. Code: `origin/main`.', '', '```', 'out', '```', ''].join('\n'),
    );
  });
});
