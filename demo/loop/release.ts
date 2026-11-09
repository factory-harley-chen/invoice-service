// The release screen: the billing settings page of an invented travel company,
// for the talk's first beat. Turning on yen billing runs ./demo.sh break, the
// same code path as the terminal, so the fault, the event log and the monitor
// are unchanged. Staging's invoices are read live; nothing here is staged.

import { execFile } from 'node:child_process';
import type { IncomingHttpHeaders } from 'node:http';
import type { LoopState } from './types.ts';

export const PREVIEW_BOOKING = 'B-1042';
export const ROLLOUT_CURRENCY = 'JPY';

const CURRENCIES: ReadonlyArray<{ code: string; name: string; symbol: string }> = [
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British pound', symbol: '£' },
  { code: 'USD', name: 'US dollar', symbol: '$' },
  { code: ROLLOUT_CURRENCY, name: 'Japanese yen', symbol: '¥' },
];

type Amount = { minor: number; formatted: string };
export type InvoiceSummary = { bookingId: string; customer: { id: string; name: string }; currency: string; total: Amount };
export type InvoiceLine = { item: string; unit: string; quantity: number; unitPrice: Amount; total: Amount };
export type Invoice = {
  bookingId: string;
  customer: { id: string; name: string };
  currency: string;
  lines: InvoiceLine[];
  total: Amount;
  sendAt: string;
  timeZone: string;
};

export type CurrencyRow = { code: string; name: string; symbol: string; customers: number; on: boolean; rollingOut: boolean };
export type ReleaseAlert = { at: string; bookingId: string; customer: string; expected: string; actual: string; resolvedAt: string | null };
export type ActivityItem = { key: string; at: string; title: string; detail: string; tone: 'info' | 'bad' | 'good' };
/** "wrong" while the alert is open and the preview still shows its amount; "right" once the alert is resolved. */
export type InvoiceCheck = 'wrong' | 'right' | null;
export type ReleaseView = {
  staging: 'up' | 'down';
  canRollOut: boolean;
  reason: string;
  rolling: boolean;
  yenOn: boolean;
  yenSince: string | null;
  currencies: CurrencyRow[];
  stats: { invoices: number; customers: number; currenciesOn: number };
  preview: Invoice | null;
  alert: ReleaseAlert | null;
  check: InvoiceCheck;
  activity: ActivityItem[];
};

export type ReleaseInput = {
  live: boolean;
  invoices: InvoiceSummary[] | null;
  preview: Invoice | null;
  state: LoopState | null;
  rolling: boolean;
};

/** What the page shows, from staging's own invoices and the loop's state. */
export function releaseView(input: ReleaseInput): ReleaseView {
  const invoices = input.invoices ?? [];
  const up = input.invoices !== null;
  const yenOn = invoices.some((i) => i.currency === ROLLOUT_CURRENCY);
  const currencies = CURRENCIES.map((c) => {
    const on = c.code !== ROLLOUT_CURRENCY || yenOn;
    const customers = new Set(invoices.filter((i) => i.currency === c.code).map((i) => i.customer.id)).size;
    return { ...c, customers, on, rollingOut: !on };
  });
  let reason = '';
  if (!input.live) reason = 'Only a live loop server turns on yen billing';
  else if (!up) reason = 'Staging is not running';
  else if (yenOn) reason = 'Yen billing is already on';
  else if (input.rolling) reason = 'Rolling out';
  const alert = alertOf(input.state);
  return {
    staging: up ? 'up' : 'down',
    canRollOut: reason === '',
    reason,
    rolling: input.rolling,
    yenOn,
    yenSince: yenOn ? (input.state?.milestones.break ?? null) : null,
    currencies,
    stats: {
      invoices: invoices.length,
      customers: new Set(invoices.map((i) => i.customer.id)).size,
      currenciesOn: currencies.filter((c) => c.on).length,
    },
    preview: input.preview,
    alert,
    check: checkOf(alert, input.preview),
    activity: activityOf(input.state),
  };
}

function checkOf(alert: ReleaseAlert | null, preview: Invoice | null): InvoiceCheck {
  if (alert === null || preview === null) return null;
  if (alert.resolvedAt !== null) return 'right';
  const showsAlertAmount = preview.total.formatted === alert.actual || preview.lines.some((l) => l.total.formatted === alert.actual);
  return showsAlertAmount ? 'wrong' : null;
}

const prNumber = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? '';

/** Today's run as the billing page tells it, from the loop's milestones only; nothing is shown before it happens. */
export function activityOf(state: LoopState | null): ActivityItem[] {
  if (state === null) return [];
  const m = state.milestones;
  const booking = state.invoice?.bookingId || PREVIEW_BOOKING;
  const items: ActivityItem[] = [];
  const add = (key: string, at: string | null, title: string, detail: string, tone: ActivityItem['tone'] = 'info'): void => {
    if (at !== null) items.push({ key, at, title, detail, tone });
  };
  const fix = prNumber(state.stations.find((s) => s.key === 'ship')?.url ?? '') || prNumber(state.stations.find((s) => s.key === 'change')?.url ?? '');
  const approver = state.record.approver.split(' (')[0] ?? '';
  const check = prNumber(state.leftBehind.url);
  add('break', m.break, 'Yen billing turned on', 'Billing settings');
  add('alert', m.alert, 'Billing alert', `${booking} · on-call notified`, 'bad');
  add('fix', m.fixPrOpened, 'Fix proposed', [fix !== '' ? `Pull request #${fix}` : 'Pull request', m.checksGreen !== null ? 'checks passed' : ''].filter((s) => s !== '').join(' · '));
  add('approved', m.approved, 'Fix approved', approver !== '' && approver !== 'waiting' ? `By ${approver}` : '');
  add('deployed', m.deployDone, 'Fix deployed', 'Billing service updated');
  add('resolved', m.alertCleared, 'Resolved', `${booking} matches the rate card`, 'good');
  add('check', m.checkPrOpened, 'Check added', check !== '' ? `Pull request #${check}` : 'Pull request');
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function alertOf(state: LoopState | null): ReleaseAlert | null {
  const at = state?.milestones.alert ?? null;
  if (state === null || at === null) return null;
  const inv = state.invoice;
  return {
    at,
    bookingId: inv?.bookingId ?? '',
    customer: inv?.customer ?? '',
    expected: inv?.expected ?? '',
    actual: inv?.actual ?? '',
    resolvedAt: state.milestones.alertCleared,
  };
}

/**
 * Why a roll-out request is refused, or null. The custom header makes a
 * browser on another site send a preflight this server never answers, so only
 * the release page itself can press the button.
 */
export function rollOutRequestError(method: string | undefined, headers: IncomingHttpHeaders, port: number): string | null {
  if (method !== 'POST') return 'POST only';
  if (headers['x-release-action'] !== 'roll-out') return 'missing X-Release-Action: roll-out';
  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return `origin ${origin} not allowed`;
  return null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export type StagingRead = { invoices: InvoiceSummary[] | null; preview: Invoice | null };
export type HeldRead = { read: StagingRead; at: number };
export const STAGING_GRACE_MS = 5000;

/**
 * A break or a deploy restarts staging, which is then down for about a second.
 * Through that gap the page keeps the last full read instead of flashing "Not
 * available"; staging that stays down shows as down after the grace period.
 */
export function holdRead(read: StagingRead, last: HeldRead | null, now: number, graceMs = STAGING_GRACE_MS): { read: StagingRead; last: HeldRead | null } {
  if (read.invoices !== null && read.preview !== null) return { read, last: { read, at: now } };
  if (last !== null && now - last.at <= graceMs) return { read: last.read, last };
  return { read, last };
}

export async function readStaging(stagingUrl: string): Promise<StagingRead> {
  const base = stagingUrl.replace(/\/$/, '');
  const [list, preview] = await Promise.all([
    getJson<{ invoices: InvoiceSummary[] }>(`${base}/invoices`),
    getJson<Invoice>(`${base}/invoices/${PREVIEW_BOOKING}`),
  ]);
  return { invoices: list?.invoices ?? null, preview };
}

/** Runs ./demo.sh break and returns its last line ("broken at ..."). */
export function rollOut(repoRoot: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((done) => {
    execFile('./demo.sh', ['break'], { cwd: repoRoot, timeout: 30_000 }, (error, stdout, stderr) => {
      const lines = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      done({ ok: error === null, message: lines[lines.length - 1] ?? (error?.message ?? '') });
    });
  });
}
