/** owner/name from a GitHub remote URL (https or ssh), or undefined. */
export function repoFromRemote(url: string): string | undefined {
  const match = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1];
}

export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/** A two-column Markdown table that shows the before and after screenshots from one commit. */
export function evidenceTable(repo: string, commit: string): string {
  const url = (name: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${name}`;
  return [
    '| Before | After |',
    '| --- | --- |',
    `| ![Invoice before the fix](${url('before.png')}) | ![Invoice after the fix](${url('after.png')}) |`,
  ].join('\n');
}
