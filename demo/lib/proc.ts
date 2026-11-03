import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Runs a command without a shell and collects its output. Never throws. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        let code: number | null = 0;
        if (err) {
          code = typeof err.code === 'number' ? err.code : null;
          if (err.code === 'ENOENT') {
            resolve({ code: 127, stdout: '', stderr: `${command}: command not found`, timedOut: false });
            return;
          }
        }
        resolve({ code, stdout, stderr, timedOut: Boolean(err?.killed) });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function commandOf(pid: number): Promise<string | undefined> {
  const result = await run('ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5000 });
  const command = result.stdout.trim();
  return result.code === 0 && command ? command : undefined;
}

/** True when the pid is alive and its command line contains the marker (usually a script path). */
export async function isOurs(pid: number, marker: string): Promise<boolean> {
  if (!isAlive(pid)) return false;
  const command = await commandOf(pid);
  return command !== undefined && command.includes(marker);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export type StopResult = 'stopped' | 'not-running' | 'not-ours';

/** Stops a pid only if its command line still contains the marker, so a reused pid is never killed. */
export async function stopPid(pid: number, marker: string, timeoutMs = 4000): Promise<StopResult> {
  if (!isAlive(pid)) return 'not-running';
  if (!(await isOurs(pid, marker))) return 'not-ours';
  process.kill(pid, 'SIGTERM');
  if (await waitFor(() => !isAlive(pid), timeoutMs)) return 'stopped';
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await waitFor(() => !isAlive(pid), 2000);
  return 'stopped';
}

/** Starts `node <script> ...args` in the background, detached, with output appended to logFile. */
export function startNode(script: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): number {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const fd = openSync(options.logFile, 'a');
  try {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`could not start ${script}`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Pids listening on a TCP port on this machine (empty when free). */
export async function listenerPids(port: number): Promise<number[]> {
  const result = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 5000 });
  return result.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
