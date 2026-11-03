import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appendEvent } from '../demo/lib/events.ts';
import { readJsonFile, writeJsonFile } from '../demo/lib/json.ts';
import { files, repoRoot } from '../demo/lib/paths.ts';
import { readStaging } from '../demo/lib/staging.ts';
import { channelFor, loadValues, parseMode } from '../demo/lib/values.ts';
import { alertName, checkAll, firingText, resolvedText, type Mismatch, type RateCard, type ServedInvoice } from './check.ts';
import { getPermalink, postMessage, slackApi } from './slack.ts';
import { decide, emptyState, type MonitorState, type Observation } from './state.ts';

const help = `Usage: node monitor/monitor.ts [--mode live|rehearsal] [--dry-run] [--interval SECONDS] [--once]

Polls staging (STAGING_PORT) every 2 s and checks every invoice line against
config/rates.json. On the first mismatch it posts one FIRING message to the
mode's Slack channel and appends alert_fired to demo/state/events.jsonl. When
every invoice matches on two polls in a row it posts RESOLVED as a reply in
the alert's thread and appends alert_resolved. State survives a restart
(demo/state/monitor.json).

  --mode       live or rehearsal (default: DEMO_MODE)
  --dry-run    print the messages and events instead of posting or writing
  --interval   seconds between polls (default 2)
  --once       poll once and exit`;

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    interval: { type: 'string', default: '2' },
    once: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(help);
  process.exit(0);
}

const v = loadValues().values;
const mode = parseMode(args.mode, v.DEMO_MODE);
const channel = channelFor(v, mode);
const dryRun = args['dry-run'];
const intervalSeconds = Number(args.interval);
const token = v.SLACK_BOT_TOKEN;

if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
  console.error(`--interval must be a positive number of seconds, not "${args.interval}"`);
  process.exit(2);
}
if (!dryRun && (!token || !channel)) {
  console.error(`monitor: SLACK_BOT_TOKEN and the ${mode} channel id must be set in demo/.env (or use --dry-run)`);
  process.exit(2);
}

const stagingBase = `http://127.0.0.1:${v.STAGING_PORT}`;
const rates = JSON.parse(readFileSync(join(repoRoot, 'config', 'rates.json'), 'utf8')) as RateCard;
const billing = JSON.parse(readFileSync(join(repoRoot, 'config', 'billing.json'), 'utf8')) as { sendAt: string };

let state: MonitorState = dryRun ? emptyState() : (readJsonFile<MonitorState>(files.monitor()) ?? emptyState());

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function save(): void {
  if (!dryRun) writeJsonFile(files.monitor(), state);
}

function record(type: 'alert_fired' | 'alert_resolved', data: Record<string, unknown>): void {
  if (dryRun) {
    log(`DRY RUN: would append ${type} ${JSON.stringify(data)}`);
    return;
  }
  appendEvent(type, data);
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(stagingBase + path, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function observe(): Promise<Observation> {
  try {
    const list = await fetchJson<{ invoices: Array<{ bookingId: string }> }>('/invoices');
    const invoices = await Promise.all(
      list.invoices.map((entry) => fetchJson<ServedInvoice>(`/invoices/${encodeURIComponent(entry.bookingId)}`)),
    );
    const [first] = checkAll(invoices, rates);
    return first ? { kind: 'mismatch', mismatch: first } : { kind: 'ok' };
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message };
  }
}

let unsureSince: number | undefined;

/**
 * After a timeout Slack may have posted the message anyway. Looking for it
 * before posting again keeps it to one alert, and so to one run.
 */
async function findRecentFiring(sinceSeconds: number): Promise<string | undefined> {
  const { body } = await slackApi('conversations.history', token, { channel, oldest: String(sinceSeconds), limit: '20' });
  if (!body.ok || !Array.isArray(body.messages)) return undefined;
  const messages = body.messages as Array<{ ts?: string; text?: string; thread_ts?: string }>;
  const found = messages.find((m) => m.text?.startsWith(`FIRING ${alertName}`) && (!m.thread_ts || m.thread_ts === m.ts));
  return found?.ts;
}

async function fire(mismatch: Mismatch): Promise<void> {
  const firstSeen = new Date();
  const text = firingText(mismatch, {
    firstSeen,
    currencies: readStaging()?.currencies,
    repo: v.GITHUB_REPO,
    sendAt: billing.sendAt,
  });
  let ts: string;
  if (dryRun) {
    log(`DRY RUN: would post to ${channel || `the ${mode} channel`}:\n${text}`);
    ts = 'dry-run';
  } else {
    const adopted = unsureSince !== undefined ? await findRecentFiring(unsureSince) : undefined;
    if (adopted) {
      log(`found the FIRING message from an earlier attempt (ts ${adopted}); not posting again`);
      ts = adopted;
    } else {
      const attemptAt = Date.now() / 1000 - 5;
      const posted = await postMessage(token, channel, text);
      if (!posted.ok) {
        if (posted.error === 'timeout' || posted.error === 'network_error') unsureSince ??= attemptAt;
        log(`could not post FIRING (${posted.error}); trying again on the next poll`);
        return;
      }
      ts = posted.ts;
      log(`posted FIRING to ${channel} (ts ${ts}):\n${text}`);
    }
    unsureSince = undefined;
  }
  const permalink = dryRun ? '' : await getPermalink(token, channel, ts);
  state = { incident: { channel, ts, permalink, firstSeen: firstSeen.toISOString(), mismatch }, okStreak: 0 };
  save();
  record('alert_fired', {
    channel,
    ts,
    permalink,
    bookingId: mismatch.bookingId,
    customer: mismatch.customer,
    item: mismatch.item,
    unit: mismatch.unit,
    quantity: mismatch.quantity,
    currency: mismatch.currency,
    expected: mismatch.expected,
    actual: mismatch.actual,
  });
}

async function resolve(): Promise<void> {
  const incident = state.incident;
  if (!incident) return;
  const text = resolvedText(new Date(incident.firstSeen), new Date(), intervalSeconds);
  let ts: string;
  if (dryRun) {
    log(`DRY RUN: would reply in the alert's thread (${incident.ts}):\n${text}`);
    ts = 'dry-run';
  } else {
    const posted = await postMessage(token, incident.channel, text, incident.ts);
    if (!posted.ok) {
      log(`could not post RESOLVED (${posted.error}); trying again on the next poll`);
      return;
    }
    ts = posted.ts;
    log(`posted RESOLVED in thread ${incident.ts}:\n${text}`);
  }
  const permalink = dryRun ? '' : await getPermalink(token, incident.channel, ts);
  record('alert_resolved', {
    channel: incident.channel,
    threadTs: incident.ts,
    ts,
    permalink,
    bookingId: incident.mismatch.bookingId,
  });
  state = emptyState();
  save();
}

let lastSeen = '';

async function tick(): Promise<void> {
  const observation = await observe();
  const summary =
    observation.kind === 'mismatch'
      ? `mismatch on ${observation.mismatch.bookingId}`
      : observation.kind === 'unknown'
        ? `staging unreadable (${observation.reason})`
        : 'all invoices match';
  if (summary !== lastSeen) {
    log(summary);
    lastSeen = summary;
  }
  const decision = decide(state, observation);
  state = { ...state, okStreak: decision.okStreak };
  if (decision.action === 'fire' && observation.kind === 'mismatch') {
    await fire(observation.mismatch);
  } else if (decision.action === 'resolve') {
    await resolve();
  }
  save();
}

log(
  `monitor started: ${dryRun ? 'DRY RUN, ' : ''}mode ${mode}, channel ${channel || 'unset'}, staging ${stagingBase}, every ${intervalSeconds} s` +
    (state.incident ? `, open incident from ${state.incident.firstSeen} (thread ${state.incident.ts})` : ''),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`monitor stopping (${signal})`);
    process.exit(0);
  });
}

for (;;) {
  const started = Date.now();
  await tick();
  if (args.once) break;
  await new Promise((r) => setTimeout(r, Math.max(0, intervalSeconds * 1000 - (Date.now() - started))));
}
