/** owner/name from a GitHub remote URL (https or ssh), or undefined. */
export function repoFromRemote(url: string): string | undefined {
  const match = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1];
}

export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export type PictureRow = { readonly label: string; readonly before: string; readonly after: string };

/** The pictures a run can publish, as rows of the table: before and after the fix. */
export const pictureRows: readonly PictureRow[] = [
  { label: 'The test', before: 'test-before.png', after: 'test-after.png' },
  { label: 'The invoice', before: 'invoice-before.png', after: 'invoice-after.png' },
];

export const pictureNames: readonly string[] = pictureRows.flatMap((row) => [row.before, row.after]);

/**
 * A Markdown table of the before and after pictures in one commit, one row per
 * pair that has at least one picture. Empty when there are none.
 */
export function evidenceTable(
  repo: string,
  commit: string,
  present: ReadonlySet<string>,
  rows: readonly PictureRow[] = pictureRows,
): string {
  const url = (name: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${name}`;
  const cell = (name: string, alt: string) => (present.has(name) ? `![${alt}](${url(name)})` : 'Not taken');
  const shown = rows
    .filter((row) => present.has(row.before) || present.has(row.after))
    .map(
      (row) =>
        `| ${row.label} | ${cell(row.before, `${row.label} before the fix`)} | ${cell(row.after, `${row.label} after the fix`)} |`,
    );
  if (shown.length === 0) return '';
  return ['| | Before the fix | After the fix |', '| --- | --- | --- |', ...shown].join('\n');
}
