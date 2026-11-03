// Shared shapes for the loop screen: the inputs it reads (monitor events, the
// alert's Slack thread, GitHub) and the state it pushes to the page and records.

export type DemoEvent = { ts: string; type: string; data: Record<string, unknown> };

export type SourceState = 'ok' | 'waiting' | 'error' | 'off';
export type SourceStatus = { state: SourceState; note: string };
export type Sources = { slack: SourceStatus; github: SourceStatus; monitor: SourceStatus };

export type SlackReply = {
  ts: string;
  user: string | null;
  botId: string | null;
  subtype: string | null;
  text: string;
};
export type SlackReaction = { name: string; user: string; firstSeen: string };
export type SlackThread = {
  channel: string;
  threadTs: string;
  replies: SlackReply[];
  reactions: SlackReaction[];
};
export type SlackIdentity = { userId: string; botId: string | null };

export type CheckState = 'pending' | 'green' | 'red';
export type GhCheck = {
  name: string;
  workflow: string | null;
  state: CheckState;
  completedAt: string | null;
  url: string;
};
export type GhCommit = {
  oid: string;
  headline: string;
  committedAt: string;
  url: string;
  checks: GhCheck[];
};
export type GhReview = { author: string; state: string; submittedAt: string | null; url: string };
export type GhPull = {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  headRef: string;
  baseRef: string;
  headOid: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: GhCommit[];
  reviews: GhReview[];
  mergeCommit: { oid: string; url: string; checks: GhCheck[] } | null;
};
export type GhBranch = { name: string; commits: GhCommit[] };
export type GithubSnapshot = { pulls: GhPull[]; branches: GhBranch[]; rateRemaining: number | null };

export type Inputs = {
  events: DemoEvent[];
  slackIdentity: SlackIdentity | null;
  thread: SlackThread | null;
  github: GithubSnapshot | null;
  sources: Sources;
};

export type BannerKind = 'live' | 'rehearsal' | 'replay' | 'simulate';
export type Banner = { kind: BannerKind; text: string };

export type RowState = 'idle' | 'pending' | 'green' | 'red';
export type Row = { label: string; state: RowState; note: string };
export type StationKey = 'signal' | 'triage' | 'change' | 'check' | 'ship' | 'confirmed';
export type StationStatus = 'idle' | 'active' | 'waiting' | 'done' | 'failed';
export type Station = {
  n: number;
  key: StationKey;
  name: string;
  question: string;
  status: StationStatus;
  answer: string;
  meta: string;
  rows: Row[];
  at: string | null;
  timeText: string;
  waitingSince: string | null;
  waitingLabel: string;
  url: string;
};
export type LeftBehind = {
  question: string;
  visible: boolean;
  status: StationStatus;
  answer: string;
  at: string | null;
  timeText: string;
  url: string;
};
export type InvoiceCard = {
  bookingId: string;
  customer: string;
  line: string;
  expected: string;
  actual: string;
  fixed: boolean;
  url: string;
};
export type RecordCard = {
  runAs: string;
  prAuthor: string;
  approver: string;
  approvedAt: string | null;
  runUrl: string;
};
export type Milestones = {
  break: string | null;
  alert: string | null;
  runStarted: string | null;
  triage: string | null;
  triageNote: string | null;
  testCommit: string | null;
  fixPrOpened: string | null;
  checksGreen: string | null;
  approvalRequested: string | null;
  waitStarted: string | null;
  approved: string | null;
  merged: string | null;
  mainCiGreen: string | null;
  deployStarted: string | null;
  deployDone: string | null;
  alertCleared: string | null;
  checkPrOpened: string | null;
  checkPrApproved: string | null;
};
export type LoopPhase = 'idle' | 'broken' | 'fixed';
export type LoopState = {
  version: 1;
  runKey: string | null;
  banner: Banner;
  loop: LoopPhase;
  clockFrom: string | null;
  fixedAt: string | null;
  summary: string;
  stations: Station[];
  leftBehind: LeftBehind;
  invoice: InvoiceCard | null;
  record: RecordCard;
  sources: Sources;
  milestones: Milestones;
};

/** What the server pushes to the page. virtualMs is "now" in the shown run's time. */
export type Push = { state: LoopState; clock: { virtualMs: number; speed: number } };
