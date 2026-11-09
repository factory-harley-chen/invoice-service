import { describe, expect, it } from 'vitest';
import { evidenceTable, pictureNames, repoFromRemote, validSlug } from './evidence.ts';

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
  const url = (name: string) => `https://raw.githubusercontent.com/acme/invoice-service/abc123/${name}`;

  it('shows the test and the invoice, before and after, from one commit', () => {
    expect(evidenceTable('acme/invoice-service', 'abc123', new Set(pictureNames))).toBe(
      [
        '| | Before the fix | After the fix |',
        '| --- | --- | --- |',
        `| The test | ![The test before the fix](${url('test-before.png')}) | ![The test after the fix](${url('test-after.png')}) |`,
        `| The invoice | ![The invoice before the fix](${url('invoice-before.png')}) | ![The invoice after the fix](${url('invoice-after.png')}) |`,
      ].join('\n'),
    );
  });

  it('leaves out a pair with no pictures and marks a missing one', () => {
    const table = evidenceTable('acme/invoice-service', 'abc123', new Set(['test-before.png', 'test-after.png', 'invoice-before.png']));
    expect(table).toContain(`| The invoice | ![The invoice before the fix](${url('invoice-before.png')}) | Not taken |`);
    expect(evidenceTable('acme/invoice-service', 'abc123', new Set(['test-after.png']))).not.toContain('The invoice');
  });

  it('is empty when there are no pictures', () => {
    expect(evidenceTable('acme/invoice-service', 'abc123', new Set())).toBe('');
  });
});
