// Reads the demo repo through `gh api graphql`: one read-only query per poll
// (pull requests with their commits, checks and reviews, and the fix/
// branches), which keeps a 3.5 s poll far inside GitHub's hourly budget.

import { execFile } from 'node:child_process';
import type { CheckState, GhBranch, GhCheck, GhCommit, GhPull, GhReview, GithubSnapshot, SourceStatus } from './types.ts';
import { arr, num, obj, str, strOrNull } from './json.ts';

const CONTEXTS = `statusCheckRollup { contexts(first: 25) { nodes {
  __typename
  ... on CheckRun { name status conclusion completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl createdAt }
} } }`;

export const QUERY = `query($owner: String!, $name: String!) {
  rateLimit { remaining }
  repository(owner: $owner, name: $name) {
    pullRequests(first: 8, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
      number title url state createdAt mergedAt headRefName baseRefName headRefOid
      additions deletions changedFiles
      author { login }
      commits(last: 6) { nodes { commit { oid messageHeadline committedDate url ${CONTEXTS} } } }
      reviews(first: 20) { nodes { author { login } state submittedAt url } }
      mergeCommit { oid url ${CONTEXTS} }
    } }
    refs(refPrefix: "refs/heads/fix/", first: 5) { nodes {
      name
      target { ... on Commit { history(first: 6) { nodes { oid messageHeadline committedDate url } } } }
    } }
  }
}`;

function checkRunState(status: string, conclusion: string): CheckState {
  if (status !== 'COMPLETED') return 'pending';
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ? 'green' : 'red';
}

function statusContextState(state: string): CheckState {
  if (state === 'SUCCESS') return 'green';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'red';
}

function checks(rollup: unknown): GhCheck[] {
  return arr(obj(obj(obj(rollup).contexts)).nodes).map((n): GhCheck => {
    const c = obj(n);
    if (str(c.__typename) === 'StatusContext') {
      const state = statusContextState(str(c.state));
      return { name: str(c.context), workflow: null, state, completedAt: state === 'pending' ? null : strOrNull(c.createdAt), url: str(c.targetUrl) };
    }
    return {
      name: str(c.name),
      workflow: strOrNull(obj(obj(obj(obj(c.checkSuite).workflowRun).workflow)).name),
      state: checkRunState(str(c.status), str(c.conclusion)),
      completedAt: strOrNull(c.completedAt),
      url: str(c.detailsUrl),
    };
  });
}

function commit(c: unknown): GhCommit {
  const o = obj(c);
  return { oid: str(o.oid), headline: str(o.messageHeadline), committedAt: str(o.committedDate), url: str(o.url), checks: checks(o.statusCheckRollup) };
}

export function normalizeGraphql(payload: unknown): GithubSnapshot {
  const data = obj(obj(payload).data);
  const repo = obj(data.repository);
  const pulls = arr(obj(repo.pullRequests).nodes).map((n): GhPull => {
    const p = obj(n);
    const merge = p.mergeCommit === null || p.mergeCommit === undefined ? null : obj(p.mergeCommit);
    return {
      number: num(p.number),
      title: str(p.title),
      url: str(p.url),
      state: str(p.state),
      createdAt: str(p.createdAt),
      mergedAt: strOrNull(p.mergedAt),
      headRef: str(p.headRefName),
      baseRef: str(p.baseRefName),
      headOid: str(p.headRefOid),
      author: str(obj(p.author).login),
      additions: num(p.additions),
      deletions: num(p.deletions),
      changedFiles: num(p.changedFiles),
      commits: arr(obj(p.commits).nodes).map((x) => commit(obj(x).commit)),
      reviews: arr(obj(p.reviews).nodes).map((x): GhReview => {
        const r = obj(x);
        return { author: str(obj(r.author).login), state: str(r.state), submittedAt: strOrNull(r.submittedAt), url: str(r.url) };
      }),
      mergeCommit: merge === null ? null : { oid: str(merge.oid), url: str(merge.url), checks: checks(merge.statusCheckRollup) },
    };
  });
  const branches = arr(obj(repo.refs).nodes).map((n): GhBranch => {
    const b = obj(n);
    return { name: `fix/${str(b.name)}`, commits: arr(obj(obj(obj(b.target).history)).nodes).map(commit) };
  });
  const rate = obj(data.rateLimit).remaining;
  return { pulls, branches, rateRemaining: typeof rate === 'number' ? rate : null };
}

export function ghErrorStatus(output: string): SourceStatus {
  if (/Could not resolve to a Repository/i.test(output)) return { state: 'error', note: 'repo not found' };
  if (/gh auth login|not logged|authentication|HTTP 401|Bad credentials/i.test(output)) return { state: 'error', note: 'gh not signed in' };
  if (/rate limit/i.test(output)) return { state: 'waiting', note: 'rate limited' };
  if (/ENOENT/.test(output)) return { state: 'error', note: 'gh not installed' };
  if (/could not connect|dial tcp|timeout|timed out|network|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(output)) return { state: 'error', note: 'offline' };
  const first = output.trim().split('\n')[0] ?? '';
  return { state: 'error', note: first.slice(0, 40) || 'gh failed' };
}

export type RunGh = (args: string[]) => Promise<string>;

export const runGh: RunGh = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile('gh', args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) reject(new Error(`${String(stderr)}\n${err.message}`));
      else resolvePromise(String(stdout));
    });
  });

export type GithubPoller = { setActive: (active: boolean) => void; pollOnce: () => Promise<void>; stop: () => void };

export function createGithubPoller(opts: {
  repo: string;
  activeMs: number;
  idleMs: number;
  onUpdate: (snapshot: GithubSnapshot | null, status: SourceStatus) => void;
  run?: RunGh;
  autoStart?: boolean;
}): GithubPoller {
  const run = opts.run ?? runGh;
  const [owner, name] = opts.repo.split('/');
  let active = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let low = false;

  const pollOnce = async (): Promise<void> => {
    if (owner === undefined || name === undefined || owner === '' || name === '') {
      opts.onUpdate(null, { state: 'error', note: 'GITHUB_REPO is not owner/name' });
      return;
    }
    try {
      const out = await run(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
      const payload: unknown = JSON.parse(out);
      const errors = arr(obj(payload).errors);
      if (errors.length > 0) {
        opts.onUpdate(null, ghErrorStatus(errors.map((e) => str(obj(e).message)).join('\n')));
        return;
      }
      const snap = normalizeGraphql(payload);
      low = snap.rateRemaining !== null && snap.rateRemaining < 300;
      opts.onUpdate(snap, low ? { state: 'waiting', note: 'rate limit low, slowing' } : { state: 'ok', note: '' });
    } catch (e) {
      opts.onUpdate(null, ghErrorStatus(e instanceof Error ? e.message : String(e)));
    }
  };

  const loop = async (): Promise<void> => {
    if (stopped) return;
    await pollOnce();
    const wait = active ? (low ? opts.activeMs * 4 : opts.activeMs) : opts.idleMs;
    if (!stopped) timer = setTimeout(() => void loop(), wait);
  };
  if (opts.autoStart !== false) void loop();

  return {
    pollOnce,
    setActive: (next) => {
      const wake = next && !active;
      active = next;
      if (wake && timer !== null && !stopped) {
        clearTimeout(timer);
        timer = setTimeout(() => void loop(), 0);
      }
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
