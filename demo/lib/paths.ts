import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** DEMO_STATE_DIR lets tests and side-by-side runs keep their state apart. */
export function stateDir(): string {
  const override = process.env.DEMO_STATE_DIR?.trim();
  return override ? resolve(override) : join(repoRoot, 'demo', 'state');
}

export function statePath(...parts: string[]): string {
  return join(stateDir(), ...parts);
}

export function valuesFile(): string {
  const override = process.env.DEMO_ENV_FILE?.trim();
  return override ? resolve(override) : join(repoRoot, 'demo', '.env');
}

export const files = {
  events: () => statePath('events.jsonl'),
  timeline: () => statePath('timeline.jsonl'),
  pids: () => statePath('pids.json'),
  staging: () => statePath('staging.json'),
  stagingDir: () => statePath('staging'),
  monitor: () => statePath('monitor.json'),
  deploy: () => statePath('deploy.json'),
  logs: () => statePath('logs'),
  runs: () => statePath('runs'),
};
