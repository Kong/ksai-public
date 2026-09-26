import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import trust from './trust.json' with { type: 'json' };

const GITHUB_FULCIO = 'fulcio.githubapp.com';

export function rendererFor(endpoint, pinned = trust) {
  const origin = new URL(endpoint).origin;
  const renderer = pinned.renderers?.[origin];
  if (!renderer) throw new Error(`this KSAI release pins no render key for ${origin}, so nothing it renders can be verified`);
  return renderer;
}

export function governanceOptions({ endpoint, artifacts, report, trustedRoot, expect, tools, arm }, pinned = trust) {
  return {
    ...rendererFor(endpoint, pinned),
    artifacts,
    report,
    trustedRoot,
    expect,
    tools,
    ...(arm ? { arm } : {}),
    releaseSigner: pinned.releaseSigner,
    releaseIssuer: pinned.releaseIssuer,
    renderPredicate: pinned.renderPredicate,
    ...(pinned.minimum ? { minimum: pinned.minimum } : {}),
    revoked: pinned.revoked ?? [],
  };
}

export function githubTrustedRoot(said) {
  const roots = String(said ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((root) => (root.certificateAuthorities ?? []).some((authority) => authority.uri === GITHUB_FULCIO));
  if (roots.length !== 1) throw new Error(`gh answered ${roots.length} trust roots for GitHub's own Sigstore instance`);
  return roots[0];
}

export function writeTrustedRoot(path, run = spawnSync) {
  const answered = run('gh', ['attestation', 'trusted-root'], { encoding: 'utf8', timeout: 60_000 });
  if (answered.status !== 0) throw new Error(`gh could not read GitHub's attestation trust root: ${String(answered.stderr ?? answered.error ?? '').trim()}`);
  writeFileSync(path, `${JSON.stringify(githubTrustedRoot(answered.stdout))}\n`, { mode: 0o600 });
  return path;
}

export const governedRoot = (env) => join(String(env.RUNNER_TEMP ?? ''), 'ksai-governed');

export const deliveriesAt = (root) => join(root, 'deliveries.jsonl');

export const trustedRootAt = (root) => join(root, 'trusted-root.json');

export function prepareGovernance(env, run = spawnSync, trustedRoot = null) {
  const root = governedRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (trustedRoot) writeFileSync(trustedRootAt(root), `${JSON.stringify(trustedRoot)}\n`, { mode: 0o600 });
  else writeTrustedRoot(trustedRootAt(root), run);
  writeFileSync(deliveriesAt(root), '', { mode: 0o600, flag: 'a' });
  const vendored = join(String(env.SCRIPTS ?? ''), 'vendor', 'opencode-governance');
  const done = run('npm', ['ci', '--prefix', vendored, '--omit=dev', '--ignore-scripts'], { stdio: 'inherit', timeout: 300_000 });
  if (done.status !== 0) throw new Error(`the governance plugin's packages could not be installed under ${vendored}`);
  return root;
}
