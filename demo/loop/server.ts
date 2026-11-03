// node demo/loop/server.ts [--port N] [--replay FILE [--speed N] [--run N]] [--simulate [--speed N] [--at S] [--record FILE]] [--dry-run]
// Serves the loop screen on 127.0.0.1 and pushes its state to the page over
// server-sent events. The page never calls Slack or GitHub; this process does,
// and only in live mode. Replay and simulation load no network code at all.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import { USAGE, describe, loadConfig, parseArgs } from './config.ts';
import type { Args, Config } from './config.ts';
import { currentAlert, derive, runActive } from './rules.ts';
import type { RuleConfig } from './rules.ts';
import { initialInputs, script, SIMULATION_LENGTH_S } from './simulate.ts';
import { createTimelineWriter, pickRun, readTimeline } from './timeline.ts';
import type { Frame, Run, TimelineWriter } from './timeline.ts';
import { dateTime, iso, ms } from './time.ts';
import type { Inputs, LoopState, Push, Sources } from './types.ts';

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
}
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const cfg: Config = loadConfig(args);
if (args.dryRun) {
  process.stdout.write(`${describe(cfg)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Push hub

const clients = new Set<ServerResponse>();
let latest: LoopState | null = null;
let virtualNow: () => number = () => Date.now();
let speed = 1;

function push(): string {
  if (latest === null) return '';
  const p: Push = { state: latest, clock: { virtualMs: virtualNow(), speed } };
  return `data: ${JSON.stringify(p)}\n\n`;
}

function publish(state: LoopState): void {
  latest = state;
  const msg = push();
  for (const c of clients) c.write(msg);
}

const heartbeat = setInterval(() => {
  const msg = push();
  if (msg !== '') for (const c of clients) c.write(msg);
}, 5000);

// ---------------------------------------------------------------------------
// HTTP

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/loop.css': { file: 'loop.css', type: 'text/css; charset=utf-8' },
  '/loop.js': { file: 'loop.js', type: 'text/javascript; charset=utf-8' },
};

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    const msg = push();
    if (msg !== '') res.write(msg);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (path === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ state: latest, clock: { virtualMs: virtualNow(), speed } }));
    return;
  }
  const asset = STATIC[path];
  if (asset === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  try {
    const body = readFileSync(resolve(cfg.publicDir, asset.file));
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Missing asset');
  }
});

const stoppers: (() => void)[] = [];
function shutdown(): void {
  for (const s of stoppers) s();
  clearInterval(heartbeat);
  for (const c of clients) c.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (e: NodeJS.ErrnoException) => {
  fail(e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use` : `Server error: ${e.message}`, 1);
});

// ---------------------------------------------------------------------------
// Modes

function ruleConfig(overrides: Partial<RuleConfig>): RuleConfig {
  return {
    botLogin: cfg.github.botLogin,
    ownerLogin: cfg.github.ownerLogin,
    ownerName: cfg.ownerName,
    runIdentity: cfg.runIdentity,
    workspaceUrl: cfg.slack.workspaceUrl,
    demoMode: cfg.demoMode,
    checks: cfg.checks,
    banner: null,
    ...overrides,
  };
}

/** Recomputes on every input change; publishes and records only real changes. */
function engine(inputs: Inputs, rules: RuleConfig, writer: TimelineWriter | null, now: () => number) {
  let last = '';
  let writeFailed = false;
  return (): void => {
    const state = derive(inputs, rules);
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    publish(state);
    if (writer === null) return;
    try {
      writer.write(iso(now()), state);
    } catch (e) {
      if (!writeFailed) process.stderr.write(`Timeline not written: ${e instanceof Error ? e.message : String(e)}\n`);
      writeFailed = true;
    }
  };
}

function logStatusChanges(): (sources: Sources) => void {
  let seen = '';
  return (sources) => {
    const line = (['monitor', 'slack', 'github'] as const)
      .map((k) => `${k} ${sources[k].state}${sources[k].note !== '' ? ` (${sources[k].note})` : ''}`)
      .join(', ');
    if (line !== seen) process.stdout.write(`[${new Date().toLocaleTimeString('en-GB')}] ${line}\n`);
    seen = line;
  };
}

async function startLive(): Promise<void> {
  const { createEventsTail } = await import('./events.ts');
  const { createSlackPoller } = await import('./slack.ts');
  const { createGithubPoller } = await import('./github.ts');
  const waiting = { state: 'waiting' as const, note: '' };
  const inputs: Inputs = { events: [], slackIdentity: null, thread: null, github: null, sources: { slack: waiting, github: waiting, monitor: waiting } };
  const writer = createTimelineWriter(cfg.timelineFile);
  writer.meta(cfg.demoMode === 'live' ? 'live' : 'rehearsal', new Date().toISOString());
  const recompute = engine(inputs, ruleConfig({}), writer, () => Date.now());
  const log = logStatusChanges();
  const update = () => {
    log(inputs.sources);
    recompute();
  };

  const slack = createSlackPoller({
    token: cfg.slack.token,
    intervalMs: cfg.slack.intervalMs,
    onUpdate: (u) => {
      inputs.slackIdentity = u.identity;
      inputs.thread = u.thread;
      inputs.sources = { ...inputs.sources, slack: u.status };
      update();
    },
  });
  const github = createGithubPoller({
    repo: cfg.github.repo,
    activeMs: cfg.github.activeMs,
    idleMs: cfg.github.idleMs,
    onUpdate: (snapshot, status) => {
      if (snapshot !== null) inputs.github = snapshot;
      inputs.sources = { ...inputs.sources, github: status };
      update();
    },
  });
  const tail = createEventsTail({
    file: cfg.eventsFile,
    intervalMs: 500,
    onEvents: (events, reset) => {
      inputs.events = events;
      if (reset) inputs.thread = null;
      slack.setTarget(currentAlert(events));
      github.setActive(runActive(events));
      update();
    },
    onStatus: (s) => {
      inputs.sources = { ...inputs.sources, monitor: s };
      update();
    },
  });
  stoppers.push(() => tail.stop(), () => slack.stop(), () => github.stop());
  update();
  process.stdout.write(`Recording every change to ${cfg.timelineFile}\n`);
}

function startSimulation(): void {
  speed = args.speed;
  const realStart = Date.now();
  const baseMs = realStart - args.at * 1000;
  virtualNow = () => realStart + (Date.now() - realStart) * speed;
  const t = (sec: number) => iso(baseMs + sec * 1000);
  const inputs = initialInputs();
  const writer = recordPath === '' ? null : createTimelineWriter(recordPath);
  writer?.meta('simulate', iso(realStart));
  const rules = ruleConfig({ banner: { kind: 'simulate', text: 'Simulation: not a real run' }, workspaceUrl: '' });
  const recompute = engine(inputs, rules, writer, virtualNow);
  const timers: NodeJS.Timeout[] = [];
  for (const step of script()) {
    if (step.at <= args.at) {
      step.apply(inputs, t);
      continue;
    }
    timers.push(
      setTimeout(() => {
        step.apply(inputs, t);
        process.stdout.write(`  ${String(step.at).padStart(3)} s  ${step.label}\n`);
        recompute();
      }, ((step.at - args.at) * 1000) / speed),
    );
  }
  recompute();
  stoppers.push(() => timers.forEach(clearTimeout));
  process.stdout.write(`Simulation from ${args.at} s, about ${Math.round((SIMULATION_LENGTH_S - args.at) / speed)} s to go${recordPath !== '' ? `; recording to ${recordPath}` : ''}\n`);
}

function startReplay(): void {
  const file = resolve(args.replayFile);
  let runs: Run[];
  try {
    runs = readTimeline(file);
  } catch (e) {
    fail(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
  const run = pickRun(runs, args.run);
  if (run === null) fail(runs.length === 0 ? `No runs recorded in ${file}` : `No run ${args.run ?? ''} in ${file}; it has runs 1 to ${runs.length}`, 1);
  const first = run.frames[0];
  const lastFrame = run.frames[run.frames.length - 1];
  if (first === undefined || lastFrame === undefined) fail(`Run ${run.index} has no snapshots`, 1);
  const suffix = run.source === 'simulate' ? ' (simulation)' : run.source === 'rehearsal' ? ' (rehearsal)' : run.source === 'live' ? ' (live)' : '';
  const banner = { kind: 'replay' as const, text: `Recorded at ${dateTime(run.runKey)}${suffix}` };
  const off = { state: 'off' as const, note: 'recorded' };
  const shown = (f: Frame): LoopState => ({ ...f.state, banner, sources: { slack: off, github: off, monitor: off } });

  speed = args.speed;
  const leadMs = run.lead !== null ? 3000 : 0;
  const vStart = ms(first.at) - leadMs;
  const vEnd = ms(lastFrame.at) + 2000;
  const realStart = Date.now();
  virtualNow = () => Math.min(vEnd, vStart + (Date.now() - realStart) * speed);
  publish(shown(run.lead ?? first));
  const timers = run.frames.map((f) => setTimeout(() => publish(shown(f)), Math.max(0, (ms(f.at) - vStart) / speed)));
  timers.push(
    setTimeout(() => {
      speed = 0;
      if (latest !== null) publish(latest);
      process.stdout.write('Replay finished; the last frame stays on screen\n');
    }, (vEnd - vStart) / args.speed),
  );
  stoppers.push(() => timers.forEach(clearTimeout));
  process.stdout.write(`Replaying run ${run.index} of ${runs.length} from ${file}: ${run.frames.length} frames over ${Math.round((vEnd - vStart) / 1000)} s at speed ${args.speed}; no network\n`);
}

const recordPath = args.record === '' ? '' : resolve(args.record);
if (recordPath !== '' && (recordPath === cfg.stateDir || recordPath.startsWith(cfg.stateDir + sep))) {
  fail(`--record must not write inside ${cfg.stateDir}; the simulation never touches demo/state`);
}

server.listen(cfg.port, '127.0.0.1', () => {
  process.stdout.write(`Loop screen (${args.mode}) on http://127.0.0.1:${cfg.port}/  (pid ${process.pid})\n`);
  if (args.mode === 'replay') startReplay();
  else if (args.mode === 'simulate') startSimulation();
  else void startLive();
});
