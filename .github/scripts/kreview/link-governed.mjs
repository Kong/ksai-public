import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deliveriesAt, rendererFor, trustedRootAt } from '../governance/anchors.mjs';
import { digest, regularFile } from '../governance/artifacts.mjs';
import { NOTES_ID, TOOL_PREFIX, governedNotes, governedReminder, governedTool, rendered, verifyRelease } from '../governance/release.mjs';
import { certificateTrust, keyTrust, verifyRender } from '../governance/render.mjs';
import { lockedOf } from './cp-prompts.mjs';

export const GOVERNED_CAPABILITY = 'ksai-governed-plugin-v1';
export const GOVERNED_UNDER = 'plugins/ksai-governed/';
export const GOVERNED_ID = 'static.plugin.ksai-governed.';
export const GOVERNED_FILE = 'governed.json';
export const PLUGIN_DIR = 'plugin';
export const PLUGIN_ENTRY = 'index.mjs';
export const LINK_ASKS = Object.freeze({ notes: 'notes', retry: 'retry.sock', context: 'context.sock', carry: 'carry-refused' });

const REMINDER_ID = 'static.runtime.opencode-max-steps';
const PROVIDER = 'anthropic';
const MODULE = /^[a-z][a-z0-9-]*$/;
const TRUSTED_ROOT_BYTES = 1024 * 1024;
const REASON_MOST = 500;

export const sessionDirOf = (root, session) => join(root, 'link', String(session).replace(/[^A-Za-z0-9._-]/g, '_'));

export const pluginEntryOf = (root, session) => join(sessionDirOf(root, session), PLUGIN_DIR, PLUGIN_ENTRY);

export const isGoverned = (one) => one.id.startsWith(GOVERNED_ID) || String(one.destination ?? '').startsWith(GOVERNED_UNDER);

function renderTrust(endpoint, pinned) {
  const renderer = rendererFor(endpoint, pinned);
  return renderer.renderKey ? keyTrust(renderer.renderKey) : certificateTrust(renderer.renderAuthority, renderer.renderSigner);
}

function sameRun(receipt, env) {
  const run = receipt.run;
  const repository = String(env.GITHUB_REPOSITORY ?? '').toLowerCase();
  if (!repository || String(run.repository ?? '').toLowerCase() !== repository || run.run_id !== env.GITHUB_RUN_ID || run.attempt !== env.GITHUB_RUN_ATTEMPT) {
    throw new Error('the render was signed for another run');
  }
}

function moduleOf(one) {
  const name = one.id.startsWith(GOVERNED_ID) ? one.id.slice(GOVERNED_ID.length) : '';
  if (!MODULE.test(name) || one.destination !== `${GOVERNED_UNDER}${name}.mjs`) {
    throw new Error(`${one.id} is laid at ${String(one.destination ?? 'no destination')}, which is not where the governed plugin module of that name goes`);
  }
  return { name: `${name}.mjs`, body: one.body };
}

function modulesOf(plan, version, locked) {
  const ids = new Set();
  const destinations = new Set();
  const modules = [];
  for (const one of plan.statics) {
    if (ids.has(one.id)) throw new Error(`the plan carries ${one.id} twice`);
    ids.add(one.id);
    const entry = locked.get(one.id);
    if (!entry || entry.dynamic === true || entry.body_digest !== digest(Buffer.from(one.body, 'utf8'))) {
      throw new Error(`${one.id} is not the body prompt release ${version} attests`);
    }
    if (one.destination !== undefined) {
      if (!(entry.destinations ?? []).includes(one.destination)) throw new Error(`prompt release ${version} does not lay ${one.id} at ${one.destination}`);
      if (destinations.has(one.destination)) throw new Error(`the plan lays ${one.destination} twice`);
      destinations.add(one.destination);
    }
    if (isGoverned(one)) modules.push(moduleOf(one));
  }
  if (!modules.some((one) => one.name === PLUGIN_ENTRY)) throw new Error(`the plan carries no ${GOVERNED_UNDER}${PLUGIN_ENTRY}, so no governed plugin could run the session`);
  return modules;
}

function bodyOf(plan, id) {
  const one = plan.statics.find((held) => held.id === id);
  if (!one) throw new Error(`the plan carries no ${id}`);
  return Buffer.from(one.body, 'utf8');
}

function openingOf(plan, carried, receipt, trust, predicate, env) {
  if (!carried) return plan.prompt.text;
  const original = plan.resume?.original;
  if (typeof original?.text !== 'string' || !original.text) throw new Error('the plan carries a history and no render it opened on');
  const prior = verifyRender(Buffer.from(JSON.stringify(original.bundle ?? null)), Buffer.from(original.text, 'utf8'), trust, predicate);
  if (prior.final_digest !== carried.original || prior.model !== receipt.model || String(prior.run?.repository ?? '').toLowerCase() !== String(env.GITHUB_REPOSITORY ?? '').toLowerCase()) {
    throw new Error('the carried render is not the one its history was governed by');
  }
  return original.text;
}

export function verifiedPlan(plan, { env, endpoint, pinned, governedDir, asked, carried = null, release = verifyRelease }) {
  const trust = renderTrust(endpoint, pinned);
  const receipt = verifyRender(Buffer.from(JSON.stringify(plan.prompt.bundle ?? null)), Buffer.from(plan.prompt.text, 'utf8'), trust, pinned.renderPredicate);
  sameRun(receipt, env);
  if (receipt.prompt_id !== asked.promptId || receipt.sink !== asked.sink || receipt.model !== plan.model.id) {
    throw new Error(`the render is ${receipt.prompt_id} for ${receipt.sink} on ${String(receipt.model)}, and the session asked for ${asked.promptId} for ${asked.sink} on ${plan.model.id}`);
  }
  const lock = Buffer.from(plan.prompt.catalog.lock, 'base64');
  const attested = release(Buffer.from(plan.prompt.catalog.attestation, 'base64'), lock, {
    trustedRoot: JSON.parse(regularFile(trustedRootAt(governedDir), TRUSTED_ROOT_BYTES).toString('utf8')),
    signer: pinned.releaseSigner,
    issuer: pinned.releaseIssuer,
    minimum: pinned.minimum,
    revoked: pinned.revoked ?? [],
  });
  if (attested.version !== plan.prompt.catalog.version) throw new Error(`the lock is prompt release ${attested.version}, and the plan names ${plan.prompt.catalog.version}`);
  rendered(attested, receipt);
  const modules = modulesOf(plan, attested.version, lockedOf(lock, attested.version));
  const tools = Object.fromEntries(plan.tools.map((name) => {
    const tool = governedTool(attested, name, bodyOf(plan, `${TOOL_PREFIX}${name}`), TOOL_PREFIX);
    return [name, { description: tool.description, input_schema: tool.input_schema }];
  }));
  return {
    receipt,
    version: attested.version,
    modules,
    tools,
    limit: plan.steps > 0 ? { steps: plan.steps, reminder: governedReminder(attested, bodyOf(plan, REMINDER_ID)) } : null,
    notes: governedNotes(attested, bodyOf(plan, NOTES_ID)),
    carried,
    opens: openingOf(plan, carried, receipt, trust, pinned.renderPredicate, env),
  };
}

function readOnly(at, body) {
  const laid = `${at}.${process.pid}.laid`;
  rmSync(laid, { force: true });
  writeFileSync(laid, body, { mode: 0o400 });
  renameSync(laid, at);
}

export function layGovernedPlugin(dir, plan, verified, { workspace, link, flow = '', content = {} }) {
  const at = join(dir, PLUGIN_DIR);
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true, mode: 0o700 });
  for (const one of verified.modules) readOnly(join(at, one.name), one.body);
  const { receipt } = verified;
  readOnly(join(dir, GOVERNED_FILE), JSON.stringify({
    version: 1,
    provider: PROVIDER,
    model: receipt.model,
    prompt: plan.prompt.text,
    opens: verified.opens,
    tools: verified.tools,
    limit: verified.limit,
    notes: verified.notes,
    carried: verified.carried,
    receipt: {
      prompt_id: receipt.prompt_id, prompt_version: receipt.prompt_version, sink: receipt.sink, final_digest: receipt.final_digest, catalog_digest: receipt.catalog_digest,
    },
    catalog_version: verified.version,
    directory: workspace,
    flow,
    nonce: plan.nonce,
    notes_dir: join(link, LINK_ASKS.notes),
    retry: join(link, LINK_ASKS.retry),
    context: join(link, LINK_ASKS.context),
    carry_refusal: verified.carried ? join(link, LINK_ASKS.carry) : null,
  }));
  readOnly(join(dir, 'model.json'), JSON.stringify(plan.model));
  readOnly(join(dir, 'shell.json'), JSON.stringify({ timeout_ms: plan.shell_timeout_ms }));
  readOnly(join(dir, 'content.json'), JSON.stringify(plan.guard ? { ...content, required: plan.guard.required === true } : {}));
  return join(at, PLUGIN_ENTRY);
}

const clipped = (value) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, REASON_MOST).join('');

export function deliveryReport(root, verified = null) {
  const said = verified
    ? {
      prompt_id: verified.receipt.prompt_id, prompt_version: verified.receipt.prompt_version, sink: verified.receipt.sink,
      final_digest: verified.receipt.final_digest, catalog_version: verified.version, catalog_digest: verified.receipt.catalog_digest,
    }
    : {};
  return (outcome, why = '') => {
    try {
      appendFileSync(deliveriesAt(root), `${JSON.stringify({ outcome, ...said, ...(why ? { reason: clipped(why) } : {}) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.log(`::warning::a ${outcome} prompt delivery could not be kept for the run to report: ${clipped(error?.message ?? error)}`);
    }
  };
}
