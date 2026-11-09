import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAll, type RateCard, type ServedInvoice } from '../../monitor/check.ts';
import type { MonitorState } from '../../monitor/state.ts';
import { slackApi, type SlackResult } from '../../monitor/slack.ts';
import { ciJobName } from '../deploy/ci.ts';
import { ghJson, gh, describeGhError, repoFromRemoteUrl, repoPattern, sameRepo } from '../lib/gh.ts';
import { deployKeySshArgs, sshGreetingName } from '../lib/git-remote.ts';
import { readJsonFile } from '../lib/json.ts';
import { files, repoRoot, valuesFile } from '../lib/paths.ts';
import { isOurs, listenerPids, run } from '../lib/proc.ts';
import { readSession, scripts, type ProcessName } from '../lib/session.ts';
import { baselineCurrencies, baselineSource, baselineTag, readStaging, sourceSha, stagingRunning } from '../lib/staging.ts';
import { loadValues, parseEnvText, valueKeys, type LoadedValues, type Values } from '../lib/values.ts';

export const phases = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'] as const;
export type Phase = (typeof phases)[number];

type Status = 'pass' | 'fail' | 'manual';
type Outcome = { status: Status; detail: string; fix?: string };
type Check = { phase: Phase; name: string; run: () => Promise<Outcome> };

const pass = (detail: string): Outcome => ({ status: 'pass', detail });
const fail = (detail: string, fix: string): Outcome => ({ status: 'fail', detail, fix });
const manual = (detail: string): Outcome => ({ status: 'manual', detail });

export const requiredScopes = ['chat:write', 'channels:read', 'channels:history', 'groups:read', 'groups:history'];
const seedFile = join(repoRoot, 'demo', 'seed-issues.json');

function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= fn());
}

type Rule = { type: string; ruleset_id?: number; parameters?: Record<string, unknown> };
type Ruleset = {
  id: number;
  name: string;
  enforcement: string;
  current_user_can_bypass?: string;
  bypass_actors?: Array<{ actor_type: string; actor_id: number | null; bypass_mode?: string }>;
};

function buildChecks(loaded: LoadedValues): Check[] {
  const v: Values = loaded.values;
  const R = v.GITHUB_REPO;
  const repoFix = 'see SETUP.md P3 (the repo is not on GitHub yet, or gh cannot see it)';

  const ghLogin = memo(() => ghJson<{ login: string }>(['api', 'user']));
  const repoInfo = memo(() =>
    ghJson<{
      visibility: string;
      allow_merge_commit: boolean;
      allow_squash_merge: boolean;
      allow_rebase_merge: boolean;
      delete_branch_on_merge: boolean;
    }>(['api', `repos/${R}`]),
  );
  const mainSha = memo(() => ghJson<{ sha: string }>(['api', `repos/${R}/commits/main`]));
  const remoteTagSha = memo(() => ghJson<{ sha: string }>(['api', `repos/${R}/commits/${baselineTag}`]));
  const localTag = memo(async () => {
    const source = await baselineSource();
    return source.kind === 'tag' ? source.sha : undefined;
  });
  const slackAuth = memo(() => slackApi('auth.test', v.SLACK_BOT_TOKEN, {}));
  const channelInfo = (id: string) => slackApi('conversations.info', v.SLACK_BOT_TOKEN, { channel: id });
  const session = readSession();

  const ghFail = (what: string, error: string, notFound: boolean): Outcome =>
    fail(`${what}: ${error}`, notFound ? repoFix : /signed in/.test(error) ? `gh auth login as ${v.OWNER_LOGIN}` : 'check the network, then run doctor again');

  const slackFail = (res: SlackResult, what: string): Outcome => {
    const error = res.body.error ?? 'unknown_error';
    if (error === 'no_token') return fail(`${what}: SLACK_BOT_TOKEN is empty`, 'paste the Invoice monitor bot token (xoxb-...) into demo/.env (SETUP.md P2)');
    if (error === 'invalid_auth' || error === 'token_revoked' || error === 'account_inactive')
      return fail(`${what}: Slack says ${error}`, 'copy a fresh Bot User OAuth Token from the Invoice monitor app into demo/.env');
    if (error === 'missing_scope')
      return fail(`${what}: Slack says missing_scope`, 'the channels are private, so the app needs groups:read (and groups:history): add them under OAuth & Permissions, reinstall, paste the new token');
    if (error === 'channel_not_found')
      return fail(`${what}: Slack says channel_not_found`, 'add the app (channel details, Integrations, Add an app, Invoice monitor); a private channel is invisible to it until then. Or the id is wrong');
    if (error === 'network_error' || error === 'timeout') return fail(`${what}: Slack could not be reached (${error})`, 'check the network, then run doctor again');
    return fail(`${what}: Slack says ${error}`, 'see SETUP.md P2');
  };

  const channelCheck = (label: string, id: string): (() => Promise<Outcome>) => async () => {
    if (!id) return fail(`${label} channel id is not set`, `set SLACK_CHANNEL_${label.toUpperCase()} in demo/.env`);
    const res = await channelInfo(id);
    if (!res.body.ok) return slackFail(res, `${label} channel ${id}`);
    const channel = res.body.channel as { name?: string; is_private?: boolean; is_member?: boolean } | undefined;
    const name = channel?.name ? `#${channel.name}` : id;
    const kind = channel?.is_private ? 'private' : 'public (the plan expects private)';
    if (channel?.is_member === false) return fail(`${name} (${kind}): the bot is not a member`, `in ${name}: channel details, Integrations, Add an app, Invoice monitor`);
    return pass(`${name} (${kind}), the Invoice monitor bot is a member`);
  };

  const processCheck = (name: ProcessName, label: string): (() => Promise<Outcome>) => async () => {
    const record = session?.processes[name];
    if (name === 'loop' && !existsSync(scripts.loop)) return fail(`${scripts.loop} does not exist yet`, 'the loop screen is not built yet (demo/loop/)');
    if (!record) return fail(`${label} is not running`, './demo.sh up');
    if (!(await isOurs(record.pid, record.script))) return fail(`${label} (pid ${record.pid}) has stopped`, `./demo.sh down && ./demo.sh up; its log is ${record.log}`);
    return pass(`${label} pid ${record.pid}${record.args.length ? ` (${record.args.join(' ')})` : ''}`);
  };

  const portCheck = (label: string, port: number): (() => Promise<Outcome>) => async () => {
    const pids = await listenerPids(port);
    if (pids.length === 0) return pass(`port ${port} is free`);
    const ours = Object.values(session?.processes ?? {}).map((p) => p?.pid);
    const staging = readStaging();
    if (staging?.pid) ours.push(staging.pid);
    const strangers = pids.filter((pid) => !ours.includes(pid));
    if (strangers.length === 0) return pass(`port ${port} is ours (pid ${pids.join(', ')})`);
    return fail(`port ${port} (${label}) is used by pid ${strangers.join(', ')}, not by ./demo.sh`, `stop that program, or set ${label} to another port in demo/.env`);
  };

  return [
    // P0 laptop
    {
      phase: 'P0',
      name: 'Node 22.18 or later',
      run: async () => {
        const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
        return major > 22 || (major === 22 && minor >= 18)
          ? pass(`v${process.versions.node}`)
          : fail(`v${process.versions.node}`, 'install Node 22.18 or later (nvm install 22)');
      },
    },
    {
      phase: 'P0',
      name: 'gh installed',
      run: async () => {
        const result = await gh(['--version'], 10_000);
        return result.code === 0 ? pass(result.stdout.split('\n')[0] ?? 'gh') : fail('gh is not installed', 'brew install gh');
      },
    },
    {
      phase: 'P0',
      name: 'Dependencies installed',
      run: async () => {
        const needed = ['vitest', 'eslint', 'typescript', 'typescript-eslint'];
        const missing = needed.filter((name) => !existsSync(join(repoRoot, 'node_modules', name, 'package.json')));
        return missing.length === 0 ? pass('node_modules has vitest, eslint and typescript') : fail(`missing ${missing.join(', ')}`, 'npm ci');
      },
    },
    {
      phase: 'P0',
      name: 'npm run check',
      run: async () => {
        const result = await run('npm', ['run', 'check'], { cwd: repoRoot, timeoutMs: 180_000 });
        const tests = /Tests\s+(\d+ passed[^\n]*)/.exec(result.stdout)?.[1]?.trim();
        return result.code === 0
          ? pass(`lint, typecheck and tests pass${tests ? ` (${tests})` : ''}`)
          : fail(`exit ${result.code ?? 'timeout'}`, 'run npm run check and fix what it reports');
      },
    },
    // P1 values
    {
      phase: 'P1',
      name: 'Values file',
      run: async () =>
        loaded.fileFound ? pass(valuesFile()) : fail(`${valuesFile()} does not exist`, 'cp values.example.env demo/.env, then fill it in'),
    },
    {
      phase: 'P1',
      name: 'Values file is ignored by git',
      run: async () => {
        if (!loaded.file.startsWith(`${repoRoot}/`)) return pass(`${loaded.file} is outside the repo`);
        const relative = loaded.file.slice(repoRoot.length + 1);
        const result = await run('git', ['check-ignore', '-q', relative], { cwd: repoRoot });
        return result.code === 0 ? pass(`git check-ignore ${relative}`) : fail(`git would track ${relative}`, 'add .env to .gitignore');
      },
    },
    {
      phase: 'P1',
      name: 'Every value set',
      run: async () => {
        const notInFile = valueKeys.filter((key) => !loaded.fileKeys.includes(key));
        if (loaded.missing.length > 0) {
          const waiting = loaded.missing.includes('RUN_IDENTITY') ? ' (RUN_IDENTITY: SETUP.md P5)' : '';
          return fail(`empty: ${loaded.missing.join(', ')}${waiting}`, 'fill these in demo/.env (see values.example.env)');
        }
        return pass(notInFile.length ? `all set; defaults used for ${notInFile.join(', ')}` : 'all set');
      },
    },
    {
      phase: 'P1',
      name: 'Values look right',
      run: async () => {
        const raw = loaded.fileFound ? parseEnvText(readFileSync(loaded.file, 'utf8')) : {};
        const problems: string[] = [];
        if (v.SLACK_BOT_TOKEN && !v.SLACK_BOT_TOKEN.startsWith('xoxb-')) problems.push('SLACK_BOT_TOKEN should start with xoxb-');
        for (const key of ['SLACK_CHANNEL_LIVE', 'SLACK_CHANNEL_REHEARSAL'] as const) {
          if (v[key] && !/^[CG][A-Z0-9]{8,}$/.test(v[key])) problems.push(`${key} should be a channel id such as C0123456789, not a name`);
        }
        if (v.SLACK_CHANNEL_LIVE && v.SLACK_CHANNEL_LIVE === v.SLACK_CHANNEL_REHEARSAL) problems.push('the live and rehearsal channels are the same');
        if (!repoPattern.test(R)) problems.push('GITHUB_REPO should be owner/name');
        for (const key of ['STAGING_PORT', 'LOOP_PORT'] as const) {
          if (!Number.isInteger(v[key]) || v[key] < 1024 || v[key] > 65535) problems.push(`${key} should be a port number`);
        }
        if (v.STAGING_PORT === v.LOOP_PORT) problems.push('STAGING_PORT and LOOP_PORT are the same');
        const mode = process.env.DEMO_MODE?.trim() || raw.DEMO_MODE;
        if (mode && mode !== 'live' && mode !== 'rehearsal') problems.push('DEMO_MODE should be live or rehearsal');
        return problems.length === 0 ? pass('token, channel ids, repo, ports and mode are well formed') : fail(problems.join('; '), 'correct demo/.env');
      },
    },
    // P2 Slack
    {
      phase: 'P2',
      name: 'Slack token valid',
      run: async () => {
        const res = await slackAuth();
        if (!res.body.ok) return slackFail(res, 'auth.test');
        const url = String(res.body.url ?? '').replace(/\/$/, '');
        const want = v.SLACK_WORKSPACE_URL.replace(/\/$/, '');
        if (url !== want) return fail(`token is for ${url}, not ${want}`, 'use the token of the Invoice monitor app installed in the factory-gtm workspace');
        return pass(`bot ${String(res.body.user ?? '?')} in ${url}`);
      },
    },
    {
      phase: 'P2',
      name: 'Slack app scopes',
      run: async () => {
        const res = await slackAuth();
        if (!res.body.ok) return slackFail(res, 'auth.test');
        if (!res.scopes) return fail('Slack did not report the scopes', 'run doctor again');
        const missing = requiredScopes.filter((scope) => !res.scopes?.includes(scope));
        return missing.length === 0
          ? pass(requiredScopes.join(', '))
          : fail(`missing ${missing.join(', ')}`, 'add them under OAuth & Permissions in the Invoice monitor app, Reinstall to Workspace, paste the new token into demo/.env');
      },
    },
    { phase: 'P2', name: 'Bot in the live channel', run: channelCheck('live', v.SLACK_CHANNEL_LIVE) },
    { phase: 'P2', name: 'Bot in the rehearsal channel', run: channelCheck('rehearsal', v.SLACK_CHANNEL_REHEARSAL) },
    { phase: 'P2', name: '@Factory in both channels', run: async () => manual('confirm in Slack: each channel, Integrations tab, lists Factory') },
    // P3 GitHub
    {
      phase: 'P3',
      name: `gh signed in as ${v.OWNER_LOGIN}`,
      run: async () => {
        const res = await ghLogin();
        if (!res.ok) return ghFail('gh api user', res.error, false);
        return res.value.login === v.OWNER_LOGIN
          ? pass(res.value.login)
          : fail(`gh is signed in as ${res.value.login}`, `gh auth switch -u ${v.OWNER_LOGIN} (or gh auth login)`);
      },
    },
    {
      phase: 'P3',
      name: `origin is ${R}`,
      run: async () => {
        const result = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
        if (result.code !== 0) return fail('no remote called origin yet', `git remote add origin https://github.com/${R}.git (SETUP.md P3)`);
        const repo = repoFromRemoteUrl(result.stdout);
        return repo && sameRepo(repo, R) ? pass(result.stdout.trim()) : fail(`origin is ${result.stdout.trim()}`, `git remote set-url origin https://github.com/${R}.git`);
      },
    },
    {
      phase: 'P3',
      name: 'Repo is public, merge commits only, head branches auto-deleted',
      run: async () => {
        const res = await repoInfo();
        if (!res.ok) return ghFail(`github.com/${R}`, res.error, res.notFound);
        const r = res.value;
        const problems: string[] = [];
        if (r.visibility !== 'public') problems.push(`visibility is ${r.visibility}`);
        if (!r.allow_merge_commit) problems.push('merge commits are off');
        if (r.allow_squash_merge) problems.push('squash merging is on');
        if (r.allow_rebase_merge) problems.push('rebase merging is on');
        if (!r.delete_branch_on_merge) problems.push('head branches are not deleted automatically');
        return problems.length === 0
          ? pass('public; merge commits only; head branches deleted on merge')
          : fail(problems.join('; '), `gh repo edit ${R} --visibility public --accept-visibility-change-consequences --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false --delete-branch-on-merge`);
      },
    },
    {
      phase: 'P3',
      name: `Tag ${baselineTag} here and on GitHub`,
      run: async () => {
        const local = await localTag();
        if (!local) return fail(`no local tag ${baselineTag}`, `git tag ${baselineTag} <first commit> && git push origin ${baselineTag}`);
        const remote = await remoteTagSha();
        if (!remote.ok) return ghFail(`tag ${baselineTag} on GitHub`, remote.error, remote.notFound);
        return remote.value.sha === local
          ? pass(`${baselineTag} is ${local.slice(0, 7)} in both`)
          : fail(`local ${local.slice(0, 7)}, GitHub ${remote.value.sha.slice(0, 7)}`, `make them agree (git push origin ${baselineTag})`);
      },
    },
    {
      phase: 'P3',
      name: 'Branch protection on main, with no bypass',
      run: async () => {
        const rules = await ghJson<Rule[]>(['api', `repos/${R}/rules/branches/main`]);
        if (!rules.ok) return ghFail('rules on main', rules.error, rules.notFound);
        const problems: string[] = [];
        const pr = rules.value.find((rule) => rule.type === 'pull_request');
        if (!pr) problems.push('no pull request rule');
        else {
          if (Number(pr.parameters?.required_approving_review_count ?? 0) < 1) problems.push('fewer than 1 approval required');
          if (pr.parameters?.require_code_owner_review !== true) problems.push('code owner review not required');
        }
        const status = rules.value.find((rule) => rule.type === 'required_status_checks');
        const contexts = ((status?.parameters?.required_status_checks ?? []) as Array<{ context: string }>).map((c) => c.context);
        if (!contexts.includes(ciJobName)) problems.push(`the "${ciJobName}" check is not required`);
        if (!rules.value.some((rule) => rule.type === 'non_fast_forward')) problems.push('force pushes are not blocked');
        if (!rules.value.some((rule) => rule.type === 'deletion')) problems.push('deleting main is not blocked');
        const ids = [...new Set(rules.value.map((rule) => rule.ruleset_id).filter((id): id is number => typeof id === 'number'))];
        for (const id of ids) {
          const ruleset = await ghJson<Ruleset>(['api', `repos/${R}/rulesets/${id}`]);
          if (!ruleset.ok) {
            problems.push(`cannot read ruleset ${id}: ${ruleset.error}`);
            continue;
          }
          const { name, current_user_can_bypass: canBypass, bypass_actors: actors = [] } = ruleset.value;
          if (canBypass && canBypass !== 'never') problems.push(`you can bypass ruleset "${name}" (${canBypass}); remove yourself and admin roles from its bypass list`);
          const others = actors.filter((actor) => actor.actor_type !== 'DeployKey');
          if (others.length) problems.push(`ruleset "${name}" lets ${others.map((a) => a.actor_type).join(', ')} bypass it; keep only Deploy keys`);
        }
        const classic = await gh(['api', `repos/${R}/branches/main/protection`], 15_000);
        if (classic.code === 0) {
          const enforced = (() => {
            try {
              return (JSON.parse(classic.stdout) as { enforce_admins?: { enabled?: boolean } }).enforce_admins?.enabled === true;
            } catch {
              return false;
            }
          })();
          if (!enforced) problems.push('a classic branch protection rule lets admins bypass it; delete it (the ruleset replaces it)');
        }
        return problems.length === 0
          ? pass(`PR with 1 code owner approval, "${ciJobName}" required, no force push or deletion, nobody can bypass`)
          : fail(problems.join('; '), 'fix the ruleset as in SETUP.md P3 (Settings > Rules > Rulesets)');
      },
    },
    {
      phase: 'P3',
      name: 'CODEOWNERS',
      run: async () => {
        const file = join(repoRoot, '.github', 'CODEOWNERS');
        if (!existsSync(file) || !readFileSync(file, 'utf8').includes(`@${v.OWNER_LOGIN}`)) {
          return fail(`.github/CODEOWNERS does not name @${v.OWNER_LOGIN}`, `echo "* @${v.OWNER_LOGIN}" > .github/CODEOWNERS`);
        }
        const errors = await ghJson<{ errors: unknown[] }>(['api', `repos/${R}/codeowners/errors`]);
        if (!errors.ok) return ghFail('CODEOWNERS on GitHub', errors.error, errors.notFound);
        return errors.value.errors.length === 0 ? pass(`* @${v.OWNER_LOGIN}, and GitHub reads it without errors`) : fail(`GitHub reports ${errors.value.errors.length} CODEOWNERS errors`, `gh api repos/${R}/codeowners/errors`);
      },
    },
    {
      phase: 'P3',
      name: 'Reset deploy key',
      run: async () => {
        const key = v.RESET_DEPLOY_KEY;
        const fix = `ssh-keygen -t ed25519 -N "" -C invoice-service-reset -f ${key} && gh repo deploy-key add ${key}.pub -R ${R} --allow-write --title "demo reset"`;
        if (!existsSync(key) || !existsSync(`${key}.pub`)) return fail(`no key pair at ${key}`, fix);
        const pub = readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
        const keys = await ghJson<Array<{ key: string; read_only: boolean; title: string }>>(['api', `repos/${R}/keys`]);
        if (!keys.ok) return ghFail('deploy keys', keys.error, keys.notFound);
        const match = keys.value.find((entry) => entry.key.trim() === pub);
        if (!match) return fail(`${key}.pub is not a deploy key on ${R}`, `gh repo deploy-key add ${key}.pub -R ${R} --allow-write --title "demo reset"`);
        if (match.read_only) return fail(`deploy key "${match.title}" is read-only`, 'delete it and add it again with --allow-write');
        const hello = await run('ssh', [...deployKeySshArgs(key), '-T', 'git@github.com'], { timeoutMs: 15_000 });
        const signedInAs = sshGreetingName(`${hello.stderr}\n${hello.stdout}`);
        if (!signedInAs) {
          return fail(`ssh with ${key} did not sign in to GitHub: ${(hello.stderr || hello.stdout).trim().split('\n')[0] ?? ''}`, `ssh ${deployKeySshArgs(key).join(' ')} -T git@github.com`);
        }
        if (!sameRepo(signedInAs, R)) {
          return fail(`${key} signs in as ${signedInAs}, not as the deploy key of ${R}, so GitHub would refuse the reset push`, `ssh ${deployKeySshArgs(key).join(' ')} -T git@github.com should say "Hi ${R}!"`);
        }
        return pass(`deploy key "${match.title}" can write and signs in as ${R}; only this laptop holds it`);
      },
    },
    {
      phase: 'P3',
      name: 'Seeded issues',
      run: async () => {
        const seeds = readJsonFile<Array<{ title: string }>>(seedFile) ?? [];
        const issues = await ghJson<Array<{ title: string }>>(['issue', 'list', '-R', R, '--state', 'all', '--limit', '200', '--json', 'title']);
        if (!issues.ok) return ghFail('issues', issues.error, issues.notFound);
        const titles = issues.value.map((issue) => issue.title);
        const missing = seeds.filter((seed) => !titles.includes(seed.title)).map((seed) => seed.title);
        return missing.length === 0 ? pass(`${seeds.length} seeded issues present`) : fail(`missing: ${missing.join('; ')}`, 'node demo/cli/seed-issues.ts');
      },
    },
    // P4 Factory Demos
    {
      phase: 'P4',
      name: 'FACTORY_API_KEY secret',
      run: async () => {
        const secrets = await ghJson<Array<{ name: string }>>(['secret', 'list', '-R', R, '--json', 'name']);
        if (!secrets.ok) return ghFail('repo secrets', secrets.error, secrets.notFound);
        return secrets.value.some((s) => s.name === 'FACTORY_API_KEY')
          ? pass('set (the value is never read)')
          : fail('not set', `gh secret set FACTORY_API_KEY -R ${R} (paste the Factory Demos API key when asked)`);
      },
    },
    {
      phase: 'P4',
      name: 'Factory Demos can reach the repo',
      run: async () => manual(`confirm in Factory Demos: Settings, Integrations, GitHub lists ${R}`),
    },
    // P5 run identity and Environment
    {
      phase: 'P5',
      name: 'Run identity decided',
      run: async () =>
        v.RUN_IDENTITY
          ? pass(`RUN_IDENTITY=${v.RUN_IDENTITY}`)
          : fail('RUN_IDENTITY is empty', 'write the service account name into demo/.env, for example RUN_IDENTITY=factory-demos (SETUP.md P5)'),
    },
    { phase: 'P5', name: 'Environment for the repo', run: async () => manual('confirm in Factory Demos: an Organization Environment for ' + R + ', Ready, with node --version && npm ci and the Chromium install (SETUP.md P5) in the repository setup script, rebuilt after the last demo-baseline move') },
    // P6 automation
    {
      phase: 'P6',
      name: 'Skill and workflows on main',
      run: async () => {
        const paths = ['.factory/skills/incident-fix/SKILL.md', '.github/workflows/ci.yml', '.github/workflows/droid-review.yml', '.github/workflows/fails-before.yml', 'AGENTS.md'];
        const missingLocal = paths.filter((path) => !existsSync(join(repoRoot, path)));
        if (missingLocal.length) return fail(`missing here: ${missingLocal.join(', ')}`, 'restore them from git');
        const results = await Promise.all(paths.map((path) => gh(['api', `repos/${R}/contents/${path}?ref=main`, '--jq', '.path'], 15_000)));
        const missing = paths.filter((_, i) => results[i]?.code !== 0);
        if (missing.length === paths.length) {
          const first = results[0];
          return fail(`not on GitHub main: ${first ? describeGhError(first.stderr, first) : 'unknown'}`, repoFix);
        }
        return missing.length === 0 ? pass(paths.join(', ')) : fail(`not on main: ${missing.join(', ')}`, 'merge them to main through a pull request');
      },
    },
    {
      phase: 'P6',
      name: 'Automation "Invoice Alerts"',
      run: async () => manual('confirm in Factory Demos: both channels, keyword FIRING, runs as ' + (v.RUN_IDENTITY || 'the service account') + ' on the P5 Environment, session privacy Team, model set, working directory /home/factory-user/repos/invoice-service, prompt as in SETUP.md P6'),
    },
    // P7 local loop
    { phase: 'P7', name: 'Staging port free or ours', run: portCheck('STAGING_PORT', v.STAGING_PORT) },
    { phase: 'P7', name: 'Loop port free or ours', run: portCheck('LOOP_PORT', v.LOOP_PORT) },
    {
      phase: 'P7',
      name: 'Staging at baseline',
      run: async () => {
        const staging = await stagingRunning();
        if (!staging) return fail('staging is not running', './demo.sh up');
        const base = sourceSha(await baselineSource());
        const problems: string[] = [];
        if (staging.sha !== base) problems.push(`runs ${staging.sha.slice(0, 12)}, baseline is ${base.slice(0, 12)}`);
        if (staging.currencies.join(',') !== baselineCurrencies.join(',')) problems.push(`BILLING_CURRENCIES=${staging.currencies.join(',')}`);
        return problems.length === 0
          ? pass(`port ${staging.port}, ${base === 'working-tree' ? 'working tree' : base.slice(0, 7)}, BILLING_CURRENCIES=${staging.currencies.join(',')}`)
          : fail(problems.join('; '), './demo.sh reset');
      },
    },
    {
      phase: 'P7',
      name: 'Staging invoices match the rate card',
      run: async () => {
        try {
          const base = `http://127.0.0.1:${v.STAGING_PORT}`;
          const list = (await (await fetch(`${base}/invoices`, { signal: AbortSignal.timeout(2000) })).json()) as { invoices: Array<{ bookingId: string }> };
          const invoices = await Promise.all(
            list.invoices.map(async (i) => (await (await fetch(`${base}/invoices/${i.bookingId}`, { signal: AbortSignal.timeout(2000) })).json()) as ServedInvoice),
          );
          const rates = JSON.parse(readFileSync(join(repoRoot, 'config', 'rates.json'), 'utf8')) as RateCard;
          const mismatches = checkAll(invoices, rates);
          return mismatches.length === 0
            ? pass(`${invoices.length} invoices checked`)
            : fail(`${mismatches.map((m) => m.bookingId).join(', ')} differ from the rate card`, './demo.sh reset');
        } catch (error) {
          return fail(`could not read staging: ${(error as Error).message}`, './demo.sh up');
        }
      },
    },
    { phase: 'P7', name: 'Monitor running', run: processCheck('monitor', 'monitor') },
    { phase: 'P7', name: 'Deploy watcher running', run: processCheck('deploy', 'deploy watcher') },
    { phase: 'P7', name: 'Loop server running', run: processCheck('loop', 'loop server') },
    // P8 ready for a rehearsal
    {
      phase: 'P8',
      name: 'No open fix/ or check/ pull requests',
      run: async () => {
        const prs = await ghJson<Array<{ number: number; head: { ref: string } }>>(['api', `repos/${R}/pulls?state=open&per_page=100`]);
        if (!prs.ok) return ghFail('open pull requests', prs.error, prs.notFound);
        const open = prs.value.filter((pr) => /^(fix|check)\//.test(pr.head.ref));
        return open.length === 0 ? pass('none open') : fail(open.map((pr) => `#${pr.number} ${pr.head.ref}`).join(', '), './demo.sh reset --yes');
      },
    },
    {
      phase: 'P8',
      name: `main at ${baselineTag}`,
      run: async () => {
        const local = await localTag();
        if (!local) return fail(`no local tag ${baselineTag}`, 'SETUP.md P3');
        const main = await mainSha();
        if (!main.ok) return ghFail('main on GitHub', main.error, main.notFound);
        return main.value.sha === local ? pass(local.slice(0, 7)) : fail(`main is ${main.value.sha.slice(0, 7)}, ${baselineTag} is ${local.slice(0, 7)}`, './demo.sh reset --yes');
      },
    },
    {
      phase: 'P8',
      name: 'No open alert',
      run: async () => {
        const state = readJsonFile<MonitorState>(files.monitor());
        return state?.incident
          ? fail(`incident open since ${state.incident.firstSeen} (thread ${state.incident.ts})`, './demo.sh reset')
          : pass('monitor has no open incident');
      },
    },
  ];
}

const label: Record<Status, string> = { pass: 'PASS  ', fail: 'FAIL  ', manual: 'MANUAL' };

export type DoctorOptions = { phase?: Phase; dryRun?: boolean; skip?: string[] };

export async function doctor(options: DoctorOptions = {}): Promise<boolean> {
  const loaded = loadValues();
  const checks = buildChecks(loaded).filter(
    (check) => (!options.phase || check.phase === options.phase) && !(options.skip ?? []).includes(check.name),
  );
  if (options.dryRun) {
    for (const check of checks) console.log(`would check  ${check.phase}  ${check.name}`);
    return true;
  }
  const outcomes = await Promise.all(
    checks.map((check) => check.run().catch((error: unknown): Outcome => fail(`check crashed: ${(error as Error).message}`, 'report this'))),
  );
  const counts: Record<Status, number> = { pass: 0, fail: 0, manual: 0 };
  checks.forEach((check, i) => {
    const outcome = outcomes[i] ?? fail('no result', 'report this');
    counts[outcome.status] += 1;
    console.log(`${label[outcome.status]} ${check.phase}  ${check.name}: ${outcome.detail}`);
    if (outcome.fix) console.log(`              fix: ${outcome.fix}`);
  });
  const scope = options.phase ? `phase ${options.phase}` : 'all phases';
  console.log(`doctor (${scope}): ${counts.fail === 0 ? 'PASS' : 'FAIL'}, ${counts.pass} pass, ${counts.fail} fail, ${counts.manual} to confirm by hand`);
  return counts.fail === 0;
}
