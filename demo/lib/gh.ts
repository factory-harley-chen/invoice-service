import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { run, type RunResult } from './proc.ts';

const ghEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });

export function gh(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return run('gh', args, { env: ghEnv(), timeoutMs });
}

export type GhJson<T> = { ok: true; value: T } | { ok: false; error: string; notFound: boolean };

export async function ghJson<T>(args: string[], timeoutMs?: number): Promise<GhJson<T>> {
  const result = await gh(args, timeoutMs);
  if (result.code !== 0) {
    const text = `${result.stderr}\n${result.stdout}`;
    return { ok: false, error: describeGhError(text, result), notFound: /HTTP 404|Not Found|Could not resolve to a Repository/i.test(text) };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as T };
  } catch {
    return { ok: false, error: `gh returned output that is not JSON: ${result.stdout.slice(0, 120)}`, notFound: false };
  }
}

/** One plain line that says what went wrong, for the doctor and the logs. */
export function describeGhError(text: string, result?: RunResult): string {
  if (result?.code === 127) return 'gh is not installed (brew install gh)';
  if (result?.timedOut) return 'gh timed out (no network?)';
  if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(text)) {
    return 'gh is not signed in (gh auth login)';
  }
  if (/could not resolve host|dial tcp|connection refused|network is unreachable|no such host|timeout/i.test(text)) {
    return 'no network: GitHub could not be reached';
  }
  if (/Could not resolve to a Repository|HTTP 404|Not Found/i.test(text)) {
    return 'not found on GitHub (no remote yet, or no access)';
  }
  if (/HTTP 403/i.test(text)) return `GitHub refused the request (HTTP 403): ${firstLine(text)}`;
  return firstLine(text) || 'gh failed';
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

/** Streams `gh api <path>` (for example a tarball) into a file. */
export function ghApiToFile(path: string, file: string, timeoutMs = 60_000): Promise<{ ok: boolean; error: string }> {
  mkdirSync(dirname(file), { recursive: true });
  return new Promise((resolve) => {
    const out = createWriteStream(file);
    const child = spawn('gh', ['api', path], { env: ghEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.pipe(out);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => resolve({ ok: code === 0, error: code === 0 ? '' : describeGhError(stderr) }));
    });
  });
}

/** owner/name from a GitHub remote URL, or undefined when it is not a GitHub URL. */
export function repoFromRemoteUrl(url: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match?.[1];
}

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
