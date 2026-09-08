import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodeProject, findTranscript } from './progress.mjs';

const SESSION_SHAPE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,120}$/;

const ARTIFACT_PREFIX = 'ksai-plan-session-';

export const RETENTION_DAYS = 7;

export const artifactName = (prNumber) => `${ARTIFACT_PREFIX}${String(prNumber ?? '').trim()}`;

export function retentionDays(allowed) {
  const capped = Number(allowed);
  return Number.isSafeInteger(capped) && capped > 0 ? Math.min(RETENTION_DAYS, capped) : RETENTION_DAYS;
}

function transcriptRoot(env) {
  return env.TRANSCRIPT_ROOT || join(env.HOME ?? '', '.claude', 'projects');
}

const OPENCODE_FILE = 'opencode-session.json';

const opencodeAt = (dir) => join(dir, OPENCODE_FILE);

function newestSession(env, run) {
  const listed = run('opencode', ['session', 'list', '--format', 'json', '-n', '1'], { encoding: 'utf8', env });
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
export function saveOpencode(env = process.env, run = spawnSync) {
  const outputs = { file: '', saved: 'false' };
  const dir = String(env.STAGING_DIR ?? '').trim();
  if (!dir) {
    process.stdout.write('note: no staging directory was given, so the session is not carried.\n');
    return outputs;
  }
  const at = opencodeAt(dir);
  try {
    mkdirSync(dir, { recursive: true });
    const id = newestSession(env, run);
    if (id === '') {
      process.stdout.write('note: this run named no session to export, so the next rework starts cold.\n');
      return outputs;
    }
    const exported = run('opencode', ['export', id], { encoding: 'utf8', env });
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
export function restoreOpencode(env = process.env, run = spawnSync) {
  const outputs = { session_id: '', resumed: 'false', resume_args: '' };
  const from = String(env.DOWNLOAD_DIR ?? '').trim();
  const at = from ? opencodeAt(from) : '';
  if (!at || !existsSync(at)) return outputs;
  const imported = run('opencode', ['import', at], { encoding: 'utf8', env });
  if (imported.status !== 0) {
    process.stdout.write('note: the carried session could not be imported, so this run starts cold.\n');
    return outputs;
  }
  const id = newestSession(env, run);
  if (id === '') {
    process.stdout.write('note: the imported session is not named as a session id, so this run starts cold.\n');
    return outputs;
  }
  process.stdout.write(`note: resuming the planning session ${id}.\n`);
  return { session_id: id, resumed: 'true', resume_args: '' };
}

export function save(env = process.env) {
  if (String(env.ENGINE ?? '') === 'opencode') return saveOpencode(env);
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
  if (String(env.ENGINE ?? '') === 'opencode') return restoreOpencode(env);
  const outputs = { session_id: '', resumed: 'false', resume_args: '' };
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
  return { session_id: id, resumed: 'true', resume_args: `--resume ${id} --fork-session` };
}

