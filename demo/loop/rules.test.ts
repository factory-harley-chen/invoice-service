import { describe, expect, it } from 'vitest';
import { approvalPrUrl, derive, extractUrls, hasLine, permalink, runEvents, summariseChecks } from './rules.ts';
import type { RuleConfig } from './rules.ts';
import type { DemoEvent, GhCheck, GhCommit, GhPull, Inputs, LoopState, Station, StationKey } from './types.ts';
import { msToSlackTs } from './time.ts';

const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const t = (s: number) => new Date(T0 + s * 1000).toISOString();
const sts = (s: number) => msToSlackTs(T0 + s * 1000);
const CH = 'C0REHEARSAL';
const MON = { userId: 'UMONITOR', botId: 'BMONITOR' };
const RUN = { user: 'URUN', botId: 'BRUN' };

const cfg: RuleConfig = {
  botLogin: 'factory-droid[bot]',
  ownerLogin: 'factory-harley-chen',
  ownerName: 'Harley',
  runIdentity: 'invoice-oncall',
  workspaceUrl: 'https://factory-gtm.slack.com',
  demoMode: 'rehearsal',
  checks: { tests: 'Lint, typecheck and test', codeReview: 'droid.?review|code.?review', securityReview: 'security' },
  banner: null,
};

function ev(s: number, type: string, data: Record<string, unknown> = {}): DemoEvent {
  return { ts: t(s), type, data };
}

function alertAt(s: number): DemoEvent {
  return ev(s, 'alert_fired', {
    channel: CH,
    ts: sts(s),
    permalink: `https://factory-gtm.slack.com/archives/${CH}/p1`,
    bookingId: 'B-1042',
    customer: 'Sakura Lane Design',
    item: 'Kyoto hotel',
    quantity: 1,
    currency: 'JPY',
    expected: { minor: 12000, formatted: '\u00a512,000' },
    actual: { minor: 1200000, formatted: '\u00a51,200,000' },
  });
}

function inputs(events: DemoEvent[]): Inputs {
  const ok = { state: 'ok' as const, note: '' };
  return { events, slackIdentity: { ...MON }, thread: null, github: { pulls: [], branches: [], rateRemaining: 4000 }, sources: { slack: ok, github: ok, monitor: ok } };
}

function thread(inp: Inputs, alertS: number, replies: [number, string, 'run' | 'monitor'][]): void {
  inp.thread = {
    channel: CH,
    threadTs: sts(alertS),
    replies: replies.map(([s, text, from]) => ({
      ts: sts(s),
      user: from === 'run' ? RUN.user : MON.userId,
      botId: from === 'run' ? RUN.botId : MON.botId,
      subtype: 'bot_message',
      text,
    })),
    reactions: [],
  };
}

function check(name: string, state: GhCheck['state'], s: number | null, workflow: string | null = null): GhCheck {
  return { name, workflow, state, completedAt: s === null ? null : t(s), url: '' };
}

function commit(oid: string, s: number, headline: string, checks: GhCheck[] = []): GhCommit {
  return { oid, headline, committedAt: t(s), url: `https://github.com/o/r/commit/${oid}`, checks };
}

function pull(over: Partial<GhPull>): GhPull {
  return {
    number: 12,
    title: 'Read yen prices with no minor units',
    url: 'https://github.com/factory-harley-chen/invoice-service/pull/12',
    state: 'OPEN',
    createdAt: t(200),
    mergedAt: null,
    headRef: 'fix/jpy',
    baseRef: 'main',
    headOid: 'b2',
    author: 'factory-droid',
    additions: 9,
    deletions: 2,
    changedFiles: 2,
    commits: [commit('b1', 150, 'test: B-1042 yen invoice is 100 times too high'), commit('b2', 190, 'fix: yen has no minor units')],
    reviews: [],
    mergeCommit: null,
    ...over,
  };
}

function st(state: LoopState, key: StationKey): Station {
  const s = state.stations.find((x) => x.key === key);
  if (s === undefined) throw new Error(`no station ${key}`);
  return s;
}

const green = (s: number) => [check('Lint, typecheck and test', 'green', s, 'CI'), check('droid-review', 'green', s + 5, 'Droid Auto Review')];

describe('before and at the break', () => {
  it('is idle with no events, whatever GitHub has', () => {
    const inp = inputs([]);
    inp.github?.pulls.push(pull({}));
    const s = derive(inp, cfg);
    expect(s.loop).toBe('idle');
    expect(s.clockFrom).toBeNull();
    expect(s.stations.every((x) => x.status === 'idle')).toBe(true);
    expect(s.banner).toEqual({ kind: 'rehearsal', text: 'Rehearsal' });
  });

  it('starts the clock at the break but keeps the loop neutral until the alert', () => {
    const s = derive(inputs([ev(0, 'up', { mode: 'live' }), ev(5, 'break', { mode: 'live', currencies: ['JPY'] })]), cfg);
    expect(s.clockFrom).toBe(t(5));
    expect(s.loop).toBe('idle');
    expect(s.banner.kind).toBe('live');
    expect(st(s, 'signal').status).toBe('idle');
  });
});

describe('1 Signal', () => {
  it('turns the loop red with the alert time and fills the invoice card', () => {
    const s = derive(inputs([ev(0, 'break'), alertAt(10)]), cfg);
    expect(s.loop).toBe('broken');
    const sig = st(s, 'signal');
    expect(sig.status).toBe('active');
    expect(sig.at).toBe(t(10));
    expect(sig.timeText).toBe('10:00');
    expect(sig.answer).toBe('Alert: B-1042 billed \u00a51,200,000');
    expect(s.invoice).toMatchObject({ bookingId: 'B-1042', line: 'Kyoto hotel, 1 night', expected: '\u00a512,000', actual: '\u00a51,200,000', fixed: false });
  });

  it("ignores the monitor's own replies and completes on the first other reply", () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    thread(inp, 10, [[12, 'FIRING again', 'monitor']]);
    expect(st(derive(inp, cfg), 'signal').status).toBe('active');
    thread(inp, 10, [[12, 'FIRING again', 'monitor'], [75, 'Looking into this alert.', 'run']]);
    const s = derive(inp, cfg);
    expect(st(s, 'signal').status).toBe('done');
    expect(s.milestones.runStarted).toBe(t(75));
    expect(st(s, 'signal').answer).toBe('The alert. The run started at 10:01 on its own');
  });

  it('counts a reaction on the alert as the run starting, at first sight', () => {
    const inp = inputs([alertAt(10)]);
    thread(inp, 10, []);
    if (inp.thread !== null) inp.thread.reactions = [{ name: 'eyes', user: RUN.user, firstSeen: t(14) }, { name: 'eyes', user: MON.userId, firstSeen: t(11) }];
    expect(derive(inp, cfg).milestones.runStarted).toBe(t(14));
  });

  it('ignores a thread for a different alert', () => {
    const inp = inputs([alertAt(10)]);
    thread(inp, 99, [[100, 'Triage note', 'run']]);
    expect(st(derive(inp, cfg), 'signal').status).toBe('active');
  });
});

describe('2 Triage', () => {
  it('lights on the triage note when it comes first, then shows the test title', () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    thread(inp, 10, [[20, 'On it', 'run'], [100, ':mag: *Triage note*\nB-1042 is 100 times too high', 'run']]);
    let s = derive(inp, cfg);
    expect(st(s, 'triage')).toMatchObject({ status: 'done', at: t(100), answer: 'Triage note in the thread' });
    expect(st(s, 'triage').url).toContain(`thread_ts=${sts(10)}`);
    inp.github?.branches.push({ name: 'fix/jpy', commits: [commit('b1', 140, 'test: B-1042 yen invoice is 100 times too high')] });
    s = derive(inp, cfg);
    expect(st(s, 'triage').at).toBe(t(100));
    expect(st(s, 'triage').answer).toBe('Failing test: B-1042 yen invoice is 100 times too high');
  });

  it('lights on the failing-test commit when it comes before the note', () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    thread(inp, 10, [[20, 'On it', 'run'], [300, 'Triage note: ...', 'run']]);
    inp.github?.branches.push({ name: 'fix/jpy', commits: [commit('b0', -9000, 'test: an old commit'), commit('b1', 140, 'test(invoice): yen totals')] });
    const s = derive(inp, cfg);
    expect(st(s, 'triage').at).toBe(t(140));
    expect(st(s, 'triage').answer).toBe('Failing test: yen totals');
    expect(s.milestones.triageNote).toBe(t(300));
  });

  it('works when the run posts only its final answer (one reply with both markers)', () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    thread(inp, 10, [[500, 'Triage note\nIt is the minor units.\n\nApproval needed\n<https://github.com/factory-harley-chen/invoice-service/pull/12|PR 12>', 'run']]);
    const s = derive(inp, cfg);
    expect(st(s, 'signal').status).toBe('done');
    expect(s.milestones.runStarted).toBe(t(500));
    expect(st(s, 'triage').at).toBe(t(500));
    expect(st(s, 'ship')).toMatchObject({ status: 'waiting', waitingSince: t(500), url: 'https://github.com/factory-harley-chen/invoice-service/pull/12' });
  });

  it('marks station 1 done from GitHub evidence when Slack shows nothing', () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    inp.github?.branches.push({ name: 'fix/jpy', commits: [commit('b1', 140, 'test: yen')] });
    const s = derive(inp, cfg);
    expect(st(s, 'signal').status).toBe('done');
    expect(s.milestones.runStarted).toBe(t(140));
  });
});

describe('3 Change', () => {
  it("uses only the bot's fix/ PR opened in this run", () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    inp.github?.pulls.push(
      pull({ number: 3, createdAt: t(-5000), title: 'old run' }),
      pull({ number: 4, author: 'factory-harley-chen', title: 'human PR' }),
      pull({ number: 5, headRef: 'chore/x', title: 'other branch' }),
    );
    expect(st(derive(inp, cfg), 'change').status).toBe('idle');
    inp.github?.pulls.push(pull({}));
    const s = derive(inp, cfg);
    expect(st(s, 'change')).toMatchObject({ status: 'done', at: t(200), answer: 'Read yen prices with no minor units', meta: '2 files, +9 \u22122' });
    expect(st(s, 'change').url).toBe('https://github.com/factory-harley-chen/invoice-service/pull/12/files');
    expect(s.record.prAuthor).toBe('factory-droid[bot]');
  });

  it('prefers an open PR over one closed without merging', () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    inp.github?.pulls.push(pull({ number: 11, state: 'CLOSED', title: 'first try' }), pull({ number: 12, createdAt: t(260), title: 'second try' }));
    expect(st(derive(inp, cfg), 'change').answer).toBe('second try');
  });
});

describe('4 Check', () => {
  const names = cfg.checks;

  it('is pending, then lit when tests and both reviews are green', () => {
    const p = pull({});
    p.commits[1]?.checks.push(check('Lint, typecheck and test', 'pending', null, 'CI'), check('droid-review', 'pending', null, 'Droid Auto Review'));
    let c = summariseChecks(p, names);
    expect(c.rows.map((r) => r.state)).toEqual(['pending', 'pending', 'pending']);
    expect(c.allGreen).toBe(false);
    if (p.commits[1] !== undefined) p.commits[1].checks = green(260);
    c = summariseChecks(p, names);
    expect(c.allGreen).toBe(true);
    expect(c.greenAt).toBe(t(265));
    expect(c.rows[2]?.note).toBe('same job as the code review');
  });

  it('uses a separate security check when there is one', () => {
    const p = pull({});
    if (p.commits[1] !== undefined) p.commits[1].checks = [...green(260), check('Security review', 'pending', null)];
    const c = summariseChecks(p, names);
    expect(c.rows.map((r) => r.state)).toEqual(['green', 'green', 'pending']);
    expect(c.allGreen).toBe(false);
  });

  it('takes the reviews from an older commit but the tests from the head', () => {
    const p = pull({ headOid: 'b3' });
    p.commits[1]?.checks.push(...green(260));
    p.commits.push(commit('b3', 300, 'fix: tidy', [check('Lint, typecheck and test', 'pending', null, 'CI')]));
    const c = summariseChecks(p, names);
    expect(c.rows.map((r) => r.state)).toEqual(['pending', 'green', 'green']);
  });

  it('shows red as failed', () => {
    const inp = inputs([ev(0, 'break'), alertAt(10)]);
    const p = pull({});
    if (p.commits[1] !== undefined) p.commits[1].checks = [check('Lint, typecheck and test', 'red', 250, 'CI'), check('droid-review', 'pending', null)];
    inp.github?.pulls.push(p);
    const s = derive(inp, cfg);
    expect(st(s, 'check').status).toBe('failed');
    expect(st(s, 'check').url).toBe('https://github.com/factory-harley-chen/invoice-service/pull/12/checks');
  });
});

function greenRun(extra: (inp: Inputs, p: GhPull) => void = () => undefined): Inputs {
  const inp = inputs([ev(0, 'break'), alertAt(10)]);
  thread(inp, 10, [[20, 'On it', 'run'], [100, 'Triage note', 'run'], [400, 'Approval needed\nhttps://github.com/factory-harley-chen/invoice-service/pull/12', 'run']]);
  const p = pull({});
  if (p.commits[1] !== undefined) p.commits[1].checks = green(300);
  inp.github?.pulls.push(p);
  extra(inp, p);
  return inp;
}

describe('5 Ship', () => {
  it('waits from the earlier of green checks and the approval request', () => {
    const s = derive(greenRun(), cfg);
    expect(st(s, 'check').at).toBe(t(305));
    expect(st(s, 'ship')).toMatchObject({ status: 'waiting', waitingSince: t(305), waitingLabel: 'Waiting for Harley', timeText: 'Asked 10:05' });
    expect(s.milestones.approvalRequested).toBe(t(400));
  });

  it('is approved but not done until the merge, then done', () => {
    const approved = (inp: Inputs, p: GhPull) => {
      p.reviews.push({ author: 'factory-droid', state: 'COMMENTED', submittedAt: t(330), url: '' }, { author: 'factory-harley-chen', state: 'APPROVED', submittedAt: t(600), url: '' });
    };
    let s = derive(greenRun(approved), cfg);
    expect(st(s, 'ship')).toMatchObject({ status: 'active', answer: 'Approved by Harley at 10:10', timeText: 'Not merged yet' });
    s = derive(
      greenRun((inp, p) => {
        approved(inp, p);
        p.mergedAt = t(640);
        p.state = 'MERGED';
      }),
      cfg,
    );
    expect(st(s, 'ship')).toMatchObject({ status: 'done', at: t(600), answer: 'Approved by Harley at 10:10', timeText: 'Merged 10:10' });
    expect(s.record).toMatchObject({ runAs: 'invoice-oncall', approver: 'Harley (factory-harley-chen)' });
  });

  it('says so if it merged without the owner approving', () => {
    const s = derive(
      greenRun((inp, p) => {
        p.reviews.push({ author: 'someone-else', state: 'APPROVED', submittedAt: t(600), url: '' });
        p.mergedAt = t(640);
      }),
      cfg,
    );
    expect(st(s, 'ship')).toMatchObject({ status: 'failed', answer: "Merged without Harley's approval" });
  });
});

describe('6 Confirmed fix and the return track', () => {
  const merged = (inp: Inputs, p: GhPull) => {
    p.reviews.push({ author: 'factory-harley-chen', state: 'APPROVED', submittedAt: t(600), url: '' });
    p.mergedAt = t(640);
    p.state = 'MERGED';
    p.mergeCommit = { oid: 'm1', url: 'https://github.com/o/r/commit/m1', checks: [check('Lint, typecheck and test', 'pending', null, 'CI')] };
  };

  it('steps through CI on main, the deploy and the alert clearing', () => {
    const inp = greenRun(merged);
    let s = derive(inp, cfg);
    expect(st(s, 'confirmed').status).toBe('active');
    expect(st(s, 'confirmed').rows.map((r) => r.state)).toEqual(['pending', 'idle', 'idle']);
    const p = inp.github?.pulls[0];
    if (p?.mergeCommit) p.mergeCommit.checks = [check('Lint, typecheck and test', 'green', 700, 'CI')];
    inp.events.push(ev(701, 'deploy_started', { sha: 'm1' }));
    s = derive(inp, cfg);
    expect(st(s, 'confirmed').rows.map((r) => r.state)).toEqual(['green', 'pending', 'idle']);
    inp.events.push(ev(720, 'deploy_done', { sha: 'm1', ciRunUrl: 'https://github.com/o/r/actions/runs/1' }));
    s = derive(inp, cfg);
    expect(st(s, 'confirmed').url).toBe('https://github.com/o/r/actions/runs/1');
    expect(s.leftBehind.visible).toBe(false);
    inp.events.push(ev(735, 'alert_resolved', { channel: CH, threadTs: sts(10), ts: sts(735), permalink: 'https://factory-gtm.slack.com/archives/C/p2', bookingId: 'B-1042' }));
    s = derive(inp, cfg);
    expect(st(s, 'confirmed')).toMatchObject({ status: 'done', at: t(735), url: 'https://factory-gtm.slack.com/archives/C/p2' });
    expect(s.loop).toBe('fixed');
    expect(s.fixedAt).toBe(t(735));
    expect(s.summary).toBe('Signal to confirmed fix: 12 min. People: 1 decision');
    expect(s.invoice?.fixed).toBe(true);
    expect(s.milestones).toMatchObject({ mainCiGreen: t(700), deployStarted: t(701), deployDone: t(720), alertCleared: t(735) });
    expect(s.leftBehind).toMatchObject({ visible: true, status: 'active', answer: 'Waiting for the new check' });
  });

  it('ignores a RESOLVED for another thread', () => {
    const inp = greenRun(merged);
    inp.events.push(ev(735, 'alert_resolved', { channel: CH, threadTs: '123.456', ts: sts(735), bookingId: 'B-1042' }));
    expect(derive(inp, cfg).loop).toBe('broken');
  });

  it('shows the check PR only after the fix is confirmed, lit when approved', () => {
    const inp = greenRun(merged);
    const checkPr = pull({ number: 13, headRef: 'check/every-currency', title: 'Check every currency', createdAt: t(650), url: 'https://github.com/o/r/pull/13', commits: [] });
    inp.github?.pulls.push(checkPr);
    let s = derive(inp, cfg);
    expect(s.leftBehind.visible).toBe(false);
    expect(s.milestones.checkPrOpened).toBe(t(650));
    inp.events.push(ev(735, 'alert_resolved', { channel: CH, threadTs: sts(10), ts: sts(735), bookingId: 'B-1042' }));
    s = derive(inp, cfg);
    expect(s.leftBehind).toMatchObject({ visible: true, status: 'waiting', answer: 'Check every currency', timeText: 'Opened 10:10', url: 'https://github.com/o/r/pull/13' });
    checkPr.reviews.push({ author: 'factory-harley-chen', state: 'APPROVED', submittedAt: t(800), url: '' });
    s = derive(inp, cfg);
    expect(s.leftBehind).toMatchObject({ status: 'done', at: t(800), timeText: 'Approved 10:13' });
    expect(s.milestones.checkPrApproved).toBe(t(800));
  });
});

describe('runs and resets', () => {
  it('a reset clears everything', () => {
    const s = derive(inputs([ev(0, 'break'), alertAt(10), ev(20, 'reset')]), cfg);
    expect(s.loop).toBe('idle');
    expect(s.runKey).toBeNull();
  });

  it('a new break starts a new run and drops the old alert', () => {
    const r = runEvents([ev(0, 'break'), alertAt(10), ev(100, 'break')]);
    expect(r.alert).toBeNull();
    expect(r.brk?.ts).toBe(t(100));
  });
});

describe('Slack text helpers', () => {
  it('finds markers through Slack formatting', () => {
    expect(hasLine('*Triage note*: B-1042', 'Triage note')).toBe(true);
    expect(hasLine('> \u2022 _Approval needed_', 'Approval needed')).toBe(true);
    expect(hasLine('\ud83d\udd0d Triage note', 'Triage note')).toBe(true);
    expect(hasLine('See the triage note below', 'Triage note')).toBe(false);
  });

  it('extracts Slack and bare URLs and the PR after "Approval needed"', () => {
    expect(extractUrls('see <https://a.example/x|x> and https://b.example/y.')).toEqual(['https://a.example/x', 'https://b.example/y']);
    const text = 'Old PR https://github.com/o/r/pull/3\nApproval needed\n<https://github.com/o/r/pull/12|PR 12>';
    expect(approvalPrUrl(text)).toBe('https://github.com/o/r/pull/12');
  });

  it('builds thread permalinks', () => {
    expect(permalink('https://factory-gtm.slack.com/', 'C1', '1762.000100', '1762.000001')).toBe('https://factory-gtm.slack.com/archives/C1/p1762000100?thread_ts=1762.000001&cid=C1');
    expect(permalink('', 'C1', '1', null)).toBe('');
  });
});
