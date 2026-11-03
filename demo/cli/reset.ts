import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from '../lib/events.ts';
import { gh, ghJson, repoFromRemoteUrl, repoPattern, sameRepo } from '../lib/gh.ts';
import { deployKeySshCommand, githubHttpsUrl, remoteBranchSha } from '../lib/git-remote.ts';
import { files, repoRoot } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import { processNames, readSession, runningProcesses, startProcess, stopProcess, writeSession, type ProcessName } from '../lib/session.ts';
import { baselineCurrencies, baselineSource, deployStaging, describeSource, stagingRunning, stopStaging } from '../lib/staging.ts';
import { channelFor, stagingUrl, type Mode, type Values } from '../lib/values.ts';
import { doctor } from './doctor.ts';

export type ResetOptions = { yes: boolean; dryRun: boolean; anyAuthor: boolean; skipDoctor: boolean };

type Pull = { number: number; html_url: string; user: { login: string }; head: { ref: string; repo: { full_name: string } | null } };

export function runStamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/** Stacked PRs first (check/ before fix/), so no PR is left pointing at a closed base. */
export function closeOrder<T extends { head: { ref: string } }>(pulls: T[]): T[] {
  return [...pulls].sort((a, b) => Number(b.head.ref.startsWith('check/')) - Number(a.head.ref.startsWith('check/')));
}

async function githubSteps(v: Values, options: ResetOptions, say: (line: string) => void): Promise<boolean> {
  const R = v.GITHUB_REPO;
  if (!repoPattern.test(R)) {
    say(`GitHub: skipped; GITHUB_REPO "${R}" is not owner/name`);
    return false;
  }
  const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
  const originRepo = origin.code === 0 ? repoFromRemoteUrl(origin.stdout) : undefined;
  if (!originRepo || !sameRepo(originRepo, R)) {
    say(`GitHub: skipped; origin is ${origin.code === 0 ? origin.stdout.trim() : 'not set'}, not github.com/${R} (no remote yet?)`);
    return false;
  }
  const act = options.yes && !options.dryRun;
  const would = act ? '' : 'would ';
  const pulls = await ghJson<Pull[]>(['api', `repos/${R}/pulls?state=open&per_page=100`]);
  if (!pulls.ok) {
    say(`GitHub: cannot list pull requests: ${pulls.error}`);
    return false;
  }
  const demoPulls = pulls.value.filter((pr) => /^(fix|check)\//.test(pr.head.ref) && pr.head.repo?.full_name && sameRepo(pr.head.repo.full_name, R));
  const toClose = demoPulls.filter((pr) => options.anyAuthor || pr.user.login === v.BOT_LOGIN);
  const leftOpen = demoPulls.filter((p) => !toClose.includes(p));
  for (const pr of leftOpen) {
    say(`GitHub: leaving #${pr.number} (${pr.head.ref}) open: opened by ${pr.user.login}, not ${v.BOT_LOGIN} (use --any-author)`);
  }
  // Deleting a head branch closes its pull request, so the branches of pull requests left open stay too.
  const keptBranches = new Set(leftOpen.map((pr) => pr.head.ref));
  let ok = true;
  for (const pr of closeOrder(toClose)) {
    say(`GitHub: ${would}close #${pr.number} ${pr.head.ref} (${pr.html_url})`);
    if (act) {
      const closed = await gh(['pr', 'close', String(pr.number), '-R', R]);
      if (closed.code !== 0) {
        ok = false;
        say(`  failed: ${closed.stderr.trim()}`);
      }
    }
  }
  const refs: string[] = [];
  for (const prefix of ['fix/', 'check/']) {
    const matching = await ghJson<Array<{ ref: string }>>(['api', `repos/${R}/git/matching-refs/heads/${prefix}`]);
    if (matching.ok) refs.push(...matching.value.map((r) => r.ref.replace(/^refs\/heads\//, '')));
  }
  for (const branch of refs) {
    if (keptBranches.has(branch)) {
      say(`GitHub: leaving branch ${branch}: its pull request stays open`);
      continue;
    }
    say(`GitHub: ${would}delete branch ${branch}`);
    if (act) {
      const deleted = await gh(['api', '-X', 'DELETE', `repos/${R}/git/refs/heads/${branch}`]);
      if (deleted.code !== 0 && !/Reference does not exist|HTTP 422/.test(deleted.stderr)) {
        ok = false;
        say(`  failed: ${deleted.stderr.trim()}`);
      }
    }
  }
  const base = await baselineSource();
  if (base.kind !== 'tag') {
    say('GitHub: no local demo-baseline tag; main is left as it is (SETUP.md P3)');
    return false;
  }
  const main = await remoteBranchSha(githubHttpsUrl(R), 'main');
  if (!main.ok) {
    say(`GitHub: cannot read main: ${main.error}`);
    return false;
  }
  if (main.sha === base.sha) {
    say(`GitHub: main is already at demo-baseline (${base.sha.slice(0, 7)})`);
    return ok;
  }
  const key = v.RESET_DEPLOY_KEY;
  say(`GitHub: ${would}force-push demo-baseline (${base.sha.slice(0, 7)}) to main (now ${main.sha.slice(0, 7)}) on github.com/${R}, with the deploy key ${key}`);
  if (!act) return ok;
  if (!existsSync(key)) {
    say(`  failed: no deploy key at ${key} (SETUP.md P3)`);
    return false;
  }
  const pushed = await run(
    'git',
    ['push', `--force-with-lease=refs/heads/main:${main.sha}`, `git@github.com:${R}.git`, `${base.sha}:refs/heads/main`],
    {
      cwd: repoRoot,
      timeoutMs: 30_000,
      env: { ...process.env, GIT_SSH_COMMAND: deployKeySshCommand(key) },
    },
  );
  if (pushed.code !== 0) {
    say(`  failed: ${pushed.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    return false;
  }
  return ok;
}

function archiveState(dryRun: boolean, say: (line: string) => void): string | undefined {
  const items = [files.events(), files.timeline(), files.monitor(), files.logs()].filter((path) => existsSync(path));
  if (items.length === 0) {
    say('state: nothing to archive');
    return undefined;
  }
  const dir = join(files.runs(), runStamp());
  say(`state: ${dryRun ? 'would move' : 'moving'} ${items.map((p) => p.split('/').pop()).join(', ')} to ${dir}`);
  if (dryRun) return dir;
  mkdirSync(dir, { recursive: true });
  for (const item of items) renameSync(item, join(dir, item.split('/').pop() ?? 'item'));
  return dir;
}

export async function reset(v: Values, fallbackMode: Mode, options: ResetOptions): Promise<boolean> {
  const started = Date.now();
  const say = (line: string) => console.log(line);
  const session = readSession();
  const running = await runningProcesses(session);
  const stagingWasUp = Boolean(await stagingRunning());
  const mode = session?.mode ?? fallbackMode;
  const noPost = session?.noPost ?? false;

  say(`processes: ${options.dryRun ? 'would stop' : 'stopping'} ${running.length ? running.join(', ') : 'none running'}${stagingWasUp ? ' and staging' : ''}`);
  if (!options.dryRun && session) {
    for (const name of running) say(`  ${await stopProcess(session, name)}`);
    writeSession(session);
  }
  if (!options.dryRun) await stopStaging();

  archiveState(options.dryRun, say);

  const githubOk = await githubSteps(v, options, say);
  if (!options.yes && !options.dryRun) say('GitHub: nothing changed there; add --yes to close the PRs, delete the branches and reset main');

  const base = await baselineSource();
  if (stagingWasUp) {
    say(`staging: ${options.dryRun ? 'would put' : 'putting'} ${describeSource(base)} on port ${v.STAGING_PORT} with BILLING_CURRENCIES=${baselineCurrencies.join(',')}`);
    if (!options.dryRun) await deployStaging(base, [...baselineCurrencies], v.STAGING_PORT);
  } else {
    say(`staging: not running; ${options.dryRun ? 'would clear' : 'clearing'} it so the next ./demo.sh up starts at ${describeSource(base)}`);
    if (!options.dryRun) {
      rmSync(files.staging(), { force: true });
      rmSync(files.stagingDir(), { recursive: true, force: true });
    }
  }

  say(`monitor: ${options.dryRun ? 'would clear' : 'cleared'} its state (no open alert)`);

  if (options.dryRun) {
    say(`events: would append reset${running.length ? ' and up' : ''}; would restart ${running.length ? running.join(', ') : 'nothing'}`);
    say('doctor: would run');
    return true;
  }

  appendEvent('reset', {});
  if (session && running.length) {
    const restarted: ProcessName[] = [];
    for (const name of processNames.filter((n) => running.includes(n))) {
      const outcome = startProcess(name, mode, noPost, v);
      if (outcome.record) {
        session.processes[name] = outcome.record;
        restarted.push(name);
      } else say(`  ${name}: ${outcome.skipped}`);
    }
    writeSession(session);
    appendEvent('up', { mode, channel: channelFor(v, mode), stagingUrl: stagingUrl(v) });
    say(`processes: restarted ${restarted.join(', ')} (${mode}${noPost ? ', not posting' : ''})`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  say(`reset took ${seconds} s${Number(seconds) > 60 ? ' (over the 60 s target)' : ''}`);
  if (options.skipDoctor) return githubOk;
  say('');
  const healthy = await doctor({});
  return healthy && githubOk;
}

export function latestArchived(name: string): string | undefined {
  if (!existsSync(files.runs())) return undefined;
  const runs = readdirSync(files.runs()).sort().reverse();
  for (const runDir of runs) {
    const file = join(files.runs(), runDir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}
