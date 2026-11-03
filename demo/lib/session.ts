import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from './json.ts';
import { files, repoRoot } from './paths.ts';
import { isOurs, startNode, stopPid } from './proc.ts';
import type { Mode, Values } from './values.ts';

export type ProcessName = 'monitor' | 'deploy' | 'loop';

export type ProcessRecord = { pid: number; script: string; args: string[]; log: string; startedAt: string };

export type Session = {
  mode: Mode;
  channel: string;
  noPost: boolean;
  startedAt: string;
  processes: Partial<Record<ProcessName | 'staging', ProcessRecord>>;
};

export const scripts: Record<ProcessName, string> = {
  monitor: join(repoRoot, 'monitor', 'monitor.ts'),
  deploy: join(repoRoot, 'demo', 'deploy', 'watch.ts'),
  loop: join(repoRoot, 'demo', 'loop', 'server.ts'),
};

export const processNames: readonly ProcessName[] = ['monitor', 'deploy', 'loop'];

export function readSession(): Session | undefined {
  return readJsonFile<Session>(files.pids());
}

export function writeSession(session: Session): void {
  writeJsonFile(files.pids(), session);
}

export function clearSession(): void {
  rmSync(files.pids(), { force: true });
}

/** Keeps the staging pid in pids.json current; staging restarts on break and deploy. */
export function recordStagingPid(pid: number | null, script: string): void {
  const session = readSession();
  if (!session) return;
  if (pid === null) {
    delete session.processes.staging;
  } else {
    session.processes.staging = { pid, script, args: [], log: join(files.logs(), 'staging.log'), startedAt: new Date().toISOString() };
  }
  writeSession(session);
}

export async function runningProcesses(session: Session | undefined): Promise<ProcessName[]> {
  if (!session) return [];
  const alive: ProcessName[] = [];
  for (const name of processNames) {
    const record = session.processes[name];
    if (record && (await isOurs(record.pid, record.script))) alive.push(name);
  }
  return alive;
}

export function argsFor(name: ProcessName, mode: Mode, noPost: boolean, values: Values): string[] {
  if (name === 'monitor') return ['--mode', mode, ...(noPost ? ['--dry-run'] : [])];
  if (name === 'loop') return ['--port', String(values.LOOP_PORT)];
  return [];
}

export type StartOutcome = { name: ProcessName; pid?: number; skipped?: string };

export function startProcess(name: ProcessName, mode: Mode, noPost: boolean, values: Values): StartOutcome & { record?: ProcessRecord } {
  const script = scripts[name];
  if (!existsSync(script)) return { name, skipped: `${script} does not exist yet` };
  const args = argsFor(name, mode, noPost, values);
  const log = join(files.logs(), `${name}.log`);
  const pid = startNode(script, args, { cwd: repoRoot, env: process.env, logFile: log });
  return { name, pid, record: { pid, script, args, log, startedAt: new Date().toISOString() } };
}

export async function stopProcess(session: Session, name: ProcessName): Promise<string> {
  const record = session.processes[name];
  if (!record) return `${name}: not started`;
  const result = await stopPid(record.pid, record.script);
  delete session.processes[name];
  if (result === 'not-ours') return `${name}: pid ${record.pid} is now another program; left it alone`;
  return `${name}: ${result === 'stopped' ? `stopped pid ${record.pid}` : 'was not running'}`;
}
