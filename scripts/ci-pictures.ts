// The "Evidence pictures" job (.github/workflows/evidence-pictures.yml):
//   node scripts/ci-pictures.ts need            prints needed=true or needed=false (also to GITHUB_OUTPUT)
//   node scripts/ci-pictures.ts make [--dry-run]
// A fix pull request gets pictures here only when its body has none (the run
// normally adds them): the test and the invoice on main's code, then on the
// pull request's code. A check pull request always gets its new check on
// main's code (before the fix) and on its own code (after it).
// Never fails the job: a problem leaves the body as it is and goes to the log
// and the job summary.
// Environment: PR_NUMBER, HEAD_REF, BASE_REF, GITHUB_REPOSITORY (else origin),
// GH_TOKEN; BEFORE_REF (default origin/main); PR_BODY_FILE reads the body from
// a file instead of GitHub (with --dry-run, for trying it locally).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceTable, pictureRows, repoFromRemote, type PictureRow } from './lib/evidence.ts';
import { changedTests } from './lib/fails-before.ts';
import {
  bookingFromBody,
  currenciesFromBody,
  evidenceBranch,
  hasPictures,
  notes,
  pullKind,
  rateCardCurrencies,
  withPictures,
} from './lib/pictures.ts';
import { publishPictures } from './lib/publish.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const mode = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const pr = env.PR_NUMBER ?? '';
const headRef = env.HEAD_REF ?? '';
const pull = pullKind(headRef);
const before = env.BEFORE_REF ?? 'origin/main';
const checkRows: readonly PictureRow[] = [{ label: 'The new check', before: 'test-before.png', after: 'test-after.png' }];

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/**
 * What the pull request's tests are compared with. A check pull request
 * opened against main also carries the fix's tests, so while the fix branch
 * exists its check is what it adds on top of the fix.
 */
function testsBase(): string {
  const fixBranch = pull?.kind === 'check' ? `origin/fix/${pull.slug}` : undefined;
  if (fixBranch && spawnSync('git', ['rev-parse', '--verify', '--quiet', fixBranch], { cwd: root }).status === 0) return fixBranch;
  return `origin/${env.BASE_REF ?? 'main'}`;
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();
}

const summary: string[] = [];
function say(line: string): void {
  console.log(line);
  summary.push(line);
}

function finish(): never {
  const path = env.GITHUB_STEP_SUMMARY;
  if (path && summary.length) appendFileSync(path, `## Evidence pictures\n\n${summary.join('\n\n')}\n`);
  process.exit(0);
}

function repoName(): string {
  return env.GITHUB_REPOSITORY ?? repoFromRemote(git(['remote', 'get-url', 'origin'])) ?? '';
}

function readBody(repo: string): string {
  if (env.PR_BODY_FILE) return readFileSync(env.PR_BODY_FILE, 'utf8');
  return gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.body // ""']);
}

function why(repo: string): { needed: boolean; reason: string } {
  if (!pull) return { needed: false, reason: `${headRef || 'this branch'} is not a fix/ or check/ branch` };
  if (hasPictures(readBody(repo), repo)) return { needed: false, reason: 'the body already shows pictures' };
  return {
    needed: true,
    reason: pull.kind === 'fix' ? 'the run left no pictures' : 'a check pull request shows its new check before and after the fix',
  };
}

/** Runs a picture script; the picture's presence afterwards is what counts. */
function picture(script: string, args: string[], cwd: string, extra: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, ...extra },
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output) console.log(output);
  if (result.error) console.log(`${script}: ${result.error.message}`);
}

/** main's code with this pull request's test files on top, in a temporary worktree. */
function onBeforeCode(tests: readonly string[], work: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pictures-before-'));
  git(['worktree', 'add', '--detach', '--quiet', dir, before]);
  try {
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    for (const file of tests) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), git(['show', `HEAD:${file}`]));
    }
    work(dir);
  } finally {
    git(['worktree', 'remove', '--force', dir]);
  }
}

function make(): void {
  const repo = repoName();
  const need = why(repo);
  if (!need.needed || !pull) {
    say(`No pictures needed: ${need.reason}.`);
    return;
  }
  const tests = changedTests(git(['diff', '--name-only', '--diff-filter=AM', `${testsBase()}...HEAD`]));
  const test = tests[0];
  if (!test) {
    say('No pictures: this pull request adds or changes no test.');
    return;
  }
  const body = readBody(repo);
  const booking = pull.kind === 'fix' ? bookingFromBody(body) : undefined;
  const rateCard = JSON.parse(readFileSync(join(root, 'config/rates.json'), 'utf8')) as Parameters<typeof rateCardCurrencies>[0];
  const currencies = (currenciesFromBody(body) ?? rateCardCurrencies(rateCard)).join(',');
  const out = mkdtempSync(join(tmpdir(), 'pictures-'));
  const testPicture = join(root, 'scripts/test-picture.ts');

  onBeforeCode(tests, (dir) => {
    picture(testPicture, [test, join(out, 'test-before.png')], dir);
    const screenshot = join(dir, 'scripts/screenshot.ts');
    if (booking && existsSync(screenshot)) {
      picture(screenshot, [booking, join(out, 'invoice-before.png')], dir, { BILLING_CURRENCIES: currencies });
    }
  });
  picture(testPicture, [test, join(out, 'test-after.png')], root);
  if (booking) picture(join(root, 'scripts/screenshot.ts'), [booking, join(out, 'invoice-after.png')], root, { BILLING_CURRENCIES: currencies });

  const rows = pull.kind === 'fix' ? pictureRows : checkRows;
  const present = rows.flatMap((row) => [row.before, row.after]).filter((name) => existsSync(join(out, name)));
  if (present.length === 0) {
    say('No pictures: making them failed (see the log).');
    return;
  }
  const branch = evidenceBranch(pull.kind, pull.slug);
  if (dryRun) {
    say(`Dry run: ${present.join(', ')} in ${out}; would push them to ${branch} and add:\n\n${notes[pull.kind]}\n\n${evidenceTable(repo, 'DRY-RUN', new Set(present), rows)}`);
    return;
  }
  const commit = publishPictures(out, present, branch, `Pictures for ${headRef}, made by CI`);
  const latest = readBody(repo);
  if (hasPictures(latest, repo)) {
    say('The body gained pictures while these were made, so it is left as it is.');
    return;
  }
  const request = join(out, 'body.json');
  writeFileSync(request, JSON.stringify({ body: withPictures(latest, `${notes[pull.kind]}\n\n${evidenceTable(repo, commit, new Set(present), rows)}`) }));
  gh(['api', '--method', 'PATCH', `repos/${repo}/pulls/${pr}`, '--input', request, '--jq', '.number']);
  say(`Added ${present.length} pictures to #${pr} (${branch}, ${commit.slice(0, 7)}): ${present.join(', ')}.`);
}

try {
  if (mode === 'need') {
    const { needed, reason } = why(repoName());
    console.log(`needed=${needed} (${reason})`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `needed=${needed}\n`);
    if (!needed) say(`No pictures needed: ${reason}.`);
  } else if (mode === 'make') {
    make();
  } else {
    console.error('usage: node scripts/ci-pictures.ts need | make [--dry-run]');
    process.exit(2);
  }
} catch (error) {
  say(`No pictures: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}
finish();
