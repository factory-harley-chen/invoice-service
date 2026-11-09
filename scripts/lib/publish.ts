import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function git(args: string[], input?: string): string {
  return execFileSync('git', args, { input, encoding: 'utf8' }).trim();
}

/**
 * Pushes the named files in a folder to a branch on origin, in a commit with
 * only those files (no parent), so no code branch's diff carries them.
 * Returns the commit.
 */
export function publishPictures(folder: string, names: readonly string[], branch: string, message: string): string {
  const tree = git(['mktree'], names.map((name) => `100644 blob ${git(['hash-object', '-w', join(folder, name)])}\t${name}\n`).join(''));
  const commit = git(['commit-tree', tree, '-m', message]);
  git(['push', '--force', 'origin', `${commit}:refs/heads/${branch}`]);
  return commit;
}
