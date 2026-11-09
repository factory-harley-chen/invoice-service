/** Helpers for the "Evidence pictures" job (scripts/ci-pictures.ts). */

export type PullKind = 'fix' | 'check';

/** The kind of pull request and its slug, from a fix/<slug> or check/<slug> branch; undefined for any other branch. */
export function pullKind(headRef: string): { kind: PullKind; slug: string } | undefined {
  const match = /^(fix|check)\/([a-z0-9][a-z0-9-]*)$/.exec(headRef);
  const kind = match?.[1];
  const slug = match?.[2];
  if (!slug || (kind !== 'fix' && kind !== 'check')) return undefined;
  return { kind, slug };
}

/** Where the job publishes a pull request's pictures; the check's own branch keeps the fix's pictures intact. */
export function evidenceBranch(kind: PullKind, slug: string): string {
  return kind === 'fix' ? `evidence/${slug}` : `evidence/check-${slug}`;
}

/** True when the body already shows pictures published in this repo. */
export function hasPictures(body: string, repo: string): boolean {
  return body.includes(`](https://raw.githubusercontent.com/${repo}/`);
}

/** The booking the fix is about: from the "Invoice <id>:" evidence line, else from "booking <id>". */
export function bookingFromBody(body: string): string | undefined {
  return /^\s*(?:[-*]\s*)?Invoice ([A-Z]+-\d+):/m.exec(body)?.[1] ?? /\bbooking ([A-Z]+-\d+)\b/i.exec(body)?.[1];
}

/** BILLING_CURRENCIES as the alert gave it, when the body carries it. */
export function currenciesFromBody(body: string): string[] | undefined {
  const list = /BILLING_CURRENCIES=([A-Z]{3}(?:,[A-Z]{3})*)/.exec(body)?.[1];
  return list ? list.split(',') : undefined;
}

/** Every currency the rate card prices, in alphabetical order. */
export function rateCardCurrencies(rateCard: { items: { prices: Record<string, string> }[] }): string[] {
  return [...new Set(rateCard.items.flatMap((item) => Object.keys(item.prices)))].sort();
}

/**
 * The body with the pictures added: in place of a "Screenshots: not taken"
 * line, else after the "Cause:" evidence line, else at the end. Blank lines
 * around the block keep the next paragraph out of the table.
 */
export function withPictures(body: string, block: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const notTaken = lines.findIndex((line) => /^\s*Screenshots: not taken\b/i.test(line));
  if (notTaken >= 0) {
    lines.splice(notTaken, 1, '', block, '');
  } else {
    const cause = lines.findIndex((line) => /^\s*(?:[-*]\s*)?Cause:/.test(line));
    if (cause >= 0) lines.splice(cause + 1, 0, '', block, '');
    else lines.push('', block);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export const notes = {
  fix: "The run left no pictures, so CI made these from main's code (before) and this pull request's code (after).",
  check: "The new check on main's code, before the fix, and on this pull request's code, after it. Pictures made by CI.",
} as const;
