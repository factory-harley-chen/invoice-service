import { describe, expect, it } from 'vitest';
import { holdRead, releaseView, rollOutRequestError } from './release.ts';
import type { Invoice, InvoiceSummary } from './release.ts';
import { derive } from './rules.ts';
import type { RuleConfig } from './rules.ts';
import { inputsAt, SIMULATION_LENGTH_S } from './simulate.ts';

const cfg: RuleConfig = {
  botLogin: 'factory-droid[bot]',
  ownerLogin: 'factory-harley-chen',
  ownerName: 'Harley',
  runIdentity: '',
  workspaceUrl: 'https://factory-gtm.slack.com',
  demoMode: 'rehearsal',
  checks: { tests: 'Lint, typecheck and test', codeReview: 'droid.?review|code.?review', securityReview: 'security' },
  banner: { kind: 'simulate', text: 'Simulation: not a real run' },
};
const BASE = Date.parse('2026-11-11T13:01:00.000Z');

function summary(bookingId: string, id: string, currency: string, minor: number, formatted: string): InvoiceSummary {
  return { bookingId, customer: { id, name: id }, currency, total: { minor, formatted } };
}
// Staging's /invoices at baseline: the yen customer (C-204) falls back to euros.
const baseline: InvoiceSummary[] = [
  summary('B-1041', 'C-201', 'EUR', 32200, '€322.00'),
  summary('B-1042', 'C-204', 'EUR', 7400, '€74.00'),
  summary('B-1043', 'C-202', 'GBP', 28000, '£280.00'),
  summary('B-1044', 'C-203', 'USD', 84000, '$840.00'),
  summary('B-1045', 'C-205', 'EUR', 19200, '€192.00'),
  summary('B-1046', 'C-202', 'GBP', 14000, '£140.00'),
];
const broken = baseline.map((i) => (i.bookingId === 'B-1042' ? summary('B-1042', 'C-204', 'JPY', 1200000, '¥1,200,000') : i));
const preview: Invoice = {
  bookingId: 'B-1042',
  customer: { id: 'C-204', name: 'Sakura Lane Design' },
  currency: 'EUR',
  lines: [{ item: 'Kyoto hotel', unit: 'night', quantity: 1, unitPrice: { minor: 7400, formatted: '€74.00' }, total: { minor: 7400, formatted: '€74.00' } }],
  total: { minor: 7400, formatted: '€74.00' },
  sendAt: '15:00',
  timeZone: 'Europe/Berlin',
};

describe('release view', () => {
  it('offers the roll-out at baseline, with yen off and its customer billed in euros', () => {
    const v = releaseView({ live: true, invoices: baseline, preview, state: null, rolling: false });
    expect(v).toMatchObject({ staging: 'up', canRollOut: true, reason: '', yenOn: false, yenSince: null, alert: null });
    expect(v.stats).toEqual({ invoices: 6, customers: 5, currenciesOn: 3 });
    expect(v.currencies.map((c) => [c.code, c.on, c.customers])).toEqual([
      ['EUR', true, 3],
      ['GBP', true, 1],
      ['USD', true, 1],
      ['JPY', false, 0],
    ]);
    expect(v.preview?.total.formatted).toBe('€74.00');
  });

  it('shows yen on once staging bills in yen, and refuses a second roll-out', () => {
    const v = releaseView({ live: true, invoices: broken, preview: null, state: null, rolling: false });
    expect(v).toMatchObject({ canRollOut: false, reason: 'Yen billing is already on', yenOn: true });
    expect(v.stats.currenciesOn).toBe(4);
    expect(v.currencies.find((c) => c.code === 'JPY')).toMatchObject({ on: true, customers: 1 });
    expect(v.currencies.find((c) => c.code === 'EUR')?.customers).toBe(2);
  });

  it('says why the button is off', () => {
    expect(releaseView({ live: true, invoices: null, preview: null, state: null, rolling: false })).toMatchObject({ staging: 'down', canRollOut: false, reason: 'Staging is not running' });
    expect(releaseView({ live: false, invoices: baseline, preview, state: null, rolling: false }).reason).toMatch(/live loop server/);
    expect(releaseView({ live: true, invoices: baseline, preview, state: null, rolling: true })).toMatchObject({ canRollOut: false, reason: 'Rolling out' });
  });

  it('takes the alert and the break time from the loop state', () => {
    const state = derive(inputsAt(60, BASE), cfg);
    expect(state.milestones.alert).not.toBeNull();
    const v = releaseView({ live: true, invoices: broken, preview: null, state, rolling: false });
    expect(v.alert).toMatchObject({ at: state.milestones.alert, bookingId: 'B-1042', resolvedAt: null });
    expect(v.alert?.expected).toBe(state.invoice?.expected);
    expect(v.alert?.actual).toBe(state.invoice?.actual);
    expect(v.yenSince).toBe(state.milestones.break);
    const done = derive(inputsAt(134, BASE), cfg);
    expect(releaseView({ live: true, invoices: baseline, preview, state: done, rolling: false }).alert?.resolvedAt).toBe(done.milestones.alertCleared);
  });
});

describe('release activity and invoice check', () => {
  const view = (state: ReturnType<typeof derive> | null, p: Invoice | null = null) => releaseView({ live: true, invoices: broken, preview: p, state, rolling: false });
  const yen = (formatted: string, minor: number): Invoice => ({
    ...preview,
    currency: 'JPY',
    lines: [{ ...preview.lines[0]!, unitPrice: { minor, formatted }, total: { minor, formatted } }],
    total: { minor, formatted },
  });

  it('tells the run from the milestones, in time order, and shows nothing before it happens', () => {
    expect(view(null).activity).toEqual([]);
    const early = view(derive(inputsAt(60, BASE), cfg)).activity;
    expect(early.slice(0, 2).map((a) => [a.key, a.tone])).toEqual([
      ['break', 'info'],
      ['alert', 'bad'],
    ]);
    expect(early.find((a) => a.key === 'resolved')).toBeUndefined();
    const done = derive(inputsAt(SIMULATION_LENGTH_S, BASE), cfg);
    // The simulation has no URLs; a live run's stations link to the pull requests.
    const ship = done.stations.find((s) => s.key === 'ship');
    if (ship) ship.url = 'https://github.com/o/r/pull/12';
    done.leftBehind.url = 'https://github.com/o/r/pull/13';
    const all = view(done).activity;
    expect(all.map((a) => a.key)).toEqual(expect.arrayContaining(['break', 'alert', 'fix', 'approved', 'deployed', 'resolved']));
    expect(all.map((a) => Date.parse(a.at))).toEqual([...all.map((a) => Date.parse(a.at))].sort((x, y) => x - y));
    expect(all.find((a) => a.key === 'fix')?.detail).toBe('Pull request #12 · checks passed');
    expect(all.find((a) => a.key === 'approved')?.detail).toBe('By Harley');
    expect(all.find((a) => a.key === 'check')?.detail).toBe('Pull request #13');
    expect(all.find((a) => a.key === 'resolved')).toMatchObject({ at: done.milestones.alertCleared, tone: 'good' });
  });

  it('marks the invoice wrong while the alert is open and it shows the alert amount, and right once resolved', () => {
    const open = derive(inputsAt(60, BASE), cfg);
    const actual = open.invoice?.actual ?? '';
    expect(actual).not.toBe('');
    expect(view(open, yen(actual, 1200000)).check).toBe('wrong');
    expect(view(open, yen('¥12,000', 12000)).check).toBeNull();
    expect(view(null, yen(actual, 1200000)).check).toBeNull();
    expect(view(derive(inputsAt(SIMULATION_LENGTH_S, BASE), cfg), yen('¥12,000', 12000)).check).toBe('right');
  });
});

describe('staging restarts', () => {
  const up = { invoices: baseline, preview };
  const gap = { invoices: null, preview: null };
  it('keeps the last full read through a restart of up to 5 s, then shows staging down', () => {
    const first = holdRead(up, null, 1000);
    expect(first.read).toBe(up);
    const during = holdRead(gap, first.last, 1800);
    expect(during.read).toBe(up);
    expect(holdRead({ invoices: baseline, preview: null }, first.last, 1800).read).toBe(up);
    expect(holdRead(gap, first.last, 6001).read).toBe(gap);
    expect(holdRead(gap, null, 1000).read).toBe(gap);
  });
  it('takes the new read as soon as staging answers again', () => {
    const first = holdRead(up, null, 1000);
    const next = { invoices: broken, preview: null };
    const after = holdRead({ invoices: broken, preview }, first.last, 1900);
    expect(after.read.invoices).toBe(broken);
    expect(after.last?.at).toBe(1900);
    expect(holdRead(next, after.last, 2000).read.invoices).toBe(broken);
  });
});

describe('roll-out requests', () => {
  const port = 4200;
  it('needs a POST with the release header from this page', () => {
    expect(rollOutRequestError('GET', { 'x-release-action': 'roll-out' }, port)).toBe('POST only');
    expect(rollOutRequestError('POST', {}, port)).toMatch(/X-Release-Action/);
    expect(rollOutRequestError('POST', { 'x-release-action': 'roll-out', origin: 'https://example.com' }, port)).toMatch(/not allowed/);
    expect(rollOutRequestError('POST', { 'x-release-action': 'roll-out', origin: 'http://localhost:4200' }, port)).toBeNull();
    expect(rollOutRequestError('POST', { 'x-release-action': 'roll-out', origin: 'http://127.0.0.1:4200' }, port)).toBeNull();
    expect(rollOutRequestError('POST', { 'x-release-action': 'roll-out' }, port)).toBeNull();
  });
});
