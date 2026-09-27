import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsed } from '../lib/opencode.mjs';
import { isV2, storeEnv } from '../lib/opencode-v2.mjs';
import { encodeProject, findTranscript, transcriptRoot } from './progress.mjs';

const SESSION_SHAPE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,120}$/;

const ARTIFACT_PREFIX = 'ksai-plan-session-';

export const RETENTION_DAYS = 7;

export const artifactName = (prNumber) => `${ARTIFACT_PREFIX}${String(prNumber ?? '').trim()}`;

export const carriedSession = (artifacts) =>
  (artifacts ?? []).find((one) => {
    const run = one?.workflow_run;
    return one?.expired !== true && Number.isSafeInteger(run?.repository_id) && run.head_repository_id === run.repository_id;
  }) ?? null;

export function retentionDays(allowed) {
  const capped = Number(allowed);
  return Number.isSafeInteger(capped) && capped > 0 ? Math.min(RETENTION_DAYS, capped) : RETENTION_DAYS;
}

const OPENCODE_FILE = 'opencode-session.json';

const workspaceOf = (env) => String(env.GITHUB_WORKSPACE ?? '') || undefined;

function newestSession(env, run) {
  const listed = run('opencode', ['session', 'list', '--format', 'json', '-n', '1'], { encoding: 'utf8', env, cwd: workspaceOf(env) });
  try {
    const [newest] = JSON.parse(String(listed.stdout ?? '[]'));
    const id = String(newest?.id ?? '');
    return SESSION_SHAPE.test(id) ? id : '';
  } catch {
    return '';
  }
}

/**
 * saveOpencode carries the planning session by exporting it, which is the only handle this engine
 * offers: its sessions live in a store rather than in a transcript file a path can name.
 */
export function saveOpencode(
  env = process.env,
  run = spawnSync,
  { file = OPENCODE_FILE, newest = () => newestSession(env, run), exporting = (id) => run('opencode', ['export', id], { encoding: 'utf8', env, cwd: workspaceOf(env) }) } = {},
) {
  const outputs = { file: '', saved: 'false' };
  const dir = String(env.STAGING_DIR ?? '').trim();
  if (!dir) {
    process.stdout.write('note: no staging directory was given, so the session is not carried.\n');
    return outputs;
  }
  const at = join(dir, file);
  try {
    mkdirSync(dir, { recursive: true });
    const id = newest();
    if (id === '') {
      process.stdout.write('note: this run named no session to export, so the next rework starts cold.\n');
      return outputs;
    }
    const exported = exporting(id);
    if (exported.status !== 0 || !String(exported.stdout ?? '').trim()) {
      process.stdout.write('note: this run exported no session, so the next rework starts cold.\n');
      return outputs;
    }
    writeFileSync(at, exported.stdout);
    return { file: at, saved: 'true' };
  } catch (error) {
    process.stdout.write(`note: the session could not be exported (${error?.message ?? error}).\n`);
    return outputs;
  }
}

/**
 * restoreOpencode imports a carried session and answers the id to fork from, or nothing at all.
 *
 * The id is read back from the store rather than from the file, because an import is what decides
 * it: a session already present is not imported twice and the id in the file may name another run's.
 */
export function restoreOpencode(
  env = process.env,
  run = spawnSync,
  { file = OPENCODE_FILE, importing = (at) => run('opencode', ['import', at], { encoding: 'utf8', env, cwd: workspaceOf(env) }), idOf = (_imported = {}) => newestSession(env, run) } = {},
) {
  const outputs = { session_id: '', resumed: 'false' };
  const from = String(env.DOWNLOAD_DIR ?? '').trim();
  const at = from ? join(from, file) : '';
  if (!at || !existsSync(at)) return outputs;
  const imported = importing(at);
  if (imported.status !== 0) {
    process.stdout.write('note: the carried session could not be imported, so this run starts cold.\n');
    return outputs;
  }
  const id = idOf(imported);
  if (id === '') {
    process.stdout.write('note: the imported session is not named as a session id, so this run starts cold.\n');
    return outputs;
  }
  process.stdout.write(`note: resuming the planning session ${id}.\n`);
  return { session_id: id, resumed: 'true' };
}

const OPENCODE2_FILE = 'opencode2-session.json';

const EXPORT_BYTES = 64 * 1024 * 1024;

const SESSION2_SHAPE = /^ses_[a-zA-Z0-9]{1,120}$/;

const transfer = (env, run, command, argument) =>
  run(process.execPath, [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-v2-driver.mjs'), command, argument], {
    encoding: 'utf8',
    env: storeEnv(env),
    cwd: workspaceOf(env),
    maxBuffer: EXPORT_BYTES,
  });

export function newestRoot(raw) {
  const roots = parsed(raw).filter((event) => event.type === 'ksai.session' && event.data?.parentID === null && SESSION2_SHAPE.test(String(event.data?.sessionID ?? '')));
  return roots.at(-1)?.data.sessionID ?? '';
}

export function saveOpencode2(env = process.env, run = spawnSync, read = readFileSync) {
  return saveOpencode(env, run, { file: OPENCODE2_FILE, newest: () => newestRoot(read(String(env.EVENTS_FILE ?? ''), 'utf8')), exporting: (id) => transfer(env, run, 'export', id) });
}

export function restoreOpencode2(env = process.env, run = spawnSync) {
  return restoreOpencode(env, run, {
    file: OPENCODE2_FILE,
    importing: (at) => transfer(env, run, 'import', at),
    idOf: (imported) => {
      const id = String(imported.stdout ?? '').trim();
      return SESSION2_SHAPE.test(id) ? id : '';
    },
  });
}

export function save(env = process.env) {
  if (String(env.ENGINE ?? '') === 'opencode') return isV2(env.OPENCODE_VERSION) ? saveOpencode2(env) : saveOpencode(env);
  const outputs = { file: '', saved: 'false' };
  const named = String(env.SESSION_ID ?? '').trim();
  if (!SESSION_SHAPE.test(named)) {
    process.stdout.write('note: this run names no session, so there is nothing to carry and the next rework starts cold.\n');
    return outputs;
  }

  const at = findTranscript(transcriptRoot(env), named, Number(env.TRANSCRIPT_SINCE), env.GITHUB_WORKSPACE);
  if (!at) {
    process.stdout.write('note: this run wrote no transcript, so the next rework starts cold.\n');
    return outputs;
  }

  const dir = String(env.STAGING_DIR ?? '').trim();
  if (!dir) {
    process.stdout.write('note: no staging directory was given, so the session is not carried.\n');
    return outputs;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const to = join(dir, `${named}.jsonl`);
    copyFileSync(at, to);
    return { file: to, saved: 'true' };
  } catch (error) {
    process.stdout.write(`note: the transcript could not be staged (${error?.message ?? error}).\n`);
    return outputs;
  }
}

export function restore(env = process.env) {
  if (String(env.ENGINE ?? '') === 'opencode') return isV2(env.OPENCODE_VERSION) ? restoreOpencode2(env) : restoreOpencode(env);
  const outputs = { session_id: '', resumed: 'false' };
  const from = String(env.DOWNLOAD_DIR ?? '').trim();
  if (!from || !existsSync(from)) return outputs;

  let newest = { name: '', at: -1 };
  try {
    for (const file of readdirSync(from)) {
      if (!file.endsWith('.jsonl')) continue;
      const stat = statSync(join(from, file));
      if (stat.mtimeMs > newest.at) newest = { name: file, at: stat.mtimeMs };
    }
  } catch (error) {
    process.stdout.write(`note: the carried session could not be listed (${error?.message ?? error}).\n`);
    return outputs;
  }
  if (newest.name === '') return outputs;

  const id = newest.name.replace(/\.jsonl$/, '');
  if (!SESSION_SHAPE.test(id)) {
    process.stdout.write('note: the carried session is not named as a session id, so this run starts cold.\n');
    return outputs;
  }

  const project = encodeProject(String(env.GITHUB_WORKSPACE ?? ''));
  if (!project) {
    process.stdout.write('note: this run has no workspace to place the carried session under.\n');
    return outputs;
  }
  try {
    const dir = join(transcriptRoot(env), project);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(from, newest.name), join(dir, newest.name));
  } catch (error) {
    process.stdout.write(`note: the carried session could not be placed (${error?.message ?? error}).\n`);
    return outputs;
  }

  process.stdout.write(`note: resuming the planning session ${id}.\n`);
  return { session_id: id, resumed: 'true' };
}

