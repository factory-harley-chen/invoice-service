// A scripted fake run through every station in about 2 minutes, for
// screenshots and offline checks. It feeds made-up inputs through the same
// station rules as a live run; nothing here touches the network or demo/state.

import type { DemoEvent, GhCheck, GhCommit, GhPull, Inputs } from './types.ts';
import { iso, msToSlackTs } from './time.ts';

export type Step = { at: number; label: string; apply: (inp: Inputs, t: (sec: number) => string) => void };

const CHANNEL = 'CSIMULATED';
const MONITOR = { userId: 'USIMMONITOR', botId: 'BSIMMONITOR' };
const RUN_BOT = { user: 'USIMRUN', botId: 'BSIMRUN' };
const BOT_LOGIN = 'factory-droid';
const OWNER = 'factory-harley-chen';
const TESTS = 'Lint, typecheck and test';

export const SIMULATION_LENGTH_S = 134;

export function initialInputs(): Inputs {
  const ok = { state: 'ok' as const, note: 'simulated' };
  return { events: [], slackIdentity: { ...MONITOR }, thread: null, github: { pulls: [], branches: [], rateRemaining: null }, sources: { slack: ok, github: ok, monitor: ok } };
}

function event(inp: Inputs, ts: string, type: string, data: Record<string, unknown>): void {
  const e: DemoEvent = { ts, type, data };
  inp.events.push(e);
}

function reply(inp: Inputs, ts: string, text: string, from: 'run' | 'monitor' = 'run'): void {
  if (inp.thread === null) return;
  const who = from === 'run' ? { user: RUN_BOT.user, botId: RUN_BOT.botId } : { user: MONITOR.userId, botId: MONITOR.botId };
  inp.thread.replies.push({ ts: msToSlackTs(Date.parse(ts)), user: who.user, botId: who.botId, subtype: 'bot_message', text });
}

function gh(inp: Inputs) {
  if (inp.github === null) inp.github = { pulls: [], branches: [], rateRemaining: null };
  return inp.github;
}

function pull(inp: Inputs, n: number): GhPull {
  const p = gh(inp).pulls.find((x) => x.number === n);
  if (p === undefined) throw new Error(`simulation has no PR ${n}`);
  return p;
}

function setCheck(c: GhCommit, name: string, workflow: string, state: GhCheck['state'], at: string | null): void {
  const existing = c.checks.find((k) => k.name === name);
  const next: GhCheck = { name, workflow, state, completedAt: state === 'pending' ? null : at, url: '' };
  if (existing === undefined) c.checks.push(next);
  else Object.assign(existing, next);
}

function head(p: GhPull): GhCommit {
  const c = p.commits[p.commits.length - 1];
  if (c === undefined) throw new Error('simulated PR has no commits');
  return c;
}

export function script(): Step[] {
  let alertTs = '';
  const testCommit = (t: string): GhCommit => ({ oid: 'sim0001', headline: 'test: B-1042 yen invoice is 100 times too high', committedAt: t, url: '', checks: [] });
  return [
    { at: 0, label: 'up', apply: (inp, t) => event(inp, t(0), 'up', { mode: 'rehearsal', channel: CHANNEL, stagingUrl: '' }) },
    { at: 4, label: 'break', apply: (inp, t) => event(inp, t(4), 'break', { mode: 'rehearsal', currencies: ['EUR', 'GBP', 'USD', 'JPY'] }) },
    {
      at: 9,
      label: 'alert fired',
      apply: (inp, t) => {
        alertTs = msToSlackTs(Date.parse(t(9)));
        inp.thread = { channel: CHANNEL, threadTs: alertTs, replies: [], reactions: [] };
        event(inp, t(9), 'alert_fired', {
          channel: CHANNEL,
          ts: alertTs,
          permalink: '',
          bookingId: 'B-1042',
          customer: 'Sakura Lane Design',
          item: 'Kyoto hotel',
          quantity: 1,
          currency: 'JPY',
          expected: { minor: 12000, formatted: '\u00a512,000' },
          actual: { minor: 1200000, formatted: '\u00a51,200,000' },
        });
      },
    },
    { at: 15, label: 'run started', apply: (inp, t) => reply(inp, t(15), 'Looking into this alert now.') },
    {
      at: 31,
      label: 'failing test pushed',
      apply: (inp, t) => {
        gh(inp).branches = [{ name: 'fix/jpy-minor-units', commits: [testCommit(t(31))] }];
      },
    },
    { at: 38, label: 'triage note', apply: (inp, t) => reply(inp, t(38), '*Triage note*\nB-1042 is invoiced \u00a51,200,000 instead of \u00a512,000. No open issue reports it. Invoices go out at 15:00.') },
    {
      at: 46,
      label: 'fix PR opened',
      apply: (inp, t) => {
        const fix: GhCommit = { oid: 'sim0002', headline: 'fix: read yen prices with no minor units', committedAt: t(44), url: '', checks: [] };
        setCheck(fix, TESTS, 'CI', 'pending', null);
        setCheck(fix, 'droid-review', 'Droid Auto Review', 'pending', null);
        gh(inp).pulls.push({
          number: 12,
          title: 'Read yen prices with no minor units',
          url: '',
          state: 'OPEN',
          createdAt: t(46),
          mergedAt: null,
          headRef: 'fix/jpy-minor-units',
          baseRef: 'main',
          headOid: 'sim0002',
          author: BOT_LOGIN,
          additions: 9,
          deletions: 2,
          changedFiles: 2,
          commits: [testCommit(t(31)), fix],
          reviews: [],
          mergeCommit: null,
        });
      },
    },
    { at: 62, label: 'CI green', apply: (inp, t) => setCheck(head(pull(inp, 12)), TESTS, 'CI', 'green', t(62)) },
    { at: 74, label: 'reviews green', apply: (inp, t) => setCheck(head(pull(inp, 12)), 'droid-review', 'Droid Auto Review', 'green', t(74)) },
    { at: 77, label: 'approval requested', apply: (inp, t) => reply(inp, t(77), 'Approval needed: the fix is ready for review.\n<https://github.invalid/pull/12|Pull request 12>') },
    {
      at: 97,
      label: 'approved',
      apply: (inp, t) => {
        pull(inp, 12).reviews.push({ author: OWNER, state: 'APPROVED', submittedAt: t(97), url: '' });
      },
    },
    {
      at: 100,
      label: 'merged',
      apply: (inp, t) => {
        const p = pull(inp, 12);
        p.state = 'MERGED';
        p.mergedAt = t(100);
        p.mergeCommit = { oid: 'sim0003', url: '', checks: [] };
        p.mergeCommit.checks.push({ name: TESTS, workflow: 'CI', state: 'pending', completedAt: null, url: '' });
      },
    },
    {
      at: 110,
      label: 'CI green on main',
      apply: (inp, t) => {
        const mc = pull(inp, 12).mergeCommit;
        if (mc !== null) mc.checks = [{ name: TESTS, workflow: 'CI', state: 'green', completedAt: t(110), url: '' }];
      },
    },
    { at: 111, label: 'deploy started', apply: (inp, t) => event(inp, t(111), 'deploy_started', { sha: 'sim0003' }) },
    { at: 115, label: 'deploy done', apply: (inp, t) => event(inp, t(115), 'deploy_done', { sha: 'sim0003', ciRunUrl: '' }) },
    {
      at: 119,
      label: 'alert resolved',
      apply: (inp, t) => {
        const ts = msToSlackTs(Date.parse(t(119)));
        reply(inp, t(119), 'RESOLVED: B-1042 is invoiced \u00a512,000', 'monitor');
        event(inp, t(119), 'alert_resolved', { channel: CHANNEL, threadTs: alertTs, ts, permalink: '', bookingId: 'B-1042' });
      },
    },
    {
      at: 122,
      label: 'check PR opened',
      apply: (inp, t) => {
        gh(inp).pulls.push({
          number: 13,
          title: 'Check every currency against its minor units',
          url: '',
          state: 'OPEN',
          createdAt: t(122),
          mergedAt: null,
          headRef: 'check/every-currency',
          baseRef: 'main',
          headOid: 'sim0004',
          author: BOT_LOGIN,
          additions: 31,
          deletions: 0,
          changedFiles: 1,
          commits: [],
          reviews: [],
          mergeCommit: null,
        });
      },
    },
    {
      at: 132,
      label: 'check PR approved',
      apply: (inp, t) => {
        pull(inp, 13).reviews.push({ author: OWNER, state: 'APPROVED', submittedAt: t(132), url: '' });
      },
    },
  ];
}

/** Builds the inputs as they stand `atSec` into the script; baseMs is the script's zero. */
export function inputsAt(atSec: number, baseMs: number): Inputs {
  const inp = initialInputs();
  const t = (sec: number) => iso(baseMs + sec * 1000);
  for (const step of script()) if (step.at <= atSec) step.apply(inp, t);
  return inp;
}
