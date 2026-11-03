import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gh, ghJson, repoPattern } from '../lib/gh.ts';
import { repoRoot } from '../lib/paths.ts';
import { loadValues } from '../lib/values.ts';

const help = `Usage: node demo/cli/seed-issues.ts [--dry-run]

Creates the issues in demo/seed-issues.json on GITHUB_REPO, skipping any whose
title already exists (open or closed). Needs gh signed in as OWNER_LOGIN.`;

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
});
if (args.help) {
  console.log(help);
  process.exit(0);
}
const dryRun = args['dry-run'];
const repo = loadValues().values.GITHUB_REPO;
console.log(dryRun ? 'DRY RUN: nothing is posted or changed' : `GITHUB: creates issues on github.com/${repo}`);
if (!repoPattern.test(repo)) throw new Error(`GITHUB_REPO "${repo}" is not owner/name`);

const seeds = JSON.parse(readFileSync(join(repoRoot, 'demo', 'seed-issues.json'), 'utf8')) as Array<{ title: string; body: string }>;
const existing = await ghJson<Array<{ title: string }>>(['issue', 'list', '-R', repo, '--state', 'all', '--limit', '200', '--json', 'title']);
if (!existing.ok && !dryRun) {
  console.error(`cannot list issues on ${repo}: ${existing.error}`);
  process.exit(1);
}
const titles = existing.ok ? existing.value.map((issue) => issue.title) : [];
let failed = 0;
for (const seed of seeds) {
  if (titles.includes(seed.title)) {
    console.log(`exists   ${seed.title}`);
    continue;
  }
  if (dryRun) {
    console.log(`would create  ${seed.title}`);
    continue;
  }
  const created = await gh(['issue', 'create', '-R', repo, '--title', seed.title, '--body', seed.body]);
  if (created.code === 0) console.log(`created  ${seed.title}: ${created.stdout.trim()}`);
  else {
    failed += 1;
    console.error(`failed   ${seed.title}: ${created.stderr.trim()}`);
  }
}
process.exit(failed ? 1 : 0);
