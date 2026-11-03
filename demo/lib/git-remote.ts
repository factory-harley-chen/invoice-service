import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from './paths.ts';
import { run, type RunResult } from './proc.ts';

// The deploy watcher and staging read GitHub over the git protocol rather than
// `gh api`: git reads of a public repo do not count against the signed-in
// user's REST limit (5000 an hour), which other tools on the laptop share.

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

export const githubHttpsUrl = (repo: string): string => `https://github.com/${repo}.git`;

/** The sha `git ls-remote` prints for exactly `ref`, or undefined when it is not listed. */
export function parseLsRemote(output: string, ref: string): string | undefined {
  for (const line of output.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return undefined;
}

/** One plain line that says what went wrong with a git call to GitHub. */
export function describeGitError(text: string, result?: RunResult): string {
  if (result?.code === 127) return 'git is not installed';
  if (result?.timedOut) return 'git timed out (no network?)';
  if (/could not resolve host|couldn't connect|failed to connect|connection refused|network is unreachable|timed out/i.test(text)) {
    return 'no network: GitHub could not be reached';
  }
  if (/terminal prompts disabled|could not read username|authentication failed/i.test(text)) {
    return 'GitHub wants a sign-in: the repo does not exist, or it is private and git has no credentials (gh auth setup-git)';
  }
  if (/repository .*not found|not found/i.test(text)) return 'not found on GitHub (no remote yet, or no access)';
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? 'git failed';
}

export type RemoteSha = { ok: true; sha: string } | { ok: false; missing: boolean; error: string };

/** The sha of a branch on a remote, read with `git ls-remote`. `missing` means the remote answered but has no such branch. */
export async function remoteBranchSha(url: string, branch: string, timeoutMs = 15_000): Promise<RemoteSha> {
  const ref = `refs/heads/${branch}`;
  const result = await run('git', ['ls-remote', url, ref], { env: gitEnv(), timeoutMs });
  if (result.code !== 0) return { ok: false, missing: false, error: describeGitError(`${result.stderr}\n${result.stdout}`, result) };
  const sha = parseLsRemote(result.stdout, ref);
  return sha ? { ok: true, sha } : { ok: false, missing: true, error: `${url} has no ${branch} branch` };
}

/**
 * Fetches one commit into a bare cache repo (by default under demo/state), so
 * the working copy's refs and objects are left alone. The commit can then be
 * read with `git --git-dir <gitDir> ...`.
 */
export async function fetchCommit(
  url: string,
  sha: string,
  gitDir = statePath('remote-cache.git'),
  timeoutMs = 60_000,
): Promise<{ ok: true; gitDir: string } | { ok: false; error: string }> {
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true });
    const init = await run('git', ['init', '--bare', '--quiet', gitDir]);
    if (init.code !== 0) return { ok: false, error: `git init ${gitDir} failed: ${init.stderr.trim()}` };
  }
  const fetched = await run('git', ['--git-dir', gitDir, 'fetch', '--quiet', '--no-tags', url, sha], { env: gitEnv(), timeoutMs });
  if (fetched.code !== 0) return { ok: false, error: describeGitError(`${fetched.stderr}\n${fetched.stdout}`, fetched) };
  return { ok: true, gitDir };
}

/**
 * ssh options that offer GitHub the reset deploy key and nothing else.
 * `-F /dev/null` and `IdentityAgent=none` keep ~/.ssh/config and the agent
 * out: with them, ssh can offer the user's own GitHub key first, and the push
 * then runs as the user, whom the ruleset does not let bypass.
 */
export function deployKeySshArgs(key: string): string[] {
  return ['-F', '/dev/null', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', key];
}

/** The same options as one GIT_SSH_COMMAND, which git runs through a shell. */
export function deployKeySshCommand(key: string): string {
  return `ssh ${deployKeySshArgs(key).map((arg) => `"${arg}"`).join(' ')}`;
}

/** Who GitHub's `ssh -T` greeting names: owner/name for a deploy key, a login for a user's key. */
export function sshGreetingName(output: string): string | undefined {
  return /Hi ([^\s!]+)! You've successfully authenticated/.exec(output)?.[1];
}
