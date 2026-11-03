import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFromRemoteUrl, sameRepo } from './gh.ts';
import { channelFor, loadValues, parseEnvText, parseMode, workspaceName } from './values.ts';

describe('parseEnvText', () => {
  it('reads KEY=VALUE lines, skipping comments and stripping quotes', () => {
    expect(
      parseEnvText(['# comment', '', 'A=1', 'B = "two words"', "C='x'", 'D=plain # trailing', 'export E=e', 'not a line'].join('\n')),
    ).toEqual({ A: '1', B: 'two words', C: 'x', D: 'plain', E: 'e' });
  });
});

describe('loadValues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-values-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'SLACK_CHANNEL_LIVE=C0LIVE0001\nSLACK_CHANNEL_REHEARSAL=C0REHE0001\nSTAGING_PORT=4101\nDEMO_MODE=live\n');

  it('takes defaults, then the file, then the environment', () => {
    const { values, missing, fileFound } = loadValues({ LOOP_PORT: '4201' }, file);
    expect(fileFound).toBe(true);
    expect(values.STAGING_PORT).toBe(4101);
    expect(values.LOOP_PORT).toBe(4201);
    expect(values.DEMO_MODE).toBe('live');
    expect(values.GITHUB_REPO).toBe('factory-harley-chen/invoice-service');
    expect(missing).toEqual(['SLACK_BOT_TOKEN', 'RUN_IDENTITY']);
    expect(channelFor(values, 'live')).toBe('C0LIVE0001');
    expect(channelFor(values, 'rehearsal')).toBe('C0REHE0001');
    expect(workspaceName(values)).toBe('factory-gtm');
  });

  it('works without a values file', () => {
    expect(loadValues({}, join(dir, 'missing.env')).fileFound).toBe(false);
  });

  it('accepts only the two modes', () => {
    expect(parseMode(undefined, 'rehearsal')).toBe('rehearsal');
    expect(parseMode('live', 'rehearsal')).toBe('live');
    expect(() => parseMode('prod', 'rehearsal')).toThrow('Unknown mode');
  });
});

describe('repoFromRemoteUrl', () => {
  it('reads owner/name from https and ssh remotes', () => {
    expect(repoFromRemoteUrl('https://github.com/factory-harley-chen/invoice-service.git')).toBe('factory-harley-chen/invoice-service');
    expect(repoFromRemoteUrl('git@github.com:factory-harley-chen/invoice-service.git\n')).toBe('factory-harley-chen/invoice-service');
    expect(repoFromRemoteUrl('ssh://git@github.com/factory-harley-chen/invoice-service')).toBe('factory-harley-chen/invoice-service');
  });

  it('refuses anything that is not a GitHub repo', () => {
    expect(repoFromRemoteUrl('https://gitlab.com/a/b.git')).toBeUndefined();
    expect(repoFromRemoteUrl('https://github.com/a/b/c')).toBeUndefined();
  });

  it('compares repo names without case', () => {
    expect(sameRepo('Factory-Harley-Chen/Invoice-Service', 'factory-harley-chen/invoice-service')).toBe(true);
    expect(sameRepo('factory-harley-chen/invoice-service-2', 'factory-harley-chen/invoice-service')).toBe(false);
  });
});
