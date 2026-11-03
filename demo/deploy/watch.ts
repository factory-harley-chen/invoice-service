import { parseArgs } from 'node:util';
import { appendEvent } from '../lib/events.ts';
import { describeGhError, gh, ghJson, repoPattern } from '../lib/gh.ts';
import { sleep } from '../lib/proc.ts';
import { baselineCurrencies, deployStaging, readStaging } from '../lib/staging.ts';
import { loadValues } from '../lib/values.ts';
import { ciJobName, decideDeploy, type CheckRun } from './ci.ts';

const help = `Usage: node demo/deploy/watch.ts [--interval SECONDS] [--once] [--dry-run]

Watches main on GITHUB_REPO with read-only gh calls. For each new commit it
waits until the CI job "${ciJobName}" has succeeded on that commit, then puts
that commit on staging, restarts it with staging's current BILLING_CURRENCIES,
and appends deploy_started and deploy_done. A commit whose CI failed, was
cancelled or is still running is never deployed.

  --interval   seconds between checks (default 5)
  --once       check once and exit
  --dry-run    say what it would deploy; change nothing`;

const { values: args } = parseArgs({
  options: {
    interval: { type: 'string', default: '5' },
    once: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(help);
  process.exit(0);
}

const v = loadValues().values;
const repo = v.GITHUB_REPO;
const intervalMs = Number(args.interval) * 1000;
if (!repoPattern.test(repo)) {
  console.error(`GITHUB_REPO "${repo}" is not owner/name`);
  process.exit(2);
}

let lastMessage = '';
function log(message: string): void {
  if (message === lastMessage) return;
  lastMessage = message;
  console.log(`${new Date().toISOString()} ${message}`);
}

async function mainSha(): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const result = await gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha'], 15_000);
  const sha = result.stdout.trim();
  if (result.code === 0 && /^[0-9a-f]{40}$/.test(sha)) return { ok: true, sha };
  const reason = describeGhError(`${result.stderr}\n${result.stdout}`, result);
  if (/not found/i.test(reason)) {
    return { ok: false, error: `github.com/${repo} has no main branch yet (no remote yet); nothing to deploy. See SETUP.md P3.` };
  }
  return { ok: false, error: `cannot read main on github.com/${repo}: ${reason}` };
}

async function tick(): Promise<void> {
  const main = await mainSha();
  if (!main.ok) {
    log(main.error);
    return;
  }
  const staging = readStaging();
  const runs = await ghJson<{ check_runs: CheckRun[] }>(
    ['api', `repos/${repo}/commits/${main.sha}/check-runs?check_name=${encodeURIComponent(ciJobName)}&per_page=50`],
    15_000,
  );
  if (!runs.ok) {
    log(`cannot read CI for ${main.sha.slice(0, 7)}: ${runs.error}`);
    return;
  }
  const decision = decideDeploy(main.sha, staging?.sha, runs.value.check_runs);
  if (decision.kind === 'up-to-date') {
    log(`staging is at main (${main.sha.slice(0, 7)})`);
    return;
  }
  if (decision.kind !== 'deploy') {
    log(decision.reason);
    return;
  }
  const currencies = staging?.currencies ?? [...baselineCurrencies];
  if (args['dry-run']) {
    log(`DRY RUN: would deploy ${main.sha.slice(0, 7)} to staging on port ${v.STAGING_PORT} (BILLING_CURRENCIES=${currencies.join(',')}); CI ${decision.ciRunUrl}`);
    return;
  }
  log(`deploying ${main.sha.slice(0, 7)} (CI passed: ${decision.ciRunUrl})`);
  appendEvent('deploy_started', { sha: main.sha });
  try {
    await deployStaging({ kind: 'github', sha: main.sha, repo }, currencies, v.STAGING_PORT);
  } catch (error) {
    log(`deploy of ${main.sha.slice(0, 7)} failed: ${(error as Error).message}; trying again on the next check`);
    return;
  }
  appendEvent('deploy_done', { sha: main.sha, ciRunUrl: decision.ciRunUrl });
  log(`staging now runs ${main.sha.slice(0, 7)}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${new Date().toISOString()} deploy watcher stopping (${signal})`);
    process.exit(0);
  });
}

console.log(`${new Date().toISOString()} deploy watcher started: github.com/${repo} main, every ${intervalMs / 1000} s${args['dry-run'] ? ', DRY RUN' : ''}`);
for (;;) {
  const started = Date.now();
  await tick();
  if (args.once) break;
  await sleep(Math.max(0, intervalMs - (Date.now() - started)));
}
