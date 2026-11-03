export type SlackBody = { ok: boolean; error?: string; [key: string]: unknown };

export type SlackResult = { body: SlackBody; scopes: string[] | undefined };

const base = 'https://slack.com/api/';

/**
 * Calls one Slack Web API method with the bot token. Errors come back as
 * { ok: false, error } and never include the token.
 */
export async function slackApi(
  method: string,
  token: string,
  params: Record<string, string | boolean | undefined>,
  options: { json?: boolean; timeoutMs?: number } = {},
): Promise<SlackResult> {
  if (!token) return { body: { ok: false, error: 'no_token' }, scopes: undefined };
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string;
  if (options.json) {
    headers['content-type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(params);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }
    body = form.toString();
  }
  try {
    const res = await fetch(base + method, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    const scopes = res.headers
      .get('x-oauth-scopes')
      ?.split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (!res.ok) return { body: { ok: false, error: `http_${res.status}` }, scopes };
    return { body: (await res.json()) as SlackBody, scopes };
  } catch (error) {
    const name = (error as Error).name;
    return { body: { ok: false, error: name === 'TimeoutError' ? 'timeout' : 'network_error' }, scopes: undefined };
  }
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const { body } = await slackApi(
    'chat.postMessage',
    token,
    { channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false },
    { json: true },
  );
  if (body.ok && typeof body.ts === 'string') return { ok: true, ts: body.ts };
  return { ok: false, error: body.error ?? 'unknown_error' };
}

export async function getPermalink(token: string, channel: string, ts: string): Promise<string> {
  const { body } = await slackApi('chat.getPermalink', token, { channel, message_ts: ts });
  return body.ok && typeof body.permalink === 'string' ? body.permalink : '';
}
