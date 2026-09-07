/*
 * What the two write-path entrypoints both need: a command runner and the coercions that read a
 * model-written manifest. The step-output writer moved to `lib/outputs.mjs` when a release script
 * turned out to need it too.
 *
 * They are here because `ksai/publish.mjs` and `ksai/record.mjs` held byte-identical copies of all
 * five - 101 of about 170 code lines each, measured. Two copies of a boundary agree until one of them is
 * fixed, and the pieces that were duplicated are the ones where a fix matters: `runCommand` decides that a
 * failed `gh` call is a return value rather than a throw, and `field` decides that a one-element array in a
 * manifest is not a string. A repair applied to one file and not the other leaves the other doing the old
 * thing with nothing failing.
 *
 * `.mjs` because both consumers are ESM entrypoints run with `node <file>`, and it exports nothing a
 * `.cjs` needs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cap, oneLine, MAX_PR_TITLE_CHARS, SUBJECT_SHAPE } = require('./plan.cjs');
const { NUMBER_SHAPE } = require('./context.cjs');
const { COMMIT_TYPES, safeEcho } = require('./verify-chunk.cjs');

const MAX_PARSE_DETAIL_CHARS = 200;

/*
 * Long enough for a push to a large repository, short enough that the job fails rather than hangs. A hung
 * write step is indistinguishable from a stuck runner, and every command these entrypoints run talks to the
 * network.
 */
const COMMAND_TIMEOUT_MS = 120000;

/** Enough for a pull request body, which is the largest thing either entrypoint reads. GitHub caps it at 64KB. */
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Runs one command and never throws.
 *
 * Returns `{ ok, stdout, status }`. Injectable as the `run` option of either entrypoint, so a test can
 * assert the exact argv of every `gh` call without a network - and so verify-before-push and
 * push-before-tick are observable as an ordered call log rather than inferred from the end state.
 *
 * stderr is inherited rather than captured, deliberately in both directions: it reaches the job log, where
 * "see the workflow run" sends the author, and it never lands in a JavaScript string that could be
 * interpolated into a published comment. git stderr carries paths the agent chose, and a `git push` failure
 * quotes the remote URL the token sits in. The `stderr` option exists so the test suite can drop a push's
 * progress lines rather than print them; no setting of it makes the stream readable, because nothing here
 * returns it.
 */
export function runCommand(
  file,
  args,
  { cwd = null, env = null, stderr = 'inherit', input = null, base64 = false, maxBuffer = COMMAND_MAX_BUFFER } = {},
) {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: base64 ? null : 'utf8',
      input,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', stderr === 'ignore' ? 'ignore' : 'inherit'],
      env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer,
    });
    return { ok: true, stdout: base64 ? Buffer.from(stdout ?? []).toString('base64') : String(stdout ?? ''), status: 0 };
  } catch (err) {
    return { ok: false, stdout: '', status: typeof err?.status === 'number' ? err.status : null };
  }
}

/**
 * A manifest field, as a string or not at all.
 *
 * The coercion is the check: `String(['done'])` is `done`, so a one-element array in a model-written
 * manifest would otherwise satisfy a comparison no plain string could have been wrong about.
 */
export const field = (value) => (typeof value === 'string' ? value : '');

/** A non-string field, in the JSON form `jq -r` would have printed, for a refusal that quotes it. */
export const shown = (value) =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);

/** The reason a manifest gives for stopping, as prose. */
export const reasonOf = (manifest) => {
  const reason = field(manifest?.reason).trim();
  return reason ? reason : 'no reason given';
};

export const TITLE_KEY_POSITIONS = Object.freeze(['none', 'prefix', 'suffix']);

function decorateTitle(title, { key = null, where = 'none' } = {}) {
  const text = String(title ?? '');
  if (!key || where === 'none') return text;
  const at = text.indexOf(': ');
  if (at === -1) return text;
  const head = text.slice(0, at + 2);
  const description = text.slice(at + 2);
  return where === 'prefix' ? `${head}${key} ${description}` : `${head}${description} (${key})`;
}

function titleKeyCost({ key = null, where = 'none' } = {}) {
  if (!key || where === 'none') return 0;
  return Array.from(String(key)).length + (where === 'prefix' ? 1 : 3);
}

export function subjectFrom(manifest, { noun = 'The run', triggerPhrase = null, key = null, where = 'none' } = {}) {
  const raw = oneLine(field(manifest?.title), { triggerPhrase });
  if (!SUBJECT_SHAPE.test(raw)) {
    return {
      title: null,
      blocker:
        `${noun} produced a pull request title that is not a Conventional Commit subject: ${safeEcho(shown(manifest?.title))}. ` +
        `It must read \`<type>(<scope>): <description>\`, with a type from ${COMMIT_TYPES.join(', ')}.`,
    };
  }
  const title = decorateTitle(cap(raw, MAX_PR_TITLE_CHARS - titleKeyCost({ key, where })), { key, where });
  if (!SUBJECT_SHAPE.test(title)) {
    return {
      title: null,
      blocker:
        `${noun} produced a pull request title whose type and scope leave no room for a description within the ` +
        `${MAX_PR_TITLE_CHARS}-character limit, so shortening it to fit cuts away the colon: ` +
        `${safeEcho(shown(manifest?.title))}. Use a shorter scope.`,
    };
  }
  return { title, blocker: null };
}

/**
 * A refusal that consumes the manifest on its way out.
 *
 * Both write paths held this closure verbatim, and both of their comments call the removal part of
 * refusing rather than cleanup - it is state the agent wrote and this step has now read, so left in place a
 * re-run reads it as a fresh report of work it is about to redo, and a later `git add -A` commits it.
 *
 * A factory rather than a plain function because each file calls it a dozen times with only a message, and
 * threading the path through every one of those call sites is what made copying the closure look cheaper
 * than sharing it.
 */
export function blockerFor(manifestPath) {
  return (message) => {
    rmSync(manifestPath, { force: true });
    return { status: 'blocked', message };
  };
}

/**
 * The agent's manifest, parsed, or the reason it is unusable.
 *
 * Returns `{ manifest }` or `{ message }`. The caller turns a message into its own refusal, which is what
 * keeps this shared without also sharing the shape of the refusal - `publishPlan` and `recordStep` return
 * the same `{ status: 'blocked' }` today and nothing here should assume they always will.
 *
 * `noun` is the only thing that differed between the two copies: "Planning" against "The step". Fail-closed
 * in both directions - an absent file, an unreadable one and unparseable JSON are all a refusal, never an
 * empty manifest, because an empty manifest reads downstream as a status nobody set.
 *
 * The `statSync` is inside its own try for a reason worth keeping: it throws ENOENT rather than answering
 * false, so a bare `if (!statSync(...).isFile())` turns a missing manifest - the ordinary outcome when an
 * agent runs out of turns - into an uncaught exception and a red job with the reason in a log nobody opens.
 */
export function readManifest(manifestPath, { noun = null, triggerPhrase = null } = {}) {
  const missing = `${noun} did not finish: no manifest was produced.`;
  try {
    if (!statSync(manifestPath).isFile()) return { message: missing };
  } catch {
    return { message: missing };
  }
  try {
    return { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
  } catch (error) {
    const said = oneLine(error?.message, { triggerPhrase }).slice(0, MAX_PARSE_DETAIL_CHARS);
    const detail = said === '' ? '' : ` ${said}`;
    return { message: `${noun} produced a manifest that is not valid JSON.${detail}` };
  }
}

export function createPull({
  repo = null,
  base = null,
  head = null,
  title = null,
  bodyFile = null,
  draft = false,
  run = runCommand,
} = {}) {
  const created = run('gh', [
    'pr',
    'create',
    '--repo',
    String(repo ?? ''),
    ...(draft === true ? ['--draft'] : []),
    '--base',
    String(base ?? ''),
    '--head',
    String(head ?? ''),
    '--title',
    String(title ?? ''),
    '--body-file',
    String(bodyFile ?? ''),
  ]);
  if (!created.ok) return { refused: true, prUrl: '', prNumber: '' };

  const prUrl =
    String(created.stdout)
      .split('\n')
      .map((line) => line.trim())
      .findLast(Boolean) ?? '';
  const tail = prUrl.split('/pull/')[1] ?? '';
  return { refused: false, prUrl, prNumber: NUMBER_SHAPE.test(tail) ? tail : '' };
}
