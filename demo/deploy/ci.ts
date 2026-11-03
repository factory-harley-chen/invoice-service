export const ciJobName = 'Lint, typecheck and test';

export type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

export type DeployDecision =
  | { kind: 'up-to-date' }
  | { kind: 'waiting'; reason: string }
  | { kind: 'deploy'; ciRunUrl: string }
  | { kind: 'blocked'; reason: string };

/**
 * Deploy main only when the latest CI job on that exact commit has finished
 * and succeeded. A running, queued, failed or cancelled job never deploys.
 */
export function decideDeploy(mainSha: string, deployedSha: string | undefined, runs: CheckRun[], jobName = ciJobName): DeployDecision {
  if (mainSha === deployedSha) return { kind: 'up-to-date' };
  const latest = runs.filter((run) => run.name === jobName).sort((a, b) => b.id - a.id)[0];
  if (!latest) return { kind: 'waiting', reason: `CI ("${jobName}") has not started on ${mainSha.slice(0, 7)}` };
  if (latest.status !== 'completed') return { kind: 'waiting', reason: `CI is ${latest.status} on ${mainSha.slice(0, 7)}` };
  if (latest.conclusion === 'success') return { kind: 'deploy', ciRunUrl: latest.html_url };
  return { kind: 'blocked', reason: `CI ended "${latest.conclusion ?? 'unknown'}" on ${mainSha.slice(0, 7)}; not deploying it` };
}
