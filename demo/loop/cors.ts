// Who may read the loop's state from another page. A slide deck shows the
// loop in its corner by fetching GET /state; the deck is opened from a file
// (its origin is "null") or served from this machine. The state is read-only
// and carries nothing secret, and every other route, the release screen's
// roll-out included, stays same-origin only.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** The origin to echo in Access-Control-Allow-Origin, or null to send none. */
export function readOrigin(origin: string | undefined): string | null {
  if (origin === undefined) return null;
  if (origin === 'null') return origin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LOCAL_HOSTS.has(url.hostname) || url.origin !== origin) return null;
  return origin;
}

/** Extra headers for GET /state and GET /events: the echoed origin, if it may read them. */
export function readHeaders(method: string | undefined, origin: string | undefined): Record<string, string> {
  const allowed = method === 'GET' ? readOrigin(origin) : null;
  return allowed === null ? {} : { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' };
}
