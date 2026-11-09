/** Test files added or changed, from `git diff --name-only` output. */
export function changedTests(nameOnly: string): string[] {
  return nameOnly
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts'));
}

export type Verdict = { ok: boolean; line: string };

/**
 * The check passes only when the tests ran on the base branch's code and at
 * least one of them failed. A run that never got to the tests (for example an
 * import that does not exist there) proves nothing, so it fails the check.
 */
export function verdict(exitCode: number | null, output: string): Verdict {
  const failed = /Tests\s+(\d+) failed/.exec(output)?.[1];
  if (exitCode !== 0 && failed !== undefined) {
    return { ok: true, line: `The new test fails on main's code, as it should (${failed} failed), so it shows the fault this pull request fixes.` };
  }
  if (exitCode === 0) {
    return { ok: false, line: "The pull request's tests pass on main's code, so they don't show the fault." };
  }
  return { ok: false, line: "The pull request's tests didn't run on main's code, so this proves nothing. See the output." };
}

/** The job summary: the verdict, the files, and the test output on the base branch's code. */
export function jobSummary(base: string, tests: readonly string[], result: Verdict, output: string): string {
  const files = tests.length ? tests.map((file) => `\`${file}\``).join(', ') : 'none';
  return [
    `## ${result.ok ? 'Fails without the fix' : 'Does not show the fault'}`,
    '',
    result.line,
    '',
    `Tests from this pull request: ${files}. Code: \`${base}\`.`,
    '',
    '```',
    output.replace(/\s+$/, ''),
    '```',
    '',
  ].join('\n');
}
