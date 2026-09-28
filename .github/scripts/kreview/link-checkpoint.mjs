import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import stage from '../ksai/stage.cjs';
import trustedGit from '../ksai/trusted-git.cjs';
import controlPlane from '../lib/control-plane.cjs';
import { OPENCODE_V2_VERSION } from '../lib/opencode-v2.mjs';
import { scrub, withEscaped } from './secrets.cjs';

export const PART_MOST = 8 * 1024 * 1024;
export const RESTORED_EXPORT = 'restored.export.json';
const CALL_MS = 120_000;
const REASON_MOST = 200;
export const UNSAID = 'the checkpoint was not restored, and nothing said why';
const COMMIT = /^[0-9a-f]{40}$/;
const CHECKPOINT = /^[0-9a-f]{64}$/;
const SESSION = /^ses_[A-Za-z0-9]{1,64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function headOf(git) {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const sha = String(head.stdout ?? '').trim();
  if (!head.ok || !COMMIT.test(sha)) throw new Error(head.reason || 'the checkout names no commit');
  return sha;
}

export function snapshot(git, scratch) {
  const head = headOf(git);
  const index = join(scratch, 'index');
  const indexed = Object.assign((args, options = {}) => git(args, { ...options, index }), { policy: git.policy });
  if (!indexed(['read-tree', head]).ok) throw new Error('the checkout could not be read into an index of its own');
  const staged = stage.stageAll(indexed);
  if (!staged.ok) throw new Error(staged.reason);
  const tree = indexed(['write-tree']);
  const written = String(tree.stdout ?? '').trim();
  if (!tree.ok || !COMMIT.test(written)) throw new Error('the working tree could not be written as a tree');
  const diff = git(['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', head, written], { base64: true });
  if (!diff.ok) throw new Error('the work could not be written as a patch');
  return { head, patch: Buffer.from(diff.stdout, 'base64') };
}

export class Unapplied extends Error {}

export function applied(git, patchFile, saved) {
  const head = headOf(git);
  if (head !== saved) throw new Unapplied(`the checkout is at ${head}, and the checkpoint was saved against ${saved}`);
  if (statSync(patchFile).size === 0) return;
  if (!git(['apply', '--check', '--binary', patchFile]).ok) throw new Unapplied('the checkpoint does not apply to the checkout');
  if (!git(['apply', '--binary', patchFile]).ok) throw new Error('the checkpoint could not be applied');
}

export function checkpointUpload({ exported, patch, head, base, parent, promptVersion, link, job, flow, secrets = [] }) {
  if (!VERSION.test(promptVersion)) throw new Error('the engine named no prompt version to save the checkpoint under');
  if (!COMMIT.test(base)) throw new Error('the run names no base commit to save the checkpoint against');
  if (parent && !CHECKPOINT.test(parent)) throw new Error('the engine named a previous checkpoint that is not one');
  let session;
  try {
    session = JSON.parse(exported.toString('utf8'))?.info?.id;
  } catch {
    session = '';
  }
  if (typeof session !== 'string' || !SESSION.test(session)) throw new Error('the kept export names no OpenCode session');
  try {
    utf8.decode(patch);
  } catch {
    throw new Error('the work holds a file that is not UTF-8 text, and a checkpoint keeps its patch as text');
  }
  const hidden = withEscaped(secrets);
  const kept = Buffer.from(scrub(exported.toString('utf8'), hidden), 'utf8');
  const changed = Buffer.from(scrub(patch.toString('utf8'), hidden), 'utf8');
  if (kept.length > PART_MOST) throw new Error(`the export is ${kept.length} bytes, and a checkpoint keeps at most ${PART_MOST}`);
  if (changed.length > PART_MOST) throw new Error(`the patch is ${changed.length} bytes, and a checkpoint keeps at most ${PART_MOST}`);
  return {
    job, link, flow, model_session_id: session, base_sha: base, head_sha: head, engine_version: OPENCODE_V2_VERSION,
    prompt_version: promptVersion, ...(parent ? { parent_id: parent } : {}), export: kept.toString('base64'), patch: changed.toString('base64'),
  };
}

export async function checkpointSaved({ endpoint, fetch, token, upload }) {
  const said = await controlPlane.answered(fetch, `${endpoint}/v1/run/work-sessions/checkpoints`, { token, body: JSON.stringify(upload), timeout: CALL_MS });
  if (said.why) throw new Error(`the control plane did not keep the checkpoint: ${said.why}`);
  const id = String(said.answer?.id ?? '');
  if (!CHECKPOINT.test(id)) throw new Error('the control plane kept the checkpoint under no id');
  return id;
}

function bounded(said) {
  let bytes = 0;
  let kept = '';
  for (const one of said) {
    bytes += Buffer.byteLength(one);
    if (bytes > REASON_MOST) break;
    kept += one;
  }
  return kept || UNSAID;
}

function fellBack(reason, parent) {
  return [
    { name: 'status', value: 'fallback' },
    { name: 'reason', value: bounded(reason) },
    ...(parent === undefined ? [] : [{ name: 'parent', value: parent }]),
  ];
}

export async function restoredFrom({ endpoint, fetch, token, link, job, flow, promptVersion, apply, keep }) {
  if (!VERSION.test(promptVersion)) throw new Error('the engine named no prompt version to restore under');
  const said = await controlPlane.answered(fetch, `${endpoint}/v1/run/work-sessions/checkpoints/restore`, {
    token, body: JSON.stringify({ job, link, flow, engine_version: OPENCODE_V2_VERSION, prompt_version: promptVersion }), timeout: CALL_MS,
  });
  if (said.why) throw new Error(`the control plane did not answer the restore: ${said.why}`);
  const answer = said.answer ?? {};
  if (answer.status === 'fallback') {
    if (answer.parent_id !== undefined && (typeof answer.parent_id !== 'string' || !CHECKPOINT.test(answer.parent_id))) {
      throw new Error('the control plane fell back under a parent that is not a checkpoint');
    }
    return fellBack(String(answer.reason ?? ''), answer.parent_id);
  }
  if (answer.status !== 'ready') throw new Error(`the control plane answered a restore with status ${JSON.stringify(answer.status)}`);
  const saved = answer.checkpoint ?? {};
  const exported = Buffer.from(String(answer.export ?? ''), 'base64');
  const patch = Buffer.from(String(answer.patch ?? ''), 'base64');
  if (!CHECKPOINT.test(String(saved.id)) || !COMMIT.test(String(saved.head_sha)) || !SESSION.test(String(saved.model_session_id))) {
    throw new Error('the control plane offered a checkpoint that does not name itself');
  }
  if (sha256(exported) !== saved.export_sha256 || exported.length !== saved.export_bytes) throw new Error('the offered export is not the one the checkpoint names');
  if (sha256(patch) !== saved.patch_sha256 || patch.length !== saved.patch_bytes) throw new Error('the offered patch is not the one the checkpoint names');
  let session;
  try {
    session = JSON.parse(exported.toString('utf8'))?.info?.id;
  } catch {
    session = '';
  }
  if (session !== saved.model_session_id) throw new Error('the offered export is of another OpenCode session');
  try {
    await apply(patch, saved.head_sha);
  } catch (error) {
    if (!(error instanceof Unapplied)) throw error;
    return fellBack(error.message, saved.id);
  }
  keep(exported);
  return [{ name: 'status', value: 'restored' }, { name: 'checkpoint', value: saved.id }, { name: 'model_session', value: saved.model_session_id }];
}

export function main(env = process.env, { git = trustedGit.directGit(String(env.GITHUB_WORKSPACE ?? '')), write = (said) => writeFileSync(String(env.CHECKPOINT_OUT ?? ''), said) } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'ksai-checkpoint-'));
  try {
    if (env.CHECKPOINT_MODE === 'snapshot') {
      const { head, patch } = snapshot(git, scratch);
      write(JSON.stringify({ head, patch: patch.toString('base64') }));
    } else if (env.CHECKPOINT_MODE === 'apply') {
      applied(git, String(env.CHECKPOINT_PATCH ?? ''), String(env.CHECKPOINT_HEAD ?? ''));
      write(JSON.stringify({ applied: true }));
    } else {
      throw new Error(`there is no checkpoint mode ${JSON.stringify(env.CHECKPOINT_MODE)}`);
    }
  } catch (error) {
    write(JSON.stringify({ error: String(error?.message ?? error), ...(error instanceof Unapplied ? { unapplied: true } : {}) }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
