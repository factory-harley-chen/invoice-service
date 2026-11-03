// The station rules: a pure function from what the sources have seen so far to
// what the screen shows. Every lit station takes its time from the source
// (Slack ts, GitHub timestamps, monitor event ts), not from when we polled it,
// so a lit station matches its real event even if a poll was slow.

import type {
  Banner,
  DemoEvent,
  GhCheck,
  GhCommit,
  GhPull,
  Inputs,
  InvoiceCard,
  LeftBehind,
  LoopState,
  Milestones,
  RecordCard,
  Row,
  RowState,
  SlackIdentity,
  SlackReply,
  Station,
  StationKey,
} from './types.ts';
import { num, obj, str } from './json.ts';
import { earliest, hhmm, latest, ms, notBefore, slackTsToIso } from './time.ts';

export type CheckNames = {
  /** Exact check-run name of the CI job (case-insensitive). */
  tests: string;
  /** Regular expression for the code review check (name or workflow). */
  codeReview: string;
  /** Regular expression for the security review check (name or workflow). */
  securityReview: string;
};

export type RuleConfig = {
  botLogin: string;
  ownerLogin: string;
  ownerName: string;
  runIdentity: string;
  workspaceUrl: string;
  demoMode: string;
  checks: CheckNames;
  /** Replaces the live/rehearsal banner (replay and simulation). */
  banner: Banner | null;
};

/** GitHub items created this long before the break still count (clock skew, a fast run). */
const MARGIN_MS = 120_000;

const STATIONS: { key: StationKey; name: string; question: string }[] = [
  { key: 'signal', name: 'Signal', question: 'What started it?' },
  { key: 'triage', name: 'Triage', question: 'What proved the fault?' },
  { key: 'change', name: 'Change', question: 'What changed?' },
  { key: 'check', name: 'Check', question: 'What decided it was right?' },
  { key: 'ship', name: 'Ship', question: 'Who owns it?' },
  { key: 'confirmed', name: 'Confirmed fix', question: 'Did it fix the problem?' },
];

export const LEFT_BEHIND_QUESTION = 'What did it leave behind?';

// ---------------------------------------------------------------------------
// Monitor events

export type RunEvents = {
  up: DemoEvent | null;
  brk: DemoEvent | null;
  alert: DemoEvent | null;
  resolved: DemoEvent | null;
  deployStarted: DemoEvent[];
  deployDone: DemoEvent[];
};

/** Folds events since the last reset; a new break starts a new run. */
export function runEvents(events: DemoEvent[]): RunEvents {
  const r: RunEvents = { up: null, brk: null, alert: null, resolved: null, deployStarted: [], deployDone: [] };
  for (const e of events) {
    switch (e.type) {
      case 'reset':
        r.up = null;
        r.brk = null;
        r.alert = null;
        r.resolved = null;
        r.deployStarted = [];
        r.deployDone = [];
        break;
      case 'up':
        r.up = e;
        break;
      case 'break':
        r.brk = e;
        r.alert = null;
        r.resolved = null;
        r.deployStarted = [];
        r.deployDone = [];
        break;
      case 'alert_fired':
        if (r.alert === null) r.alert = e;
        break;
      case 'alert_resolved': {
        if (r.alert === null || r.resolved !== null) break;
        const threadTs = str(e.data.threadTs);
        if (threadTs === '' || threadTs === str(r.alert.data.ts)) r.resolved = e;
        break;
      }
      case 'deploy_started':
        if (r.alert !== null) r.deployStarted.push(e);
        break;
      case 'deploy_done':
        if (r.alert !== null) r.deployDone.push(e);
        break;
      default:
        break;
    }
  }
  return r;
}

/** The alert whose thread the Slack poller should read, if any. */
export function currentAlert(events: DemoEvent[]): { channel: string; ts: string } | null {
  const { alert } = runEvents(events);
  if (alert === null) return null;
  const channel = str(alert.data.channel);
  const ts = str(alert.data.ts);
  return channel !== '' && ts !== '' ? { channel, ts } : null;
}

/** True while a run is under way (a break or an alert since the last reset). */
export function runActive(events: DemoEvent[]): boolean {
  const r = runEvents(events);
  return r.brk !== null || r.alert !== null;
}

// ---------------------------------------------------------------------------
// Slack text

function cleanLine(line: string): string {
  let s = line;
  for (let i = 0; i < 3; i += 1) {
    // Shortcodes go first: the punctuation strip would eat their leading colon.
    s = s
      .replace(/^\s*:[a-z0-9_+-]+:\s*/i, '')
      .replace(/^\s*\p{Extended_Pictographic}\uFE0F?\s*/u, '')
      .replace(/^[\s>*_~`#\-\u2022\u2013:]+/u, '');
  }
  return s;
}

/** True if a line of the message starts with marker, ignoring Slack formatting and a leading emoji. */
export function hasLine(text: string, marker: string): boolean {
  return lineIndex(text, marker) >= 0;
}

function lineIndex(text: string, marker: string): number {
  const want = marker.toLowerCase();
  return text.split(/\r?\n/).findIndex((line) => cleanLine(line).toLowerCase().startsWith(want));
}

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const re = /<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>|)]+)/g;
  for (const m of text.matchAll(re)) {
    const url = m[1] ?? m[2];
    if (url !== undefined) out.push(url.replace(/[.,;]+$/, ''));
  }
  return out;
}

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** The PR URL after the "Approval needed" line, else the first PR URL in the message. */
export function approvalPrUrl(text: string): string {
  const lines = text.split(/\r?\n/);
  const at = lineIndex(text, 'Approval needed');
  const after = at >= 0 ? lines.slice(at).join('\n') : text;
  const pick = (t: string) => extractUrls(t).map((u) => PR_URL.exec(u)?.[0]).find((u) => u !== undefined);
  return pick(after) ?? pick(text) ?? '';
}

const RUN_URL = /^https:\/\/app\.factory\.ai\//;

function isMonitor(r: SlackReply, id: SlackIdentity | null): boolean {
  if (id !== null && (r.user === id.userId || (id.botId !== null && r.botId === id.botId))) return true;
  // Without auth.test we can still recognise the monitor's own wording.
  return id === null && /^\s*\*?(FIRING|RESOLVED)\b/.test(r.text);
}

export function permalink(workspaceUrl: string, channel: string, ts: string, threadTs: string | null): string {
  if (workspaceUrl === '' || channel === '' || ts === '') return '';
  const base = `${workspaceUrl.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs !== null && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

// ---------------------------------------------------------------------------
// GitHub

export function sameLogin(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\[bot\]$/, '');
  return n(a) === n(b);
}

function pickPull(pulls: GhPull[]): GhPull | null {
  const sorted = [...pulls].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const live = sorted.find((p) => !(p.state === 'CLOSED' && p.mergedAt === null));
  return live ?? sorted[sorted.length - 1] ?? null;
}

function isTestCommit(c: GhCommit): boolean {
  return /^test(\([^)]*\))?!?:/i.test(c.headline.trim());
}

function rowState(c: GhCheck | null): RowState {
  return c === null ? 'pending' : c.state;
}

export type CheckSummary = {
  rows: Row[];
  allGreen: boolean;
  anyRed: boolean;
  greenAt: string | null;
};

/**
 * Tests come from the PR head. The reviews come from the newest PR commit that
 * has them, because the review workflow runs when the PR opens and not on every
 * push. If no separate security check exists, the code review job stands for
 * both: the October demo's single droid-review job ran both reviews and posted
 * one comment with a security badge.
 */
export function summariseChecks(pr: GhPull, names: CheckNames): CheckSummary {
  const head = pr.commits.find((c) => c.oid === pr.headOid) ?? pr.commits[pr.commits.length - 1] ?? null;
  const testsName = names.tests.toLowerCase();
  const isTests = (k: GhCheck) => k.name.toLowerCase() === testsName;
  const secRe = new RegExp(names.securityReview, 'i');
  const reviewRe = new RegExp(names.codeReview, 'i');
  const matches = (re: RegExp, k: GhCheck) => re.test(k.name) || (k.workflow !== null && re.test(k.workflow));
  const newestFirst = [...pr.commits].reverse();
  const findLatest = (pred: (k: GhCheck) => boolean): GhCheck | null => {
    for (const c of newestFirst) {
      const k = c.checks.find(pred);
      if (k !== undefined) return k;
    }
    return null;
  };
  const tests = head?.checks.find(isTests) ?? null;
  const security = findLatest((k) => !isTests(k) && secRe.test(k.name));
  const review = findLatest((k) => !isTests(k) && !secRe.test(k.name) && matches(reviewRe, k));
  const securityShown = security ?? review;
  const rows: Row[] = [
    { label: 'Tests and types', state: rowState(tests), note: '' },
    { label: 'Code review', state: rowState(review), note: '' },
    { label: 'Security review', state: rowState(securityShown), note: security === null && review !== null ? 'same job as the code review' : '' },
  ];
  const parts = [tests, review, securityShown];
  const allGreen = parts.every((k) => k !== null && k.state === 'green');
  const anyRed = parts.some((k) => k !== null && k.state === 'red');
  return { rows, allGreen, anyRed, greenAt: allGreen ? latest(parts.map((k) => k?.completedAt)) : null };
}

// ---------------------------------------------------------------------------
// Wording

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function unitFor(item: string, unit: string): string {
  if (unit !== '') return unit;
  if (/hotel/i.test(item)) return 'night';
  if (/transfer/i.test(item)) return 'trip';
  return '';
}

function invoiceLine(item: string, quantity: number, unit: string): string {
  const u = unitFor(item, unit);
  return u === '' ? `${item}, quantity ${quantity}` : `${item}, ${plural(quantity, u)}`;
}

function stripPrefix(headline: string): string {
  return headline.replace(/^test(\([^)]*\))?!?:\s*/i, '');
}

// ---------------------------------------------------------------------------

function station(key: StationKey): Station {
  const def = STATIONS.findIndex((s) => s.key === key);
  const s = STATIONS[def];
  if (s === undefined) throw new Error(`unknown station ${key}`);
  return {
    n: def + 1,
    key,
    name: s.name,
    question: s.question,
    status: 'idle',
    answer: '',
    meta: '',
    rows: [],
    at: null,
    timeText: '',
    waitingSince: null,
    waitingLabel: '',
    url: '',
  };
}

function emptyMilestones(): Milestones {
  return {
    break: null,
    alert: null,
    runStarted: null,
    triage: null,
    triageNote: null,
    testCommit: null,
    fixPrOpened: null,
    checksGreen: null,
    approvalRequested: null,
    waitStarted: null,
    approved: null,
    merged: null,
    mainCiGreen: null,
    deployStarted: null,
    deployDone: null,
    alertCleared: null,
    checkPrOpened: null,
    checkPrApproved: null,
  };
}

function bannerFor(cfg: RuleConfig, up: DemoEvent | null): Banner {
  if (cfg.banner !== null) return cfg.banner;
  const mode = up !== null ? str(up.data.mode, cfg.demoMode) : cfg.demoMode;
  return mode === 'live' ? { kind: 'live', text: 'Live' } : { kind: 'rehearsal', text: 'Rehearsal' };
}

export function derive(inp: Inputs, cfg: RuleConfig): LoopState {
  const ev = runEvents(inp.events);
  const m = emptyMilestones();
  const stations = STATIONS.map((s) => station(s.key));
  const [signal, triage, change, check, ship, confirmed] = stations as [Station, Station, Station, Station, Station, Station];
  const leftBehind: LeftBehind = { question: LEFT_BEHIND_QUESTION, visible: false, status: 'idle', answer: '', at: null, timeText: '', url: '' };
  const record: RecordCard = {
    runAs: cfg.runIdentity !== '' ? cfg.runIdentity : 'not set',
    prAuthor: 'waiting',
    approver: 'waiting',
    approvedAt: null,
    runUrl: '',
  };
  const state: LoopState = {
    version: 1,
    runKey: null,
    banner: bannerFor(cfg, ev.up),
    loop: 'idle',
    clockFrom: null,
    fixedAt: null,
    summary: '',
    stations,
    leftBehind,
    invoice: null,
    record,
    sources: inp.sources,
    milestones: m,
  };

  m.break = ev.brk?.ts ?? null;
  m.alert = ev.alert?.ts ?? null;
  state.runKey = m.break ?? m.alert;
  state.clockFrom = m.break ?? m.alert;
  if (ev.alert === null) return state;

  const alert = ev.alert;
  const alertAt = alert.ts;
  const since = ms(m.break ?? alertAt) - MARGIN_MS;
  const alertChannel = str(alert.data.channel);
  const alertTs = str(alert.data.ts);
  state.loop = 'broken';

  // Invoice card
  const expected = obj(alert.data.expected);
  const actual = obj(alert.data.actual);
  const stagingUrl = ev.up !== null ? str(ev.up.data.stagingUrl) : '';
  const bookingId = str(alert.data.bookingId);
  const invoice: InvoiceCard = {
    bookingId,
    customer: str(alert.data.customer),
    line: invoiceLine(str(alert.data.item), num(alert.data.quantity, 1), str(alert.data.unit)),
    expected: str(expected.formatted),
    actual: str(actual.formatted),
    fixed: ev.resolved !== null,
    url: stagingUrl !== '' && bookingId !== '' ? `${stagingUrl.replace(/\/$/, '')}/invoices/${bookingId}` : '',
  };
  state.invoice = invoice;

  // Slack thread
  const thread = inp.thread !== null && inp.thread.threadTs === alertTs ? inp.thread : null;
  const replies = (thread?.replies ?? [])
    .filter((r) => r.ts !== alertTs && !isMonitor(r, inp.slackIdentity))
    .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  const replyAt = (r: SlackReply | undefined) => (r === undefined ? null : slackTsToIso(r.ts));
  const replyLink = (r: SlackReply | undefined) => (r === undefined ? '' : permalink(cfg.workspaceUrl, alertChannel, r.ts, alertTs));
  const firstReply = replies[0];
  const triageReply = replies.find((r) => hasLine(r.text, 'Triage note'));
  const approvalReply = replies.find((r) => hasLine(r.text, 'Approval needed'));
  const reaction = [...(thread?.reactions ?? [])]
    .filter((x) => inp.slackIdentity === null || x.user !== inp.slackIdentity.userId)
    .sort((a, b) => ms(a.firstSeen) - ms(b.firstSeen))[0];
  for (const r of replies) {
    const run = extractUrls(r.text).find((u) => RUN_URL.test(u));
    if (run !== undefined) {
      record.runUrl = run;
      break;
    }
  }

  // GitHub
  const gh = inp.github;
  const botPulls = (gh?.pulls ?? []).filter((p) => sameLogin(p.author, cfg.botLogin) && ms(p.createdAt) >= since);
  const fixPr = pickPull(botPulls.filter((p) => p.headRef.startsWith('fix/')));
  const checkPr = pickPull(botPulls.filter((p) => p.headRef.startsWith('check/')));
  const fixBranchCommits = (gh?.branches ?? [])
    .filter((b) => b.name.startsWith('fix/') && (fixPr === null || b.name === fixPr.headRef))
    .flatMap((b) => b.commits);
  const testCommit = [...(fixPr?.commits ?? []), ...fixBranchCommits]
    .filter((c) => isTestCommit(c) && ms(c.committedAt) >= since)
    .sort((a, b) => ms(a.committedAt) - ms(b.committedAt))[0];

  m.triageNote = replyAt(triageReply);
  m.testCommit = notBefore(testCommit?.committedAt ?? null, alertAt);
  m.fixPrOpened = notBefore(fixPr?.createdAt ?? null, alertAt);
  m.approvalRequested = replyAt(approvalReply);

  // 1 Signal: the alert, then the first reply that is not the monitor's own.
  const directStart = earliest([replyAt(firstReply), reaction?.firstSeen]);
  const runStarted = notBefore(directStart ?? earliest([m.triageNote, m.testCommit, m.fixPrOpened]), alertAt);
  m.runStarted = runStarted;
  signal.at = alertAt;
  signal.url = str(alert.data.permalink) || permalink(cfg.workspaceUrl, alertChannel, alertTs, null);
  if (runStarted === null) {
    signal.status = 'active';
    signal.answer = `Alert: ${bookingId} billed ${invoice.actual}`;
    signal.timeText = hhmm(alertAt);
  } else {
    signal.status = 'done';
    signal.answer = `The alert. The run started at ${hhmm(runStarted)} on its own`;
    signal.timeText = hhmm(alertAt);
  }

  // 2 Triage: the earlier of the triage note and the failing-test commit.
  m.triage = earliest([m.triageNote, m.testCommit]);
  if (m.triage !== null) {
    triage.status = 'done';
    triage.at = m.triage;
    triage.timeText = hhmm(m.triage);
    triage.answer = testCommit !== undefined ? `Failing test: ${stripPrefix(testCommit.headline)}` : 'Triage note in the thread';
    triage.url = triageReply !== undefined ? replyLink(triageReply) : (testCommit?.url ?? '');
  }

  // 3 Change: the bot's PR from a fix/ branch.
  if (fixPr !== null) {
    change.status = 'done';
    change.at = m.fixPrOpened;
    change.timeText = hhmm(m.fixPrOpened);
    change.answer = fixPr.title;
    change.meta = `${plural(fixPr.changedFiles, 'file')}, +${fixPr.additions} \u2212${fixPr.deletions}`;
    change.url = fixPr.url !== '' ? `${fixPr.url}/files` : '';
    record.prAuthor = sameLogin(fixPr.author, cfg.botLogin) ? cfg.botLogin : fixPr.author;
  }

  // 4 Check: CI and both reviews on the PR head.
  if (fixPr !== null) {
    const c = summariseChecks(fixPr, cfg.checks);
    check.rows = c.rows;
    check.url = fixPr.url !== '' ? `${fixPr.url}/checks` : '';
    if (c.allGreen) {
      check.status = 'done';
      m.checksGreen = notBefore(c.greenAt, m.fixPrOpened);
      check.at = m.checksGreen;
      check.timeText = hhmm(m.checksGreen);
    } else {
      check.status = c.anyRed ? 'failed' : 'active';
    }
  }

  // 5 Ship: waiting from the approval request or green checks, until the owner approves and it merges.
  const ownerApproval = (fixPr?.reviews ?? [])
    .filter((r) => r.state === 'APPROVED' && r.submittedAt !== null && sameLogin(r.author, cfg.ownerLogin))
    .sort((a, b) => ms(a.submittedAt ?? '') - ms(b.submittedAt ?? ''))[0];
  m.waitStarted = earliest([m.approvalRequested, m.checksGreen]);
  m.approved = ownerApproval?.submittedAt ?? null;
  m.merged = fixPr?.mergedAt ?? null;
  ship.url = fixPr?.url || (approvalReply !== undefined ? approvalPrUrl(approvalReply.text) : '');
  if (m.merged !== null && m.approved === null) {
    ship.status = 'failed';
    ship.answer = `Merged without ${cfg.ownerName}'s approval`;
    ship.at = m.merged;
    ship.timeText = hhmm(m.merged);
  } else if (m.approved !== null) {
    ship.answer = `Approved by ${cfg.ownerName} at ${hhmm(m.approved)}`;
    ship.at = m.approved;
    ship.status = m.merged !== null ? 'done' : 'active';
    ship.timeText = m.merged !== null ? `Merged ${hhmm(m.merged)}` : 'Not merged yet';
    record.approver = `${cfg.ownerName} (${cfg.ownerLogin})`;
    record.approvedAt = m.approved;
  } else if (m.waitStarted !== null) {
    ship.status = 'waiting';
    ship.waitingSince = m.waitStarted;
    ship.waitingLabel = `Waiting for ${cfg.ownerName}`;
    ship.at = m.waitStarted;
    ship.timeText = `Asked ${hhmm(m.waitStarted)}`;
  }

  // 6 Confirmed fix: CI on the merge commit, the deploy, then the alert clears.
  const mergeOid = fixPr?.mergeCommit?.oid ?? '';
  const mainCi = fixPr?.mergeCommit?.checks.find((k) => k.name.toLowerCase() === cfg.checks.tests.toLowerCase()) ?? null;
  m.mainCiGreen = mainCi !== null && mainCi.state === 'green' ? mainCi.completedAt : null;
  const forMerge = (list: DemoEvent[]) => {
    const match = list.filter((e) => mergeOid !== '' && str(e.data.sha) === mergeOid);
    return (match.length > 0 ? match : list)[(match.length > 0 ? match : list).length - 1] ?? null;
  };
  const deployStarted = forMerge(ev.deployStarted);
  const deployDone = forMerge(ev.deployDone);
  m.deployStarted = deployStarted?.ts ?? null;
  m.deployDone = deployDone?.ts ?? null;
  m.alertCleared = ev.resolved?.ts ?? null;
  if (m.merged !== null || ev.resolved !== null) {
    confirmed.rows = [
      { label: 'CI on main', state: mainCi === null ? (m.merged !== null ? 'pending' : 'idle') : mainCi.state, note: '' },
      { label: 'Deployed', state: deployDone !== null ? 'green' : deployStarted !== null ? 'pending' : 'idle', note: '' },
      { label: 'Alert cleared', state: ev.resolved !== null ? 'green' : 'idle', note: '' },
    ];
    confirmed.status = ev.resolved !== null ? 'done' : mainCi?.state === 'red' ? 'failed' : 'active';
    confirmed.url = ev.resolved !== null ? str(ev.resolved.data.permalink) : str(deployDone?.data.ciRunUrl) || (fixPr?.mergeCommit?.url ?? '');
    if (ev.resolved !== null) {
      confirmed.at = ev.resolved.ts;
      confirmed.timeText = hhmm(ev.resolved.ts);
    }
  }

  // Return track: the bot's check/ PR, shown once the fix is confirmed.
  if (checkPr !== null) {
    m.checkPrOpened = checkPr.createdAt;
    const approval = checkPr.reviews
      .filter((r) => r.state === 'APPROVED' && r.submittedAt !== null && sameLogin(r.author, cfg.ownerLogin))
      .sort((a, b) => ms(a.submittedAt ?? '') - ms(b.submittedAt ?? ''))[0];
    m.checkPrApproved = approval?.submittedAt ?? null;
  }
  if (ev.resolved !== null) {
    state.loop = 'fixed';
    state.fixedAt = ev.resolved.ts;
    const minutes = Math.max(0, Math.round((ms(ev.resolved.ts) - ms(alertAt)) / 60_000));
    const decisions = new Set(
      (fixPr?.reviews ?? []).filter((r) => r.state === 'APPROVED' && !/\[bot\]$/i.test(r.author) && !sameLogin(r.author, cfg.botLogin)).map((r) => r.author.toLowerCase()),
    ).size;
    state.summary = `Signal to confirmed fix: ${minutes} min. People: ${plural(decisions, 'decision')}`;
    leftBehind.visible = true;
    if (checkPr === null) {
      leftBehind.status = 'active';
      leftBehind.answer = 'Waiting for the new check';
    } else {
      leftBehind.url = checkPr.url;
      leftBehind.answer = checkPr.title;
      if (m.checkPrApproved !== null) {
        leftBehind.status = 'done';
        leftBehind.at = m.checkPrApproved;
        leftBehind.timeText = `Approved ${hhmm(m.checkPrApproved)}`;
      } else {
        leftBehind.status = 'waiting';
        leftBehind.at = checkPr.createdAt;
        leftBehind.timeText = `Opened ${hhmm(checkPr.createdAt)}`;
      }
    }
  }

  return state;
}
