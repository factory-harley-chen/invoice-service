// Runs a pull request's new or changed tests on the base branch's code:
//   node scripts/fails-before.ts <base ref, for example origin/main>
// Exits 0 only if at least one of them fails there, which shows the tests
// catch the fault the pull request fixes. Writes the verdict and the output
// to the GitHub job summary when GITHUB_STEP_SUMMARY is set.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { changedTests, jobSummary, verdict, type Verdict } from './lib/fails-before.ts';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/fails-before.ts <base ref>');
  process.exit(2);
}

function report(tests: string[], result: Verdict, output: string): never {
  if (output) console.log(output);
  console.log(result.line);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, jobSummary(base as string, tests, result, output));
  process.exit(result.ok ? 0 : 1);
}

const tests = changedTests(git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]));
if (tests.length === 0) {
  report(tests, { ok: false, line: 'This pull request adds or changes no test, so nothing shows the fault.' }, '');
}

function runOnBase(): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fails-before-'));
  git(['worktree', 'add', '--detach', '--quiet', dir, base as string]);
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'));
    for (const file of tests) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), git(['show', `HEAD:${file}`]));
    }
    const run = spawnSync('sh', ['-c', 'npx vitest run "$@" 2>&1', 'sh', ...tests], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { status: run.status, output: run.stdout ?? '' };
  } finally {
    git(['worktree', 'remove', '--force', dir]);
  }
}

const { status, output } = runOnBase();
report(tests, verdict(status, output), output);
