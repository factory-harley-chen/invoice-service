// Publishes the before and after pictures for a pull request body:
//   node scripts/evidence.ts <slug> [folder, default /tmp/evidence]
// Pushes the pictures found in the folder (test-before.png, test-after.png,
// invoice-before.png, invoice-after.png) to the branch evidence/<slug>, in a
// commit with only those files so the fix branch's diff stays clean, and
// prints a Markdown table to paste into the pull request body.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceTable, pictureNames, repoFromRemote, validSlug } from './lib/evidence.ts';
import { publishPictures } from './lib/publish.ts';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const [slug = '', folder = '/tmp/evidence'] = process.argv.slice(2);
if (!validSlug(slug)) {
  console.error('usage: node scripts/evidence.ts <slug> [folder, default /tmp/evidence]');
  process.exit(2);
}
const repo = process.env.EVIDENCE_REPO ?? repoFromRemote(git(['remote', 'get-url', 'origin']));
if (!repo) {
  console.error('cannot tell the GitHub repo from origin; set EVIDENCE_REPO=owner/name');
  process.exit(2);
}
const present = pictureNames.filter((name) => existsSync(join(folder, name)));
if (present.length === 0) {
  console.error(`no pictures in ${folder} (looked for ${pictureNames.join(', ')})`);
  process.exit(1);
}

const commit = publishPictures(folder, present, `evidence/${slug}`, `Pictures for ${slug}`);
console.log(evidenceTable(repo, commit, new Set(present)));
