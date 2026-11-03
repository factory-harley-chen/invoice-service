import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { berlin, berlinTime } from '../../monitor/check.ts';
import { appendEvent } from '../lib/events.ts';
import { files, repoRoot } from '../lib/paths.ts';
import { isAlive, listenerPids, sleep } from '../lib/proc.ts';
import {
  clearSession,
  processNames,
  readSession,
  runningProcesses,
  scripts,
  startProcess,
  stopProcess,
  writeSession,
  type Session,
} from '../lib/session.ts';
import {
  baselineCurrencies,
  baselineSource,
  breakCurrency,
  deployStaging,
  describeSource,
  readStaging,
  restartStaging,
  stagingRunning,
  stagingServerPath,
  stopStaging,
} from '../lib/staging.ts';
import { channelFor, loadValues, loopUrl, parseMode, stagingUrl, workspaceName, type Mode, type Values } from '../lib/values.ts';
import { doctor, phases, type Phase } from './doctor.ts';
import { latestArchived, reset } from './reset.ts';

const usage = `Usage: ./demo.sh <command> [options]

Runs the invoice demo on this laptop: staging, the monitor, the deploy watcher
and the loop screen. Values come from demo/.env (see values.example.env).
Every command prints one line first saying what is real.

Commands:
  doctor   check the setup, phase by phase (PASS or FAIL, each FAIL with its fix)
  up       start staging, the monitor, the deploy watcher and the loop screen
  down     stop them
  break    turn JPY billing on in staging (the fault appears)
  reset    back to baseline: GitHub (with --yes), staging, monitor state, then doctor
  replay   play a recorded timeline on the loop screen
  times    print the beat times of a recorded timeline

Every command takes --help and --dry-run (prints what it would do, changes nothing).
See SETUP.md for the full setup.`;

const help: Record<string, string> = {
  doctor: `Usage: ./demo.sh doctor [--phase P0..P8] [--dry-run]

Runs the setup checks and prints PASS, FAIL (with a one-line fix) or MANUAL
(confirm by hand in a web page) for each. Exits 1 when anything fails.
Checks that need the network fail with a clear message when it is off; the
others still run. Read-only: it posts nothing and changes nothing.

  --phase P3   only that phase's checks (the phases are in SETUP.md)
  --dry-run    list the checks without running them`,
  up: `Usage: ./demo.sh up [--mode live|rehearsal] [--no-post] [--dry-run]

Starts staging (at the demo-baseline tag, or the working tree before there is
one), the monitor, the deploy watcher and the loop server (demo/loop/server.ts,
skipped with a warning if it is not there). Writes pids to demo/state/pids.json,
appends "up" to demo/state/events.jsonl and prints the URLs. Already-running
parts are kept.

  --mode       live or rehearsal (default: DEMO_MODE); picks the Slack channel
  --no-post    the monitor prints its alerts instead of posting to Slack
  --dry-run    say what would start; start nothing`,
  down: `Usage: ./demo.sh down [--dry-run]

Stops everything ./demo.sh up started (by pid, after checking each pid is still
ours). Staging's files and demo/state/ stay.

  --dry-run    say what would stop; stop nothing`,
  break: `Usage: ./demo.sh break [--dry-run]

Adds ${breakCurrency} to staging's BILLING_CURRENCIES and restarts staging, with no code
change, then appends "break". The monitor sees the wrong invoice on its next
poll (every 2 s) and posts the alert.

  --dry-run    say what would change; change nothing`,
  reset: `Usage: ./demo.sh reset [--yes] [--any-author] [--no-doctor] [--dry-run]

Back to baseline, in under 60 s:
  1. stops the monitor, deploy watcher and loop server (restarted at the end)
  2. moves events, timeline, monitor state and logs to demo/state/runs/<time>/
  3. on GitHub, only with --yes and only when origin is GITHUB_REPO: closes open
     pull requests from fix/* and check/* opened by BOT_LOGIN, deletes the fix/*
     and check/* branches (except those of pull requests it leaves open), and
     force-pushes demo-baseline to main with the reset deploy key
  4. puts staging back at baseline with BILLING_CURRENCIES=${baselineCurrencies.join(',')}
  5. appends "reset", then runs doctor
It never touches any other repository.

  --yes          do the GitHub steps (without it they are printed only)
  --any-author   also close fix/ and check/ pull requests opened by others
  --no-doctor    skip the doctor run at the end
  --dry-run      print every step; change nothing`,
  replay: `Usage: ./demo.sh replay [timeline.jsonl] [--port N] [--dry-run]

Plays a recorded timeline on the loop screen: node demo/loop/server.ts --replay.
Works with the network off. The default file is demo/state/timeline.jsonl if it
has content, otherwise the latest demo/state/runs/*/timeline.jsonl.

  --port       port for the replay (default LOOP_PORT; stop ./demo.sh up first, or pick another)
  --dry-run    print the command; run nothing`,
  times: `Usage: ./demo.sh times [timeline.jsonl] [--dry-run]

Prints the beat times of a timeline: node demo/loop/times.ts. The default file
is demo/state/timeline.jsonl if it has content, otherwise the latest archived one.

  --dry-run    print the command; run nothing`,
};

function modeWord(mode: Mode): string {
  return mode === 'live' ? 'LIVE' : 'REHEARSAL';
}

function bannerFor(command: string, v: Values, mode: Mode, flags: { dryRun: boolean; noPost?: boolean; yes?: boolean }): string {
  if (flags.dryRun) return 'DRY RUN: nothing is posted or changed';
  const where = `${channelFor(v, mode) || '(channel id not set)'} in ${workspaceName(v)}`;
  const m = modeWord(mode);
  switch (command) {
    case 'up':
      return flags.noPost ? `${m}: LOCAL ONLY, the monitor prints alerts instead of posting to ${where}` : `${m}: posts to ${where}`;
    case 'break':
      return flags.noPost ? `${m}: LOCAL ONLY, changes staging; the monitor prints instead of posting` : `${m}: changes staging; the monitor posts to ${where}`;
    case 'down':
      return `${m}: stops the local processes; nothing is posted`;
    case 'reset':
      return flags.yes
        ? `${m}: resets github.com/${v.GITHUB_REPO} (closes demo PRs, force-pushes main) and local staging; nothing is posted`
        : `${m}: resets local staging and state only (GitHub needs --yes); nothing is posted`;
    case 'doctor':
      return `${m}: checks only; nothing is posted or changed (alerts would go to ${where})`;
    default:
      return 'REPLAY: reads a recorded timeline; nothing is posted or changed';
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function defaultTimeline(): string | undefined {
  const current = files.timeline();
  if (existsSync(current) && statSync(current).size > 0) return current;
  return latestArchived('timeline.jsonl');
}

function runForeground(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, stdio: 'inherit', env: process.env });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function up(v: Values, mode: Mode, noPost: boolean, dryRun: boolean): Promise<void> {
  const channel = channelFor(v, mode);
  if (!noPost && !dryRun && (!channel || !v.SLACK_BOT_TOKEN)) {
    fail(`SLACK_BOT_TOKEN and SLACK_CHANNEL_${mode.toUpperCase()} must be set in demo/.env (or use --no-post)`);
  }
  const existing = readSession();
  const running = await runningProcesses(existing);
  const staging = await stagingRunning();
  if (existing && running.length > 0 && (existing.mode !== mode || existing.noPost !== noPost)) {
    fail(`already up in ${existing.mode} mode${existing.noPost ? ' (not posting)' : ''}; run ./demo.sh down first`);
  }
  const previous = readStaging();
  const base = await baselineSource();
  const stagingPlan = staging
    ? `keep staging (pid ${staging.pid}, ${staging.sha.slice(0, 12)}, BILLING_CURRENCIES=${staging.currencies.join(',')})`
    : previous && existsSync(stagingServerPath())
      ? `restart staging as it was (${previous.sha.slice(0, 12)}, BILLING_CURRENCIES=${previous.currencies.join(',')}) on port ${v.STAGING_PORT}`
      : `start staging from ${describeSource(base)} on port ${v.STAGING_PORT} with BILLING_CURRENCIES=${baselineCurrencies.join(',')}`;

  if (dryRun) {
    console.log(`would ${stagingPlan}`);
    for (const name of processNames) {
      if (running.includes(name)) console.log(`would keep ${name}`);
      else if (!existsSync(scripts[name])) console.log(`would skip ${name}: ${scripts[name]} does not exist yet`);
      else console.log(`would start ${name}: node ${scripts[name].replace(`${repoRoot}/`, '')} ${name === 'monitor' ? `--mode ${mode}${noPost ? ' --dry-run' : ''}` : name === 'loop' ? `--port ${v.LOOP_PORT}` : ''}`.trimEnd());
    }
    console.log(`would append up {mode: ${mode}, channel: ${channel || 'unset'}}`);
    return;
  }

  if (!staging) {
    const busy = await listenerPids(v.STAGING_PORT);
    if (busy.length) fail(`port ${v.STAGING_PORT} (STAGING_PORT) is used by pid ${busy.join(', ')}; stop it or change STAGING_PORT`);
  }
  if (!running.includes('loop') && existsSync(scripts.loop)) {
    const busy = await listenerPids(v.LOOP_PORT);
    if (busy.length) fail(`port ${v.LOOP_PORT} (LOOP_PORT) is used by pid ${busy.join(', ')}; stop it or change LOOP_PORT`);
  }

  let session: Session =
    existing && running.length > 0 ? existing : { mode, channel, noPost, startedAt: new Date().toISOString(), processes: {} };
  writeSession(session);

  if (!staging) {
    if (previous && existsSync(stagingServerPath())) await restartStaging(previous.currencies, v.STAGING_PORT);
    else await deployStaging(base, [...baselineCurrencies], v.STAGING_PORT);
  }
  console.log(stagingPlan.replace(/^keep/, 'kept').replace(/^restart/, 'restarted').replace(/^start/, 'started'));
  session = readSession() ?? session;

  for (const name of processNames) {
    if (running.includes(name)) {
      console.log(`kept ${name} (pid ${session.processes[name]?.pid})`);
      continue;
    }
    const outcome = startProcess(name, mode, noPost, v);
    if (outcome.record) {
      session.processes[name] = outcome.record;
      console.log(`started ${name} (pid ${outcome.pid})`);
    } else {
      console.log(`warning: skipped ${name}: ${outcome.skipped}`);
    }
  }
  writeSession(session);

  await sleep(1200);
  for (const name of processNames) {
    const record = session.processes[name];
    if (record && !isAlive(record.pid)) console.log(`warning: ${name} stopped right after starting; see ${record.log}`);
  }

  appendEvent('up', { mode, channel, stagingUrl: stagingUrl(v) });
  console.log('');
  console.log(`staging      ${stagingUrl(v)}/invoices/B-1042`);
  console.log(`loop screen  ${existsSync(scripts.loop) ? loopUrl(v) : '(not built yet)'}`);
  console.log(`slack        ${channel ? `${v.SLACK_WORKSPACE_URL.replace(/\/$/, '')}/archives/${channel}` : '(channel id not set)'}`);
  console.log(`github       https://github.com/${v.GITHUB_REPO}/pulls`);
  console.log(`logs         ${files.logs()}`);
}

async function down(dryRun: boolean): Promise<void> {
  const session = readSession();
  const running = await runningProcesses(session);
  const staging = await stagingRunning();
  if (dryRun) {
    console.log(`would stop ${[...running, ...(staging ? ['staging'] : [])].join(', ') || 'nothing (nothing is running)'}`);
    return;
  }
  if (session) {
    for (const name of processNames) {
      if (session.processes[name]) console.log(await stopProcess(session, name));
    }
  }
  await stopStaging();
  if (staging) console.log(`staging: stopped pid ${staging.pid}`);
  clearSession();
  console.log('down');
}

async function breakStaging(v: Values, mode: Mode, dryRun: boolean): Promise<void> {
  const staging = await stagingRunning();
  if (!staging) fail('staging is not running; run ./demo.sh up first');
  if (staging.currencies.includes(breakCurrency)) {
    console.log(`staging already bills ${breakCurrency} (BILLING_CURRENCIES=${staging.currencies.join(',')}); nothing to do`);
    return;
  }
  const currencies = [...staging.currencies, breakCurrency];
  if (dryRun) {
    console.log(`would restart staging on port ${staging.port} with BILLING_CURRENCIES=${currencies.join(',')} and append break`);
    return;
  }
  await restartStaging(currencies, staging.port);
  appendEvent('break', { mode, currencies });
  console.log(`broken at ${berlinTime(new Date())} ${berlin}: staging bills with BILLING_CURRENCIES=${currencies.join(',')}. The monitor checks every 2 s.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage);
    return;
  }
  if (!(command in help)) {
    console.error(`unknown command "${command}"\n`);
    console.log(usage);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: command === 'replay' || command === 'times',
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        'dry-run': { type: 'boolean', default: false },
        mode: { type: 'string' },
        'no-post': { type: 'boolean', default: false },
        phase: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'any-author': { type: 'boolean', default: false },
        'no-doctor': { type: 'boolean', default: false },
        port: { type: 'string' },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n`);
    console.log(help[command]);
    process.exit(2);
  }
  const { values: opts, positionals } = parsed;
  if (opts.help) {
    console.log(help[command]);
    return;
  }
  const v = loadValues().values;
  const session = readSession();
  let mode: Mode;
  try {
    mode = parseMode(opts.mode, session?.mode ?? v.DEMO_MODE);
  } catch (error) {
    fail((error as Error).message);
  }
  const dryRun = opts['dry-run'];
  const noPost = command === 'up' ? opts['no-post'] : (session?.noPost ?? false);
  console.log(bannerFor(command, v, mode, { dryRun, noPost, yes: opts.yes }));

  switch (command) {
    case 'doctor': {
      const phase = opts.phase?.toUpperCase();
      if (phase && !phases.includes(phase as Phase)) fail(`--phase must be one of ${phases.join(', ')}`);
      const ok = await doctor({ phase: phase as Phase | undefined, dryRun });
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'up':
      await up(v, mode, noPost, dryRun);
      break;
    case 'down':
      await down(dryRun);
      break;
    case 'break':
      await breakStaging(v, mode, dryRun);
      break;
    case 'reset': {
      const ok = await reset(v, mode, { yes: opts.yes, dryRun, anyAuthor: opts['any-author'], skipDoctor: opts['no-doctor'] });
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'replay':
    case 'times': {
      const file = positionals[0] ?? defaultTimeline();
      if (!file) fail('no timeline yet: run a rehearsal first, or pass a file');
      if (!existsSync(file)) fail(`${file} does not exist`);
      const script = command === 'replay' ? scripts.loop : join(repoRoot, 'demo', 'loop', 'times.ts');
      const port = Number(opts.port ?? v.LOOP_PORT);
      const args = command === 'replay' ? ['--port', String(port), '--replay', file] : [file];
      if (dryRun) {
        console.log(`would run: node ${script.replace(`${repoRoot}/`, '')} ${args.join(' ')}`);
        return;
      }
      if (!existsSync(script)) fail(`${script} does not exist yet (the loop screen is built in demo/loop/)`);
      if (command === 'replay' && (await listenerPids(port)).length) {
        fail(`port ${port} is in use (is ./demo.sh up running?); stop it with ./demo.sh down or use --port ${port + 10}`);
      }
      process.exit(await runForeground(script, args));
      break;
    }
  }
}

await main();
