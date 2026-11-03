// Time helpers. Clock texts use the laptop's local time zone.

export function ms(iso: string): number {
  return Date.parse(iso);
}

export function iso(msValue: number): string {
  return new Date(msValue).toISOString();
}

/** Slack message ts ("1762165331.123456", seconds) to ISO 8601 UTC. */
export function slackTsToIso(ts: string): string {
  return iso(Math.round(Number.parseFloat(ts) * 1000));
}

export function msToSlackTs(msValue: number): string {
  return (msValue / 1000).toFixed(6);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function hhmm(isoValue: string | null): string {
  if (isoValue === null) return '';
  const d = new Date(isoValue);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(isoValue: string): string {
  const d = new Date(isoValue);
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${month}, ${hhmm(isoValue)}`;
}

/** 9:52, or 1:02:03 from an hour. Negative durations show as 0:00. */
export function clockText(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function earliest(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(ms(v))) continue;
    if (best === null || ms(v) < ms(best)) best = v;
  }
  return best;
}

export function latest(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(ms(v))) continue;
    if (best === null || ms(v) > ms(best)) best = v;
  }
  return best;
}

/** Never earlier than floor: a source clock a little behind ours must not light a station before its cause. */
export function notBefore(value: string | null, floor: string | null): string | null {
  if (value === null || floor === null) return value;
  return ms(value) < ms(floor) ? floor : value;
}
