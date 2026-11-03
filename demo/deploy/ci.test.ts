import { describe, expect, it } from 'vitest';
import { ciJobName, decideDeploy, type CheckRun } from './ci.ts';

const sha = 'a'.repeat(40);
const run = (id: number, status: string, conclusion: string | null, name = ciJobName): CheckRun => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/1/job/${id}`,
});

describe('decideDeploy', () => {
  it('does nothing when staging already runs main', () => {
    expect(decideDeploy(sha, sha, [])).toEqual({ kind: 'up-to-date' });
  });

  it('waits until CI has started and finished', () => {
    expect(decideDeploy(sha, 'old', []).kind).toBe('waiting');
    expect(decideDeploy(sha, 'old', [run(1, 'queued', null)]).kind).toBe('waiting');
    expect(decideDeploy(sha, 'old', [run(1, 'in_progress', null)]).kind).toBe('waiting');
  });

  it('deploys only after the CI job succeeded on that commit', () => {
    expect(decideDeploy(sha, 'old', [run(7, 'completed', 'success')])).toEqual({
      kind: 'deploy',
      ciRunUrl: 'https://github.com/o/r/actions/runs/1/job/7',
    });
  });

  it('never deploys a failed or cancelled commit', () => {
    expect(decideDeploy(sha, 'old', [run(1, 'completed', 'failure')]).kind).toBe('blocked');
    expect(decideDeploy(sha, 'old', [run(1, 'completed', 'cancelled')]).kind).toBe('blocked');
  });

  it('judges by the latest attempt and ignores other jobs', () => {
    expect(decideDeploy(sha, 'old', [run(1, 'completed', 'failure'), run(2, 'completed', 'success')]).kind).toBe('deploy');
    expect(decideDeploy(sha, 'old', [run(2, 'completed', 'success'), run(3, 'in_progress', null)]).kind).toBe('waiting');
    expect(decideDeploy(sha, 'old', [run(1, 'completed', 'success', 'Droid Auto Review')]).kind).toBe('waiting');
  });

  it('deploys main over a working-tree staging once CI passed', () => {
    expect(decideDeploy(sha, 'working-tree', [run(1, 'completed', 'success')]).kind).toBe('deploy');
  });
});
