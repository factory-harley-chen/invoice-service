// Values come from the environment first, then demo/.env. The Slack token is
// read here and only ever passed to the Slack poller; nothing prints it.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckNames } from './rules.ts';

export type Mode = 'live' | 'replay' | 'simulate';

export type Args = {
  port: number | null;
  mode: Mode;
  replayFile: string;
  speed: number;
  run: number | null;
  at: number;
  record: string;
  dryRun: boolean;
  help: boolean;
};

export type Config = {
  repoRoot: string;
  envFile: string;
  stateDir: string;
  eventsFile: string;
  timelineFile: string;
  publicDir: string;
  port: number;
  stagingUrl: string;
  args: Args;
  demoMode: string;
  slack: { token: string; workspaceUrl: string; channelLive: string; channelRehearsal: string; intervalMs: number };
  github: { repo: string; ownerLogin: string; botLogin: string; activeMs: number; idleMs: number };
  ownerName: string;
  runIdentity: string;
  checks: CheckNames;
};

export const USAGE = `Loop screen for the invoice demo.

Usage:
  node demo/loop/server.ts [--port N] [--dry-run]       live: reads the monitor, Slack and GitHub
  node demo/loop/server.ts --replay <timeline.jsonl> [--speed N] [--run N] [--port N]
  node demo/loop/server.ts --simulate [--speed N] [--at SECONDS] [--record FILE] [--port N]
  node demo/loop/times.ts [timeline.jsonl]

Options:
  --port N        port on 127.0.0.1 (default LOOP_PORT, else 4200)
  --replay FILE   play a recorded timeline at real speed, with no network
  --speed N       playback speed for --replay and --simulate (default 1)
  --run N         which recorded run to replay, 1 = oldest (default: the last)
  --simulate      a scripted fake run through every station in about 2 minutes
  --at SECONDS    start the simulation this far in
  --record FILE   with --simulate, write its timeline to FILE (never inside demo/state)
  --dry-run       print the config (without the token) and exit
  --help          this text
`;

export function parseArgs(argv: string[]): Args {
  const a: Args = { port: null, mode: 'live', replayFile: '', speed: 1, run: null, at: 0, record: '', dryRun: false, help: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const positive = (v: string, flag: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
        a.port = Math.trunc(positive(value(i, arg), arg));
        i += 1;
        break;
      case '--replay':
        a.mode = 'replay';
        a.replayFile = value(i, arg);
        i += 1;
        break;
      case '--simulate':
        a.mode = 'simulate';
        break;
      case '--speed':
        a.speed = positive(value(i, arg), arg);
        i += 1;
        break;
      case '--run':
        a.run = Math.trunc(positive(value(i, arg), arg));
        i += 1;
        break;
      case '--at': {
        const n = Number(value(i, arg));
        if (!Number.isFinite(n) || n < 0) throw new Error('--at must be 0 or more seconds');
        a.at = n;
        i += 1;
        break;
      }
      case '--record':
        a.record = value(i, arg);
        i += 1;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--help':
      case '-h':
        a.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg ?? ''}`);
    }
  }
  if (a.record !== '' && a.mode !== 'simulate') throw new Error('--record only works with --simulate');
  return a;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[key] = v;
  }
  return out;
}

export function loadConfig(args: Args, env: Record<string, string | undefined> = process.env, repoRoot = resolve(import.meta.dirname, '../..')): Config {
  const envFile = resolve(repoRoot, 'demo/.env');
  const fileValues = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
  const get = (key: string, fallback = ''): string => {
    const v = env[key] ?? fileValues[key];
    return v !== undefined && v !== '' ? v : fallback;
  };
  const stateDir = resolve(repoRoot, get('DEMO_STATE_DIR', 'demo/state'));
  const portValue = Number(get('LOOP_PORT', '4200'));
  return {
    repoRoot,
    envFile,
    stateDir,
    eventsFile: resolve(stateDir, 'events.jsonl'),
    timelineFile: resolve(stateDir, 'timeline.jsonl'),
    publicDir: resolve(import.meta.dirname, 'public'),
    port: args.port ?? (Number.isFinite(portValue) && portValue > 0 ? portValue : 4200),
    stagingUrl: `http://127.0.0.1:${get('STAGING_PORT', '4100')}`,
    args,
    demoMode: get('DEMO_MODE', 'rehearsal'),
    slack: {
      token: get('SLACK_BOT_TOKEN'),
      workspaceUrl: get('SLACK_WORKSPACE_URL', 'https://factory-gtm.slack.com'),
      channelLive: get('SLACK_CHANNEL_LIVE'),
      channelRehearsal: get('SLACK_CHANNEL_REHEARSAL'),
      intervalMs: 2500,
    },
    github: {
      repo: get('GITHUB_REPO', 'factory-harley-chen/invoice-service'),
      ownerLogin: get('OWNER_LOGIN', 'factory-harley-chen'),
      botLogin: get('BOT_LOGIN', 'factory-droid[bot]'),
      activeMs: 3500,
      idleMs: 30_000,
    },
    ownerName: get('OWNER_NAME', 'Harley'),
    runIdentity: get('RUN_IDENTITY'),
    checks: {
      tests: get('CHECK_TESTS', 'Lint, typecheck and test'),
      codeReview: get('CHECK_CODE_REVIEW', 'droid.?review|code.?review'),
      securityReview: get('CHECK_SECURITY_REVIEW', 'security'),
    },
  };
}

/** The dry-run report. It says whether the token is set and nothing else about it. */
export function describe(cfg: Config): string {
  const a = cfg.args;
  const show = (v: string) => (v === '' ? '(not set)' : v);
  const lines = [
    'Loop screen config (dry run: nothing started, nothing called)',
    `  mode            ${a.mode}${a.mode === 'live' ? ` (DEMO_MODE=${cfg.demoMode}; an "up" event's mode overrides it)` : ''}`,
    `  page            http://127.0.0.1:${cfg.port}/`,
    `  values file     ${cfg.envFile} (${existsSync(cfg.envFile) ? 'found' : 'missing'})`,
  ];
  if (a.mode === 'live') {
    lines.push(
      `  events          ${cfg.eventsFile} (${existsSync(cfg.eventsFile) ? 'found' : 'not there yet'})`,
      `  timeline        ${cfg.timelineFile} (appended on every change)`,
      `  Slack token     ${cfg.slack.token === '' ? 'NOT SET' : 'set (hidden)'}`,
      `  Slack workspace ${cfg.slack.workspaceUrl}`,
      `  Slack channels  live ${show(cfg.slack.channelLive)}, rehearsal ${show(cfg.slack.channelRehearsal)} (the alert's own channel is the one read)`,
      `  Slack poll      conversations.replies every ${cfg.slack.intervalMs / 1000} s while an alert is open; auth.test once`,
      `  GitHub repo     ${cfg.github.repo}, through gh api graphql every ${cfg.github.activeMs / 1000} s during a run, ${cfg.github.idleMs / 1000} s otherwise`,
    );
  } else if (a.mode === 'replay') {
    lines.push(`  replay file     ${resolve(a.replayFile)}`, `  speed           ${a.speed}`, `  run             ${a.run ?? 'last'}`, '  network         none');
  } else {
    lines.push(`  speed           ${a.speed}`, `  start at        ${a.at} s`, `  record          ${a.record === '' ? '(none)' : resolve(a.record)}`, '  network         none; never writes demo/state');
  }
  lines.push(
    `  owner           ${cfg.ownerName} (${cfg.github.ownerLogin})`,
    `  bot             ${cfg.github.botLogin}`,
    `  run identity    ${show(cfg.runIdentity)}`,
    `  checks          tests "${cfg.checks.tests}", code review /${cfg.checks.codeReview}/i, security review /${cfg.checks.securityReview}/i`,
  );
  return lines.join('\n');
}
