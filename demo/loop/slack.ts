// Reads the alert's Slack thread with the Invoice monitor's bot token. Read-only:
// auth.test and conversations.replies, nothing that posts or changes anything.

import type { SlackIdentity, SlackReaction, SlackReply, SlackThread, SourceStatus } from './types.ts';
import { arr, isObj, obj, str, strOrNull } from './json.ts';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** Message text plus any text inside blocks and attachments, for marker and URL matching. */
export function flattenText(message: unknown): string {
  const m = obj(message);
  const parts: string[] = [str(m.text)];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.text === 'string') parts.push(v.text);
    if (typeof v.url === 'string') parts.push(v.url);
    for (const [k, x] of Object.entries(v)) if (k !== 'text' && typeof x === 'object') walk(x);
    if (isObj(v.text)) walk(v.text);
  };
  walk(m.blocks);
  walk(m.attachments);
  return parts.filter((p) => p !== '').join('\n');
}

export function slackErrorStatus(error: string, needed: string): SourceStatus {
  switch (error) {
    case 'missing_scope':
      return { state: 'error', note: `needs ${needed !== '' ? needed : 'groups:history'}` };
    case 'not_in_channel':
    case 'channel_not_found':
      return { state: 'error', note: 'app not in the channel' };
    case 'invalid_auth':
    case 'not_authed':
    case 'account_inactive':
    case 'token_revoked':
    case 'token_expired':
      return { state: 'error', note: 'token rejected' };
    case 'thread_not_found':
      return { state: 'error', note: 'alert message not found' };
    case 'ratelimited':
      return { state: 'waiting', note: 'rate limited' };
    default:
      return { state: 'error', note: error !== '' ? error : 'unexpected answer' };
  }
}

export type SlackUpdate = { identity: SlackIdentity | null; thread: SlackThread | null; status: SourceStatus };

export type SlackPoller = {
  setTarget: (target: { channel: string; ts: string } | null) => void;
  pollOnce: () => Promise<void>;
  stop: () => void;
};

export function createSlackPoller(opts: {
  token: string;
  intervalMs: number;
  onUpdate: (u: SlackUpdate) => void;
  fetchImpl?: FetchLike;
  now?: () => string;
  autoStart?: boolean;
}): SlackPoller {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => new Date().toISOString());
  let identity: SlackIdentity | null = null;
  let identityError: SourceStatus | null = null;
  let identityTriedAt = 0;
  let target: { channel: string; ts: string } | null = null;
  let thread: SlackThread | null = null;
  let firstSeen = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let backoffUntil = 0;

  const call = async (method: string, params: Record<string, string>): Promise<{ body: Record<string, unknown>; retryAfter: number }> => {
    const qs = new URLSearchParams(params).toString();
    const res = await doFetch(`https://slack.com/api/${method}${qs !== '' ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (res.status === 429) {
      return { body: { ok: false, error: 'ratelimited' }, retryAfter: Number(res.headers.get('retry-after') ?? '5') };
    }
    return { body: obj(await res.json()), retryAfter: 0 };
  };

  const emit = (status: SourceStatus) => opts.onUpdate({ identity, thread, status });

  const pollOnce = async (): Promise<void> => {
    if (opts.token === '') {
      emit({ state: 'error', note: 'no token in demo/.env' });
      return;
    }
    if (Date.now() < backoffUntil) return;
    try {
      if (identity === null && Date.now() - identityTriedAt > 30_000) {
        identityTriedAt = Date.now();
        const { body } = await call('auth.test', {});
        if (body.ok === true) {
          identity = { userId: str(body.user_id), botId: strOrNull(body.bot_id) };
          identityError = null;
        } else {
          identityError = slackErrorStatus(str(body.error), str(body.needed));
        }
      }
      if (identityError !== null) {
        emit(identityError);
        return;
      }
      if (target === null) {
        emit({ state: 'ok', note: '' });
        return;
      }
      const t = target;
      const { body, retryAfter } = await call('conversations.replies', { channel: t.channel, ts: t.ts, limit: '200' });
      if (retryAfter > 0) backoffUntil = Date.now() + retryAfter * 1000;
      if (body.ok !== true) {
        emit(slackErrorStatus(str(body.error), str(body.needed)));
        return;
      }
      if (target !== t) return;
      const messages = arr(body.messages).map(obj);
      const parent = messages.find((x) => str(x.ts) === t.ts);
      const reactions: SlackReaction[] = [];
      for (const r of arr(parent?.reactions).map(obj)) {
        for (const user of arr(r.users)) {
          if (typeof user !== 'string') continue;
          const key = `${str(r.name)}:${user}`;
          if (!firstSeen.has(key)) firstSeen.set(key, now());
          reactions.push({ name: str(r.name), user, firstSeen: firstSeen.get(key) ?? now() });
        }
      }
      const replies: SlackReply[] = messages
        .filter((x) => str(x.ts) !== t.ts)
        .map((x) => ({ ts: str(x.ts), user: strOrNull(x.user), botId: strOrNull(x.bot_id), subtype: strOrNull(x.subtype), text: flattenText(x) }));
      thread = { channel: t.channel, threadTs: t.ts, replies, reactions };
      emit({ state: 'ok', note: '' });
    } catch {
      emit({ state: 'error', note: 'offline' });
    }
  };

  const loop = async (): Promise<void> => {
    if (stopped) return;
    await pollOnce();
    if (!stopped) timer = setTimeout(() => void loop(), opts.intervalMs);
  };
  if (opts.autoStart !== false) void loop();

  return {
    pollOnce,
    setTarget: (next) => {
      if (next?.channel === target?.channel && next?.ts === target?.ts) return;
      target = next;
      thread = null;
      firstSeen = new Map();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
