import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describe as describeConfig, loadConfig, parseArgs, parseEnvFile } from './config.ts';
import { createEventsTail, parseEventLines, sinceLastReset } from './events.ts';
import { createSlackPoller, flattenText, slackErrorStatus } from './slack.ts';
import type { SlackUpdate } from './slack.ts';
import { createGithubPoller, ghErrorStatus, normalizeGraphql } from './github.ts';
import { createTimelineWriter, parseTimeline, pickRun } from './timeline.ts';
import { computeTimes, formatTimes } from './timings.ts';
import { derive } from './rules.ts';
import type { RuleConfig } from './rules.ts';
import { inputsAt, SIMULATION_LENGTH_S } from './simulate.ts';
import type { DemoEvent, GithubSnapshot, LoopState, Milestones, SourceStatus } from './types.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'loop-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

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
const BASE = Date.parse('2026-11-03T10:00:00.000Z');

describe('config', () => {
  it('parses the modes and refuses bad values', () => {
    expect(parseArgs([]).mode).toBe('live');
    const r = parseArgs(['--replay', 'x.jsonl', '--speed', '4', '--run', '2', '--port', '4201']);
    expect(r).toMatchObject({ mode: 'replay', replayFile: 'x.jsonl', speed: 4, run: 2, port: 4201 });
    expect(parseArgs(['--simulate', '--at', '0']).at).toBe(0);
    expect(() => parseArgs(['--speed', '0'])).toThrow(/positive/);
    expect(() => parseArgs(['--port'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--record', 'a.jsonl'])).toThrow(/only works with --simulate/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
  });

  it('reads demo/.env, lets the environment win, and never shows the token', () => {
    const root = tempDir();
    mkdirSync(join(root, 'demo'));
    writeFileSync(join(root, 'demo/.env'), '# values\nSLACK_BOT_TOKEN="xoxb-secret-value"\nexport GITHUB_REPO=someone/else\nOWNER_NAME=\nLOOP_PORT=4300\n');
    const c = loadConfig(parseArgs([]), { GITHUB_REPO: 'env/wins' }, root);
    expect(c.slack.token).toBe('xoxb-secret-value');
    expect(c.github.repo).toBe('env/wins');
    expect(c.ownerName).toBe('Harley');
    expect(c.port).toBe(4300);
    expect(c.eventsFile).toBe(join(root, 'demo/state/events.jsonl'));
    const shown = describeConfig(c);
    expect(shown).not.toContain('xoxb');
    expect(shown).toContain('set (hidden)');
  });

  it('parses env lines with quotes and comments', () => {
    expect(parseEnvFile("A='one'\n#B=2\nC = three\nbad\n=x")).toEqual({ A: 'one', C: 'three' });
  });
});

describe('events', () => {
  it('skips unreadable lines and keeps what follows the last reset', () => {
    const text = ['{"ts":"2026-11-03T10:00:00Z","type":"up"}', 'nope', '{"type":"x"}', '{"ts":"2026-11-03T10:01:00Z","type":"reset"}', '{"ts":"2026-11-03T10:02:00Z","type":"break","data":{"mode":"rehearsal"}}'].join('\n');
    const p = parseEventLines(text);
    expect(p.bad).toBe(2);
    expect(sinceLastReset(p.events).map((e) => e.type)).toEqual(['reset', 'break']);
  });

  it('tails appends, holds a partial line, and starts over when the file is truncated', () => {
    const file = join(tempDir(), 'events.jsonl');
    const seen: { types: string[]; reset: boolean }[] = [];
    const statuses: SourceStatus[] = [];
    const tail = createEventsTail({ file, intervalMs: 60_000, onEvents: (e: DemoEvent[], reset) => seen.push({ types: e.map((x) => x.type), reset }), onStatus: (s) => statuses.push(s) });
    try {
      expect(statuses.at(-1)?.note).toBe('no events file yet');
      writeFileSync(file, '{"ts":"2026-11-03T10:00:00Z","type":"up"}\n{"ts":"2026-11-03T10:01:00Z","ty');
      tail.pollOnce();
      expect(seen.at(-1)?.types).toEqual(['up']);
      appendFileSync(file, 'pe":"break"}\n');
      tail.pollOnce();
      expect(seen.at(-1)?.types).toEqual(['up', 'break']);
      writeFileSync(file, '{"ts":"2026-11-03T11:00:00Z","type":"up"}\n');
      tail.pollOnce();
      expect(seen.at(-1)).toEqual({ types: ['up'], reset: true });
      expect(statuses.at(-1)?.state).toBe('ok');
    } finally {
      tail.stop();
    }
  });
});

type Call = { url: string; auth: string };
function fakeSlack(answers: Record<string, unknown>, calls: Call[]) {
  return async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.Authorization ?? '' });
    const method = new URL(url).pathname.replace('/api/', '');
    const body = answers[method] ?? { ok: false, error: 'unknown_method' };
    return { status: 200, headers: { get: () => null }, json: async () => body };
  };
}

describe('slack', () => {
  it('maps the errors the room needs to read', () => {
    expect(slackErrorStatus('missing_scope', '')).toEqual({ state: 'error', note: 'needs groups:history' });
    expect(slackErrorStatus('missing_scope', 'channels:history')).toEqual({ state: 'error', note: 'needs channels:history' });
    expect(slackErrorStatus('not_in_channel', '').note).toBe('app not in the channel');
    expect(slackErrorStatus('invalid_auth', '').note).toBe('token rejected');
  });

  it('flattens text from blocks and attachments', () => {
    const t = flattenText({ text: 'top', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Approval needed*' } }], attachments: [{ text: 'att', actions: [{ url: 'https://github.com/o/r/pull/7' }] }] });
    expect(t).toContain('*Approval needed*');
    expect(t).toContain('https://github.com/o/r/pull/7');
  });

  it('reports a missing history scope on a private channel', async () => {
    const calls: Call[] = [];
    const updates: SlackUpdate[] = [];
    const p = createSlackPoller({ token: 'xoxb-t', intervalMs: 1000, autoStart: false, onUpdate: (u) => updates.push(u), fetchImpl: fakeSlack({ 'auth.test': { ok: true, user_id: 'UMON', bot_id: 'BMON' }, 'conversations.replies': { ok: false, error: 'missing_scope', needed: 'groups:history' } }, calls) });
    p.setTarget({ channel: 'G1', ts: '1.000' });
    await p.pollOnce();
    expect(updates.at(-1)?.status).toEqual({ state: 'error', note: 'needs groups:history' });
    expect(updates.at(-1)?.identity).toEqual({ userId: 'UMON', botId: 'BMON' });
    expect(calls.every((c) => !c.url.includes('xoxb'))).toBe(true);
    expect(calls.every((c) => c.auth === 'Bearer xoxb-t')).toBe(true);
  });

  it('reports an app that is not in the channel', async () => {
    const updates: SlackUpdate[] = [];
    const p = createSlackPoller({ token: 'xoxb-t', intervalMs: 1000, autoStart: false, onUpdate: (u) => updates.push(u), fetchImpl: fakeSlack({ 'auth.test': { ok: true, user_id: 'UMON' }, 'conversations.replies': { ok: false, error: 'not_in_channel' } }, []) });
    p.setTarget({ channel: 'G1', ts: '1.000' });
    await p.pollOnce();
    expect(updates.at(-1)?.status.note).toBe('app not in the channel');
  });

  it('reads replies and keeps the first time each reaction was seen', async () => {
    const updates: SlackUpdate[] = [];
    let clock = '2026-11-03T10:00:05.000Z';
    const replies = { ok: true, messages: [{ ts: '1.000', text: 'FIRING', reactions: [{ name: 'eyes', users: ['URUN'] }] }, { ts: '2.000', user: 'URUN', bot_id: 'BRUN', text: 'Triage note' }] };
    const p = createSlackPoller({ token: 'xoxb-t', intervalMs: 1000, autoStart: false, now: () => clock, onUpdate: (u) => updates.push(u), fetchImpl: fakeSlack({ 'auth.test': { ok: true, user_id: 'UMON' }, 'conversations.replies': replies }, []) });
    p.setTarget({ channel: 'G1', ts: '1.000' });
    await p.pollOnce();
    clock = '2026-11-03T10:00:09.000Z';
    await p.pollOnce();
    const th = updates.at(-1)?.thread;
    expect(th?.replies.map((r) => r.text)).toEqual(['Triage note']);
    expect(th?.reactions).toEqual([{ name: 'eyes', user: 'URUN', firstSeen: '2026-11-03T10:00:05.000Z' }]);
  });

  it('says so when there is no token, without calling Slack', async () => {
    const calls: Call[] = [];
    const updates: SlackUpdate[] = [];
    const p = createSlackPoller({ token: '', intervalMs: 1000, autoStart: false, onUpdate: (u) => updates.push(u), fetchImpl: fakeSlack({}, calls) });
    await p.pollOnce();
    expect(calls).toHaveLength(0);
    expect(updates.at(-1)?.status.note).toBe('no token in demo/.env');
  });
});

describe('github', () => {
  it('normalises the graphql answer', () => {
    const ctx = { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'Lint, typecheck and test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-03T10:05:00Z', detailsUrl: 'u', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
      { __typename: 'CheckRun', name: 'droid-review', status: 'IN_PROGRESS', conclusion: null, completedAt: null, detailsUrl: 'u2', checkSuite: null },
      { __typename: 'StatusContext', context: 'legacy', state: 'FAILURE', targetUrl: 't', createdAt: '2026-11-03T10:06:00Z' },
    ] } };
    const snap: GithubSnapshot = normalizeGraphql({ data: { rateLimit: { remaining: 4800 }, repository: {
      pullRequests: { nodes: [{ number: 7, title: 'fix: yen', url: 'pr7', state: 'OPEN', createdAt: '2026-11-03T10:04:00Z', mergedAt: null, headRefName: 'fix/yen', baseRefName: 'main', headRefOid: 'abc', additions: 3, deletions: 1, changedFiles: 2, author: { login: 'factory-droid[bot]' }, commits: { nodes: [{ commit: { oid: 'abc', messageHeadline: 'test: yen', committedDate: '2026-11-03T10:03:00Z', url: 'c', statusCheckRollup: ctx } }] }, reviews: { nodes: [{ author: { login: 'factory-harley-chen' }, state: 'APPROVED', submittedAt: '2026-11-03T10:09:00Z', url: 'r' }] }, mergeCommit: null }] },
      refs: { nodes: [{ name: 'yen', target: { history: { nodes: [{ oid: 'abc', messageHeadline: 'test: yen', committedDate: '2026-11-03T10:03:00Z', url: 'c' }] } } }] },
    } } });
    expect(snap.rateRemaining).toBe(4800);
    const pr = snap.pulls[0];
    expect(pr?.commits[0]?.checks.map((c) => [c.name, c.workflow, c.state])).toEqual([['Lint, typecheck and test', 'CI', 'green'], ['droid-review', null, 'pending'], ['legacy', null, 'red']]);
    expect(pr?.reviews[0]?.state).toBe('APPROVED');
    expect(pr?.mergeCommit).toBeNull();
    expect(snap.branches[0]?.name).toBe('fix/yen');
  });

  it('maps gh failures to short notes', () => {
    expect(ghErrorStatus('Could not resolve to a Repository with the name').note).toBe('repo not found');
    expect(ghErrorStatus('To get started with GitHub CLI, please run:  gh auth login').note).toBe('gh not signed in');
    expect(ghErrorStatus('spawn gh ENOENT').note).toBe('gh not installed');
    expect(ghErrorStatus('error connecting to api.github.com\ncould not connect').note).toBe('offline');
    expect(ghErrorStatus('API rate limit exceeded').state).toBe('waiting');
  });

  it('reports graphql errors and slows down when the budget is low', async () => {
    const seen: SourceStatus[] = [];
    let answer = JSON.stringify({ errors: [{ message: 'Could not resolve to a Repository' }] });
    const p = createGithubPoller({ repo: 'o/r', activeMs: 10, idleMs: 10, autoStart: false, run: async () => answer, onUpdate: (_s, st) => seen.push(st) });
    await p.pollOnce();
    expect(seen.at(-1)?.note).toBe('repo not found');
    answer = JSON.stringify({ data: { rateLimit: { remaining: 100 }, repository: { pullRequests: { nodes: [] }, refs: { nodes: [] } } } });
    await p.pollOnce();
    expect(seen.at(-1)).toEqual({ state: 'waiting', note: 'rate limit low, slowing' });
    const bad = createGithubPoller({ repo: 'nope', activeMs: 10, idleMs: 10, autoStart: false, run: async () => '', onUpdate: (_s, st) => seen.push(st) });
    await bad.pollOnce();
    expect(seen.at(-1)?.note).toBe('GITHUB_REPO is not owner/name');
  });
});

function stateAt(sec: number): LoopState {
  return derive(inputsAt(sec, BASE), cfg);
}

describe('simulation through the real rules', () => {
  it('starts idle and ends with every station done and the loop fixed', () => {
    const start = stateAt(0);
    expect(start.loop).toBe('idle');
    const end = stateAt(SIMULATION_LENGTH_S);
    expect(end.loop).toBe('fixed');
    expect(end.stations.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    const m = end.milestones;
    const order: (keyof Milestones)[] = ['break', 'alert', 'triage', 'testCommit', 'fixPrOpened', 'checksGreen', 'approved', 'merged', 'deployDone', 'alertCleared'];
    const times = order.map((k) => m[k]);
    expect(times.every((x) => x !== null)).toBe(true);
    expect([...times].sort()).toEqual(times);
  });
});

describe('timeline and timings', () => {
  it('groups snapshots into runs and prints the timings of the last one', () => {
    const file = join(tempDir(), 'timeline.jsonl');
    const w = createTimelineWriter(file);
    w.meta('simulate', new Date(BASE).toISOString());
    for (const sec of [0, 20, 60, 100, SIMULATION_LENGTH_S]) w.write(new Date(BASE + sec * 1000).toISOString(), stateAt(sec));
    appendFileSync(file, 'not json\n');
    const runs = parseTimeline(readFileSync(file, 'utf8'));
    expect(runs).toHaveLength(1);
    const run = pickRun(runs, null);
    expect(run?.source).toBe('simulate');
    expect(run?.lead?.state.runKey).toBeNull();
    expect(pickRun(runs, 5)).toBeNull();
    if (run === null || run === undefined) throw new Error('no run');
    const out = formatTimes(run, file);
    expect(out).toContain('Timings for run 1 (simulate');
    expect(out).toMatch(/Alert to approval request\s+\d+:\d\d\s+pass/);
  });

  it('judges the approval-request time against its target and limit', () => {
    const empty = Object.fromEntries(Object.keys(stateAt(0).milestones).map((k) => [k, null]));
    const m = (alertToApproval: number): Milestones => ({ ...stateAt(0).milestones, ...empty, alert: new Date(BASE).toISOString(), approvalRequested: new Date(BASE + alertToApproval * 1000).toISOString() });
    const row = (sec: number) => computeTimes(m(sec)).find((r) => r.label === 'Alert to approval request')?.verdict ?? '';
    expect(row(8 * 60)).toMatch(/^pass/);
    expect(row(9 * 60 + 30)).toMatch(/^over target/);
    expect(row(10 * 60)).toMatch(/^FAIL/);
    expect(computeTimes({ ...m(60), approvalRequested: null }).find((r) => r.label === 'Alert to approval request')?.verdict).toBe('not reached');
  });
});
