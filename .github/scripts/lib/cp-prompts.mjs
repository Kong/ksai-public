import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import controlPlane from './control-plane.cjs';

const { mask, minter, reachControlPlane, renderingModeOf, unanswered } = controlPlane;

export const TOOL_PREFIX = 'static.runtime.opencode-tool-';
export const REMINDER_ID = 'static.runtime.opencode-max-steps';
const CLASSIFICATION = Object.freeze({ internal: 'internal', public: 'public' });
export { SINKS, renderRequest, writeRenderRequest } from './render-request.cjs';

export const ARTIFACTS = Object.freeze({
  prompt: 'prompt.md',
  render: 'render.sigstore.json',
  lock: 'catalog.lock.json',
  attestation: 'catalog.sigstore.json',
  tools: 'tools',
  reminder: 'max-steps.json',
  expect: 'expect.json',
});

const VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOOL = /^[a-z][a-z0-9_-]{0,63}$/;
const DEFAULT_TIMEOUT = 60_000;
const REPORT_BATCH = 64;
const RENDER_DEPTH = 4;
const READ = new WeakMap();

function readOnce(fetch, key, make) {
  let reads = READ.get(fetch);
  if (!reads) READ.set(fetch, (reads = new Map()));
  if (!reads.has(key)) reads.set(key, make().catch((error) => { reads.delete(key); throw error; }));
  return reads.get(key);
}

export function promptRendering(env = process.env) {
  return renderingModeOf(env?.KSAI_PROMPT_RENDERING);
}

export function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function record(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`the control plane answered ${what} this run cannot read`);
  }
  return value;
}

const PASSING = new Set([404, 502, 503]);
const RETRIES = 4;
const pause = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function asked(fetch, url, init, what, { retries = 0, wait = pause } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new Error(`${unanswered(error)} (${what})`, { cause: error });
    }
    if (response.ok) return response;
    const said = (await response.text().catch(() => '')).trim().slice(0, 300);
    if (attempt >= retries || !PASSING.has(response.status)) {
      throw new Error(`the control plane refused ${what}: ${response.status}${said ? ` ${said}` : ''}`);
    }
    await wait(500 * 2 ** attempt);
  }
}

function renderedOf(answer, request) {
  const rendered = record(answer, 'a render');
  const catalog = record(rendered.catalog, 'a render');
  if (typeof rendered.prompt !== 'string' || rendered.prompt === '') throw new Error('the control plane rendered no prompt');
  record(rendered.bundle, 'a signed render');
  record(rendered.receipt, 'a receipt');
  if (!VERSION.test(String(catalog.version ?? ''))) {
    throw new Error(`the control plane rendered from ${catalog.version || 'no release'}, and a run renders only from an attested release`);
  }
  if (catalog.attested !== true) throw new Error(`no release workflow attested prompt release ${catalog.version}`);
  if (!DIGEST.test(String(catalog.lock_digest ?? ''))) throw new Error('the control plane named no catalog digest');
  if (digestOf(rendered.prompt) !== rendered.receipt.final_digest) {
    throw new Error('the control plane answered a prompt its receipt does not describe');
  }
  const receipt = rendered.receipt;
  if (receipt.prompt_id !== request.prompt_id || receipt.sink !== request.sink || (receipt.model ?? '') !== (request.model ?? '')) {
    throw new Error(`the control plane rendered ${receipt.prompt_id} for ${receipt.sink}, and this run asked for ${request.prompt_id} for ${request.sink}`);
  }
  if (receipt.catalog_digest !== catalog.lock_digest) {
    throw new Error(`the receipt names a catalog other than prompt release ${catalog.version}`);
  }
  return rendered;
}

function lockedOf(lock, version) {
  let parsed;
  try {
    parsed = JSON.parse(lock.toString('utf8'));
  } catch (error) {
    throw new Error(`the lock of ${version} is not JSON`, { cause: error });
  }
  if (!Array.isArray(record(parsed, 'a lock').prompts)) throw new Error(`the lock of ${version} lists no prompts`);
  return new Map(parsed.prompts.map((entry) => [entry?.id, entry]));
}

function staticOf(answer, version, lockDigest, locked) {
  const listed = record(answer, 'static prompts');
  if (listed.version !== version || listed.lock_digest !== lockDigest || !Array.isArray(listed.files)) {
    throw new Error(`the control plane listed static prompts of a release other than ${version}`);
  }
  return listed.files.map((file) => {
    const one = record(file, 'a static prompt');
    const body = Buffer.from(String(one.body ?? ''), 'base64');
    if (typeof one.id !== 'string' || typeof one.destination !== 'string' || digestOf(body) !== one.body_digest) {
      throw new Error(`static prompt ${one.id ?? '(unnamed)'} is not the body its digest names`);
    }
    const entry = locked.get(one.id);
    if (!entry || entry.dynamic || entry.body_digest !== one.body_digest || entry.version !== one.version ||
      entry.classification !== one.classification || !(entry.destinations ?? []).includes(one.destination)) {
      throw new Error(`static prompt ${one.id} is not the body the attested lock of ${version} records for ${one.destination}`);
    }
    return { id: one.id, version: one.version, destination: one.destination, classification: one.classification, digest: one.body_digest, body };
  });
}

function covering(files, locked, version) {
  const served = new Map();
  const seen = new Map();
  for (const file of files) {
    const kinds = seen.get(file.destination) ?? new Set();
    if (kinds.has(file.classification) || (kinds.size > 0 && ![...kinds, file.classification].includes(CLASSIFICATION.internal))) {
      throw new Error(`prompt release ${version} was listed with ${file.destination} twice`);
    }
    seen.set(file.destination, kinds.add(file.classification));
    const held = served.get(file.destination);
    if (!held || file.classification === CLASSIFICATION.internal) served.set(file.destination, file);
  }
  for (const entry of locked.values()) {
    const missing = entry?.dynamic ? undefined : (entry?.destinations ?? []).find((destination) => !served.has(destination));
    if (missing) throw new Error(`the control plane listed no static prompt for ${missing}, which prompt release ${version} carries`);
  }
  return [...served.values()];
}

function writeArtifacts(dir, { rendered, lock, attestation, tools, reminder, expect }) {
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(dir, ARTIFACTS.tools), { mode: 0o700 });
  const fresh = { mode: 0o600, flag: 'wx' };
  writeFileSync(join(dir, ARTIFACTS.expect), JSON.stringify(expect), fresh);
  writeFileSync(join(dir, ARTIFACTS.prompt), rendered.prompt, fresh);
  writeFileSync(join(dir, ARTIFACTS.render), JSON.stringify(rendered.bundle), fresh);
  writeFileSync(join(dir, ARTIFACTS.lock), lock, fresh);
  writeFileSync(join(dir, ARTIFACTS.attestation), attestation, fresh);
  for (const [name, body] of tools) writeFileSync(join(dir, ARTIFACTS.tools, `${name}.json`), body, fresh);
  if (reminder !== undefined) writeFileSync(join(dir, ARTIFACTS.reminder), reminder, fresh);
}

export function parityOf(rendered, at) {
  let local;
  try {
    local = readFileSync(String(at ?? ''), 'utf8');
  } catch {
    return 'the prompt this run sends was not read, so nothing compares them';
  }
  const bytes = (value) => `${digestOf(value)} (${Buffer.byteLength(value)} bytes)`;
  return digestOf(local) === digestOf(rendered)
    ? `the control plane rendered the bytes this run sends, ${bytes(local)}`
    : `the control plane rendered other bytes than this run sends: ${bytes(rendered)} against ${bytes(local)}`;
}

export async function renderThroughControlPlane({
  request,
  dir,
  tools = [],
  limited = false,
  statics = true,
  env = process.env,
  fetch = globalThis.fetch,
  secret = mask,
  timeout = DEFAULT_TIMEOUT,
  wait = pause,
}) {
  if (tools.some((name) => !TOOL.test(name)) || new Set(tools).size !== tools.length) {
    throw new Error(`the governed tools are not distinct tool names: ${tools.join(', ')}`);
  }
  if (request?.run !== undefined) throw new Error('a render request names no run; the control plane reads it from this job\'s token');
  const signal = AbortSignal.timeout(timeout);
  const reached = await reachControlPlane({
    endpoint: env.KSAI_CP_ENDPOINT,
    env,
    mint: minter({ env, fetch, signal }),
    secret,
  });
  if (reached.failure) throw new Error(reached.failure);
  const headers = { authorization: `Bearer ${reached.token}` };
  const answered = await asked(fetch, `${reached.base}/v1/prompts/render`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  }, 'the render', { retries: RETRIES, wait });
  const rendered = renderedOf(await answered.json(), request);
  const { version, lock_digest: lockDigest } = rendered.catalog;
  const catalog = `${reached.base}/v1/prompts/catalogs/${encodeURIComponent(version)}`;
  const release = await readOnce(fetch, `${catalog}|${lockDigest}`, async () => {
    const [lockAnswer, attestationAnswer] = await Promise.all([
      asked(fetch, `${catalog}/lock`, { headers, signal }, 'the catalog lock', { retries: RETRIES, wait }),
      asked(fetch, `${catalog}/attestation`, { headers, signal }, 'the release attestation', { retries: RETRIES, wait }),
    ]);
    const lock = Buffer.from(await lockAnswer.arrayBuffer());
    if (digestOf(lock) !== lockDigest) throw new Error(`the lock of ${version} is not the one the render names`);
    return { lock, attestation: Buffer.from(await attestationAnswer.arrayBuffer()), locked: lockedOf(lock, version) };
  });
  const { lock, attestation, locked } = release;
  const files = !statics ? [] : await readOnce(fetch, `${catalog}|${lockDigest}|static`, async () => {
    const answer = await asked(fetch, `${catalog}/static`, { headers, signal }, 'the static prompts', { retries: RETRIES, wait });
    return covering(staticOf(await answer.json(), version, lockDigest, locked), locked, version);
  });
  const governed = tools.map((name) => {
    const tool = files.find((file) => file.id === TOOL_PREFIX + name);
    if (!tool) throw new Error(`prompt release ${version} governs no ${name} tool`);
    return [name, tool.body];
  });
  const reminder = limited ? files.find((file) => file.id === REMINDER_ID)?.body : undefined;
  if (limited && reminder === undefined) throw new Error(`prompt release ${version} governs no step-limit reminder`);
  const expect = {
    promptId: request.prompt_id,
    sink: request.sink,
    model: request.model,
    finalDigest: digestOf(rendered.prompt),
  };
  writeArtifacts(dir, { rendered, lock, attestation, tools: governed, reminder, expect });
  return {
    dir,
    prompt: join(dir, ARTIFACTS.prompt),
    version,
    arm: String(rendered.catalog.arm ?? ''),
    expect,
    files,
  };
}

const DELIVERY_TEXT = Object.freeze({
  outcome: 32,
  prompt_id: 256,
  prompt_version: 64,
  sink: 64,
  final_digest: 128,
  catalog_version: 64,
  catalog_digest: 128,
  arm: 128,
  reason: 500,
});

function onlyDelivery(line) {
  const held = {};
  for (const [name, most] of Object.entries(DELIVERY_TEXT)) {
    if (line[name] === undefined) continue;
    held[name] = [...String(line[name])].map((one) => (one < ' ' || one === '\u007F' ? ' ' : one)).join('').slice(0, most);
  }
  return held;
}

function kept(files, read) {
  return files.flatMap((file) => {
    let text;
    try {
      text = read(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return text.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
      try {
        return [onlyDelivery(record(JSON.parse(line), 'a kept delivery'))];
      } catch {
        console.log('::warning::a delivery line no governor wrote is dropped');
        return [];
      }
    });
  });
}

function rendersUnder(root, list = readdirSync, read = readFileSync) {
  const made = new Map();
  const walk = (at, depth) => {
    if (depth > RENDER_DEPTH) return;
    let entries;
    try {
      entries = list(at, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(at, entry.name), depth + 1);
      if (!entry.isFile() || entry.name !== ARTIFACTS.expect) continue;
      const expect = JSON.parse(read(join(at, entry.name), 'utf8'));
      const digests = made.get(String(expect.promptId ?? '')) ?? new Set();
      digests.add(String(expect.finalDigest ?? ''));
      made.set(String(expect.promptId ?? ''), digests);
    }
  };
  walk(root, 0);
  return made;
}

function reconciled(deliveries, made) {
  return deliveries.filter((delivery) => {
    const promptId = String(delivery.prompt_id ?? '');
    if (promptId === '') return delivery.outcome === 'refused';
    const digests = made.get(promptId);
    if (!digests) return false;
    return digests.has(String(delivery.final_digest ?? ''));
  });
}

export function deliveriesUnder({ files, root, read = readFileSync, list = readdirSync }) {
  if (!String(root ?? '')) throw new Error('a delivery report names the directory whose renders explain it');
  const written = kept(files, read);
  return { written, deliveries: reconciled(written, rendersUnder(root, list, read)) };
}

export async function reportDeliveries({
  files,
  root,
  env = process.env,
  fetch = globalThis.fetch,
  secret = mask,
  timeout = DEFAULT_TIMEOUT,
  wait = pause,
  read = readFileSync,
  list = readdirSync,
}) {
  const { written, deliveries } = deliveriesUnder({ files, root, read, list });
  if (written.length !== deliveries.length) {
    console.log(`::warning::${written.length - deliveries.length} delivery lines name no render this job made, so they are not reported`);
  }
  if (deliveries.length === 0) return { reported: 0 };
  const signal = AbortSignal.timeout(timeout);
  const reached = await reachControlPlane({
    endpoint: env.KSAI_CP_ENDPOINT,
    env,
    mint: minter({ env, fetch, signal }),
    secret,
  });
  if (reached.failure) throw new Error(reached.failure);
  for (let at = 0; at < deliveries.length; at += REPORT_BATCH) {
    await asked(fetch, `${reached.base}/v1/prompts/receipts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reached.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deliveries: deliveries.slice(at, at + REPORT_BATCH) }),
      signal,
    }, 'the delivery report', { retries: RETRIES, wait });
  }
  return { reported: deliveries.length };
}
