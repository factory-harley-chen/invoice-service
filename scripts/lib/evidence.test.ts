import { describe, expect, it } from 'vitest';
import { evidenceTable, repoFromRemote, validSlug } from './evidence.ts';

describe('repoFromRemote', () => {
  it('reads https and ssh remotes', () => {
    expect(repoFromRemote('https://github.com/acme/invoice-service.git')).toBe('acme/invoice-service');
    expect(repoFromRemote('https://github.com/acme/invoice-service\n')).toBe('acme/invoice-service');
    expect(repoFromRemote('git@github.com:acme/invoice-service.git')).toBe('acme/invoice-service');
    expect(repoFromRemote('https://x-access-token:abc@github.com/acme/invoice-service')).toBe('acme/invoice-service');
  });

  it('returns undefined for other hosts', () => {
    expect(repoFromRemote('https://gitlab.com/acme/invoice-service.git')).toBeUndefined();
  });
});

describe('validSlug', () => {
  it('accepts a branch slug and rejects anything else', () => {
    expect(validSlug('jpy-invoice-amounts')).toBe(true);
    expect(validSlug('')).toBe(false);
    expect(validSlug('../main')).toBe(false);
    expect(validSlug('fix/jpy')).toBe(false);
  });
});

describe('evidenceTable', () => {
  it('links both pictures at one commit', () => {
    expect(evidenceTable('acme/invoice-service', 'abc123')).toBe(
      [
        '| Before | After |',
        '| --- | --- |',
        '| ![Invoice before the fix](https://raw.githubusercontent.com/acme/invoice-service/abc123/before.png) | ![Invoice after the fix](https://raw.githubusercontent.com/acme/invoice-service/abc123/after.png) |',
      ].join('\n'),
    );
  });
});
