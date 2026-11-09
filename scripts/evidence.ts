// Publishes the before and after screenshots for a pull request body:
//   node scripts/evidence.ts <slug> <before.png> <after.png>
// Pushes the two pictures to the branch evidence/<slug> (a commit with only
// those two files, so the fix branch's diff stays clean) and prints a Markdown
// table to paste into the pull request body.
import { execFileSync } from 'node:child_process';
import { evidenceTable, repoFromRemote, validSlug } from './lib/evidence.ts';

function git(args: string[], input?: string): string {
  return execFileSync('git', args, { input, encoding: 'utf8' }).trim();
}

const [slug = '', before = '', after = ''] = process.argv.slice(2);
if (!validSlug(slug) || !before || !after) {
  console.error('usage: node scripts/evidence.ts <slug> <before.png> <after.png>');
  process.exit(2);
}
const repo = process.env.EVIDENCE_REPO ?? repoFromRemote(git(['remote', 'get-url', 'origin']));
if (!repo) {
  console.error('cannot tell the GitHub repo from origin; set EVIDENCE_REPO=owner/name');
  process.exit(2);
}

const tree = git(
  ['mktree'],
  `100644 blob ${git(['hash-object', '-w', before])}\tbefore.png\n100644 blob ${git(['hash-object', '-w', after])}\tafter.png\n`,
);
const commit = git(['commit-tree', tree, '-m', `Screenshots for ${slug}`]);
git(['push', '--force', 'origin', `${commit}:refs/heads/evidence/${slug}`]);
console.log(evidenceTable(repo, commit));
