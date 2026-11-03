import { describe, expect, it } from 'vitest';
import { deployKeySshCommand, describeGitError, githubHttpsUrl, parseLsRemote, sshGreetingName } from './git-remote.ts';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);

describe('parseLsRemote', () => {
  it('returns the sha of exactly the ref asked for', () => {
    const out = `${b}\trefs/heads/main-old\n${a}\trefs/heads/main\n`;
    expect(parseLsRemote(out, 'refs/heads/main')).toBe(a);
  });

  it('returns undefined when the ref is not listed or the line is not a sha', () => {
    expect(parseLsRemote('', 'refs/heads/main')).toBeUndefined();
    expect(parseLsRemote(`${a}\trefs/heads/other\n`, 'refs/heads/main')).toBeUndefined();
    expect(parseLsRemote('nope\trefs/heads/main\n', 'refs/heads/main')).toBeUndefined();
  });
});

describe('describeGitError', () => {
  it('names a missing git, a timeout and no network', () => {
    expect(describeGitError('', { code: 127, stdout: '', stderr: '', timedOut: false })).toBe('git is not installed');
    expect(describeGitError('', { code: null, stdout: '', stderr: '', timedOut: true })).toMatch(/timed out/);
    expect(describeGitError("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com")).toMatch(/no network/);
  });

  it('separates a sign-in prompt from a plain not found', () => {
    expect(describeGitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toMatch(/sign-in/);
    expect(describeGitError("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found")).toMatch(/^not found/);
  });

  it('falls back to the first line', () => {
    expect(describeGitError('\nfatal: something else\nmore')).toBe('fatal: something else');
  });
});

describe('githubHttpsUrl', () => {
  it('builds the https clone url', () => {
    expect(githubHttpsUrl('o/r')).toBe('https://github.com/o/r.git');
  });
});

describe('deploy key ssh', () => {
  it('ignores the ssh config and the agent, and quotes the key path', () => {
    const cmd = deployKeySshCommand('/Users/x/my keys/reset');
    expect(cmd).toContain('"-F" "/dev/null"');
    expect(cmd).toContain('"IdentityAgent=none"');
    expect(cmd).toContain('"-i" "/Users/x/my keys/reset"');
  });

  it('reads who GitHub signed in', () => {
    expect(sshGreetingName("Hi o/r! You've successfully authenticated, but GitHub does not provide shell access.")).toBe('o/r');
    expect(sshGreetingName("Hi someone! You've successfully authenticated, but GitHub does not provide shell access.")).toBe('someone');
    expect(sshGreetingName('git@github.com: Permission denied (publickey).')).toBeUndefined();
  });
});
