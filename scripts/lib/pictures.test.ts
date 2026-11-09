import { describe, expect, it } from 'vitest';
import {
  bookingFromBody,
  currenciesFromBody,
  evidenceBranch,
  hasPictures,
  pullKind,
  rateCardCurrencies,
  withPictures,
} from './pictures.ts';

const fixBody = [
  'Test: bills a JPY booking at the rate card price in yen fails before this change and passes after.',
  'Invoice B-1042: ¥1,200,000 before, ¥12,000 after (expected ¥12,000).',
  'Cause: rate card prices were always multiplied by 100, but yen has no decimal places.',
  '',
  'Alert: invoice-total-mismatch, booking B-1042, BILLING_CURRENCIES=EUR,GBP,USD,JPY. Related: #1',
].join('\n');
const block = 'Note.\n\n| | Before the fix | After the fix |\n| --- | --- | --- |\n| The test | a | b |';

describe('pullKind', () => {
  it('reads fix and check branches and ignores the rest', () => {
    expect(pullKind('fix/jpy-invoice-amounts')).toEqual({ kind: 'fix', slug: 'jpy-invoice-amounts' });
    expect(pullKind('check/jpy-invoice-amounts')).toEqual({ kind: 'check', slug: 'jpy-invoice-amounts' });
    expect(pullKind('main')).toBeUndefined();
    expect(pullKind('feature/jpy')).toBeUndefined();
    expect(pullKind('fix/../main')).toBeUndefined();
  });
});

describe('evidenceBranch', () => {
  it('keeps the check pull request off the fix pull request branch', () => {
    expect(evidenceBranch('fix', 'jpy')).toBe('evidence/jpy');
    expect(evidenceBranch('check', 'jpy')).toBe('evidence/check-jpy');
  });
});

describe('hasPictures', () => {
  it('sees pictures published in this repo only', () => {
    const shown = '![The test before the fix](https://raw.githubusercontent.com/acme/invoice-service/abc/test-before.png)';
    expect(hasPictures(shown, 'acme/invoice-service')).toBe(true);
    expect(hasPictures(shown, 'acme/other')).toBe(false);
    expect(hasPictures(fixBody, 'acme/invoice-service')).toBe(false);
  });
});

describe('bookingFromBody and currenciesFromBody', () => {
  it('reads the booking and the alert currencies', () => {
    expect(bookingFromBody(fixBody)).toBe('B-1042');
    expect(currenciesFromBody(fixBody)).toEqual(['EUR', 'GBP', 'USD', 'JPY']);
  });

  it('falls back to the alert line, and to nothing', () => {
    expect(bookingFromBody('Alert: invoice-total-mismatch, booking B-1043.')).toBe('B-1043');
    expect(bookingFromBody('No booking here.')).toBeUndefined();
    expect(currenciesFromBody('No currencies here.')).toBeUndefined();
  });
});

describe('rateCardCurrencies', () => {
  it('lists every priced currency once', () => {
    const rateCard: Parameters<typeof rateCardCurrencies>[0] = { items: [{ prices: { EUR: '74.00', JPY: '12000' } }, { prices: { GBP: '140.00', EUR: '9.00' } }] };
    expect(rateCardCurrencies(rateCard)).toEqual(['EUR', 'GBP', 'JPY']);
  });
});

describe('withPictures', () => {
  it('puts the pictures after the evidence lines, with blank lines around the table', () => {
    const out = withPictures(fixBody, block);
    const lines = out.split('\n');
    const cause = lines.findIndex((line) => line.startsWith('Cause:'));
    expect(lines[cause + 1]).toBe('');
    expect(lines[cause + 2]).toBe('Note.');
    expect(out).toContain('| The test | a | b |\n\nAlert: invoice-total-mismatch');
    expect(out.endsWith('Related: #1\n')).toBe(true);
  });

  it('replaces the "Screenshots: not taken" line', () => {
    const body = fixBody.replace('\n\nAlert', '\n\nScreenshots: not taken (no browser).\n\nAlert');
    const out = withPictures(body, block);
    expect(out).not.toContain('Screenshots: not taken');
    expect(out).toContain('passes after.');
    expect(out.indexOf('| The test |')).toBeLessThan(out.indexOf('Alert:'));
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('adds them at the end of a body without evidence lines', () => {
    const out = withPictures('Checks every currency. Stacked on #11.', block);
    expect(out).toBe(`Checks every currency. Stacked on #11.\n\n${block}\n`);
  });
});
