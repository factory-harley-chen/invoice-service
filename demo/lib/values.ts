import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { valuesFile } from './paths.ts';

export type Mode = 'live' | 'rehearsal';

export const valueKeys = [
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_LIVE',
  'SLACK_CHANNEL_REHEARSAL',
  'SLACK_WORKSPACE_URL',
  'GITHUB_REPO',
  'OWNER_LOGIN',
  'BOT_LOGIN',
  'RUN_IDENTITY',
  'STAGING_PORT',
  'LOOP_PORT',
  'DEMO_MODE',
  'RESET_DEPLOY_KEY',
] as const;

export type ValueKey = (typeof valueKeys)[number];

export type Values = {
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_LIVE: string;
  SLACK_CHANNEL_REHEARSAL: string;
  SLACK_WORKSPACE_URL: string;
  GITHUB_REPO: string;
  OWNER_LOGIN: string;
  BOT_LOGIN: string;
  RUN_IDENTITY: string;
  STAGING_PORT: number;
  LOOP_PORT: number;
  DEMO_MODE: Mode;
  RESET_DEPLOY_KEY: string;
};

export const defaults: Record<ValueKey, string> = {
  SLACK_BOT_TOKEN: '',
  SLACK_CHANNEL_LIVE: '',
  SLACK_CHANNEL_REHEARSAL: '',
  SLACK_WORKSPACE_URL: 'https://factory-gtm.slack.com',
  GITHUB_REPO: 'factory-harley-chen/invoice-service',
  OWNER_LOGIN: 'factory-harley-chen',
  BOT_LOGIN: 'factory-droid[bot]',
  RUN_IDENTITY: '',
  STAGING_PORT: '4100',
  LOOP_PORT: '4200',
  DEMO_MODE: 'rehearsal',
  RESET_DEPLOY_KEY: '~/.ssh/invoice-service-reset',
};

/** Parses KEY=VALUE lines. Comments and blank lines are skipped; matching quotes are removed. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = '', rawValue = ''] = match;
    let value = rawValue.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2] ?? '';
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

export type LoadedValues = {
  values: Values;
  file: string;
  fileFound: boolean;
  /** Keys present in the values file (with or without a value). */
  fileKeys: string[];
  /** Keys with no value from the file, the environment or a default. */
  missing: ValueKey[];
};

function expandHome(path: string): string {
  return path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path;
}

/** Values come from defaults, then demo/.env, then the process environment. */
export function loadValues(env: NodeJS.ProcessEnv = process.env, file = valuesFile()): LoadedValues {
  const fileFound = existsSync(file);
  const fromFile = fileFound ? parseEnvText(readFileSync(file, 'utf8')) : {};
  const merged = {} as Record<ValueKey, string>;
  const missing: ValueKey[] = [];
  for (const key of valueKeys) {
    const fromEnv = env[key]?.trim();
    const value = fromEnv || fromFile[key]?.trim() || defaults[key];
    merged[key] = value;
    if (!value) missing.push(key);
  }
  const mode = merged.DEMO_MODE === 'live' ? 'live' : 'rehearsal';
  return {
    values: {
      ...merged,
      STAGING_PORT: Number(merged.STAGING_PORT),
      LOOP_PORT: Number(merged.LOOP_PORT),
      DEMO_MODE: mode,
      RESET_DEPLOY_KEY: expandHome(merged.RESET_DEPLOY_KEY),
    },
    file,
    fileFound,
    fileKeys: Object.keys(fromFile),
    missing,
  };
}

export function parseMode(value: string | undefined, fallback: Mode): Mode {
  if (value === undefined) return fallback;
  if (value === 'live' || value === 'rehearsal') return value;
  throw new Error(`Unknown mode "${value}": use live or rehearsal`);
}

export function channelFor(values: Values, mode: Mode): string {
  return mode === 'live' ? values.SLACK_CHANNEL_LIVE : values.SLACK_CHANNEL_REHEARSAL;
}

/** "factory-gtm" from https://factory-gtm.slack.com */
export function workspaceName(values: Values): string {
  try {
    return new URL(values.SLACK_WORKSPACE_URL).hostname.split('.')[0] ?? values.SLACK_WORKSPACE_URL;
  } catch {
    return values.SLACK_WORKSPACE_URL;
  }
}

export function stagingUrl(values: Values): string {
  return `http://localhost:${values.STAGING_PORT}`;
}

export function loopUrl(values: Values): string {
  return `http://localhost:${values.LOOP_PORT}`;
}
