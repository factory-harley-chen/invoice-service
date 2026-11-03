import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ghApiToFile } from './gh.ts';
import { readJsonFile, writeJsonFile } from './json.ts';
import { files, repoRoot, statePath } from './paths.ts';
import { isOurs, listenerPids, run, startNode, stopPid, waitFor } from './proc.ts';
import { recordStagingPid } from './session.ts';

export const baselineCurrencies: readonly string[] = ['EUR', 'GBP', 'USD'];
export const breakCurrency = 'JPY';
export const baselineTag = 'demo-baseline';

export type StagingSource =
  | { kind: 'worktree' }
  | { kind: 'tag'; sha: string }
  | { kind: 'github'; sha: string; repo: string };

export type StagingState = {
  sha: string;
  source: StagingSource['kind'];
  currencies: string[];
  port: number;
  pid: number | null;
  updatedAt: string;
};

export const stagingServerPath = (): string => join(files.stagingDir(), 'src', 'server.ts');

export function readStaging(): StagingState | undefined {
  return readJsonFile<StagingState>(files.staging());
}

function writeStaging(state: StagingState): void {
  writeJsonFile(files.staging(), state);
}

export function sourceSha(source: StagingSource): string {
  return source.kind === 'worktree' ? 'working-tree' : source.sha;
}

export function describeSource(source: StagingSource): string {
  if (source.kind === 'worktree') return 'the working tree (no demo-baseline tag yet)';
  if (source.kind === 'tag') return `${baselineTag} (${source.sha.slice(0, 7)})`;
  return `${source.repo}@${source.sha.slice(0, 7)}`;
}

/** The baseline is the demo-baseline tag when it exists locally, otherwise the working tree. */
export async function baselineSource(): Promise<StagingSource> {
  const result = await run('git', ['rev-parse', '-q', '--verify', `refs/tags/${baselineTag}^{commit}`], { cwd: repoRoot });
  const sha = result.stdout.trim();
  return result.code === 0 && sha ? { kind: 'tag', sha } : { kind: 'worktree' };
}

async function prepare(source: StagingSource, dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (source.kind === 'worktree') {
    for (const part of ['src', 'config', 'package.json']) {
      cpSync(join(repoRoot, part), join(dir, part), { recursive: true });
    }
  } else if (source.kind === 'tag') {
    const tar = statePath('staging-next.tar');
    const archived = await run('git', ['archive', '--format=tar', '-o', tar, source.sha, 'src', 'config', 'package.json'], { cwd: repoRoot });
    if (archived.code !== 0) throw new Error(`git archive ${source.sha} failed: ${archived.stderr.trim()}`);
    const extracted = await run('tar', ['-xf', tar, '-C', dir]);
    rmSync(tar, { force: true });
    if (extracted.code !== 0) throw new Error(`tar failed: ${extracted.stderr.trim()}`);
  } else {
    const tgz = statePath('staging-next.tgz');
    const downloaded = await ghApiToFile(`repos/${source.repo}/tarball/${source.sha}`, tgz);
    if (!downloaded.ok) throw new Error(`download of ${source.sha} failed: ${downloaded.error}`);
    const extracted = await run('tar', ['-xzf', tgz, '--strip-components=1', '-C', dir]);
    rmSync(tgz, { force: true });
    if (extracted.code !== 0) throw new Error(`tar failed: ${extracted.stderr.trim()}`);
  }
  if (!existsSync(join(dir, 'src', 'server.ts'))) {
    throw new Error(`${describeSource(source)} has no src/server.ts`);
  }
}

export async function stagingHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function stagingRunning(): Promise<StagingState | undefined> {
  const state = readStaging();
  if (!state?.pid) return undefined;
  return (await isOurs(state.pid, stagingServerPath())) ? state : undefined;
}

export async function stopStaging(): Promise<void> {
  const state = readStaging();
  if (state?.pid) {
    await stopPid(state.pid, stagingServerPath());
    writeStaging({ ...state, pid: null, updatedAt: new Date().toISOString() });
    recordStagingPid(null, stagingServerPath());
  }
}

async function start(port: number, currencies: string[]): Promise<number> {
  const busy = await listenerPids(port);
  if (busy.length > 0) {
    throw new Error(`port ${port} is in use by pid ${busy.join(', ')}; stop it or set STAGING_PORT`);
  }
  const pid = startNode(stagingServerPath(), [], {
    cwd: files.stagingDir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), BILLING_CURRENCIES: currencies.join(',') },
    logFile: join(files.logs(), 'staging.log'),
  });
  if (!(await waitFor(() => stagingHealthy(port), 10_000, 150))) {
    await stopPid(pid, stagingServerPath());
    throw new Error(`staging did not answer on port ${port}; see ${join(files.logs(), 'staging.log')}`);
  }
  return pid;
}

/**
 * Puts a version of the service on staging and (re)starts it. The new copy is
 * prepared before the old process stops, so staging is down for about a second.
 */
export async function deployStaging(source: StagingSource, currencies: string[], port: number): Promise<StagingState> {
  const next = statePath('staging-next');
  await prepare(source, next);
  await stopStaging();
  rmSync(files.stagingDir(), { recursive: true, force: true });
  renameSync(next, files.stagingDir());
  const pid = await start(port, currencies);
  const state: StagingState = {
    sha: sourceSha(source),
    source: source.kind,
    currencies,
    port,
    pid,
    updatedAt: new Date().toISOString(),
  };
  writeStaging(state);
  recordStagingPid(pid, stagingServerPath());
  return state;
}

/** Restarts the code already on staging with another BILLING_CURRENCIES. */
export async function restartStaging(currencies: string[], port: number): Promise<StagingState> {
  const state = readStaging();
  if (!state || !existsSync(stagingServerPath())) throw new Error('staging has not been set up; run ./demo.sh up');
  await stopStaging();
  const pid = await start(port, currencies);
  const next: StagingState = { ...state, currencies, port, pid, updatedAt: new Date().toISOString() };
  writeStaging(next);
  recordStagingPid(pid, stagingServerPath());
  return next;
}
