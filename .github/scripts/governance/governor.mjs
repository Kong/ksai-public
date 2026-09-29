import { appendFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { DIGEST, readArtifacts, regularFile } from './artifacts.mjs';
import { CarryRefused, IncompleteAnswer, MAX_RESPONSE_BYTES, UpstreamFailure, boundedSteps, carriedOf, conversation } from './conversation.mjs';
import { Errand, governRequest } from './provider.mjs';
import { linkNotes } from './notes.mjs';
import { TOOL_PREFIX, governedNotes, governedReminder, governedTool, rendered, verifyRelease, versionParts } from './release.mjs';
import { certificateTrust, keyTrust, verifyRender } from './render.mjs';

export const GOVERNED_HOOKS = Object.freeze([
  'chat.message',
  'experimental.chat.messages.transform',
  'experimental.chat.system.transform',
  'tool.execute.before',
  'experimental.session.compacting',
]);

export const GOVERNED_HOOKS_V2 = Object.freeze(['prompt', 'context', 'tool', 'compaction', 'title']);

const KEEPALIVE_MS = 15_000;
const KEEPALIVE = new TextEncoder().encode(': validating\n\n');
const STALL_MS = 300_000;
const TRUSTED_ROOT_BYTES = 1024 * 1024;
const MAX_REASON = 512;
const MAX_REFUSALS = 16;
const DELEGATION = new Set(['task', 'subagent']);

function options(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('governance options are not an object');
  const given = raw;
  if (typeof given.artifacts !== 'string' || !isAbsolute(given.artifacts)) throw new Error('governance.artifacts names no absolute directory');
  if (typeof given.trustedRoot !== 'string' || !isAbsolute(given.trustedRoot)) throw new Error('governance.trustedRoot names no absolute file');
  if (typeof given.report !== 'string' || !isAbsolute(given.report)) throw new Error('governance.report names no absolute file');
  const expected = given.expect;
  if (
    expected === null ||
    typeof expected !== 'object' ||
    [expected.promptId, expected.sink, expected.model].some((one) => typeof one !== 'string' || !one) ||
    typeof expected.finalDigest !== 'string' ||
    !DIGEST.test(expected.finalDigest)
  ) {
    throw new Error('governance.expect names the prompt id, sink, model and final digest the runner rendered');
  }
  if (expected.steps !== undefined) boundedSteps(expected.steps, 'governance.expect.steps');
  carriedOf(expected.carried);
  if (typeof given.releaseSigner !== 'string' || !given.releaseSigner) throw new Error('governance.releaseSigner names no workflow');
  if (typeof given.releaseIssuer !== 'string' || !given.releaseIssuer) throw new Error('governance.releaseIssuer names no token issuer');
  if (typeof given.renderPredicate !== 'string' || !given.renderPredicate) throw new Error('governance.renderPredicate names no receipt type');
  if (Boolean(given.renderKey) === Boolean(given.renderAuthority)) {
    throw new Error('governance names exactly one of renderKey or renderAuthority');
  }
  if (given.renderAuthority && !given.renderSigner) throw new Error('governance.renderAuthority is trusted only with renderSigner');
  if (given.minimum !== undefined) versionParts(given.minimum);
  if (given.revoked !== undefined) {
    if (!Array.isArray(given.revoked)) throw new Error('governance.revoked holds something other than release versions');
    given.revoked.forEach((one) => versionParts(one));
  }
  if (given.tools !== undefined && (!Array.isArray(given.tools) || new Set(given.tools).size !== given.tools.length)) {
    throw new Error('governance.tools is not a list of distinct tool names');
  }
  if (given.steps !== undefined) boundedSteps(given.steps, 'governance.steps');
  if (given.notes !== undefined) {
    if (typeof given.notes !== 'string' || !isAbsolute(given.notes)) throw new Error('governance.notes names no absolute directory');
    if (typeof given.nonce !== 'string' || !/^[0-9a-f]{16}$/.test(given.nonce)) throw new Error('governance.nonce is not the run channel nonce');
  }
  return given;
}

function renderTrust(given) {
  return given.renderKey ? keyTrust(given.renderKey) : certificateTrust(given.renderAuthority, given.renderSigner);
}

function sameRun(receipt, env) {
  const run = receipt.run;
  if (
    !env.GITHUB_REPOSITORY ||
    run.repository?.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase() ||
    run.run_id !== env.GITHUB_RUN_ID ||
    run.attempt !== env.GITHUB_RUN_ATTEMPT
  ) {
    throw new Error('the render was signed for another run');
  }
}

function verified(given, env, toolPrefix) {
  const artifacts = readArtifacts(given.artifacts);
  const receipt = verifyRender(artifacts.render, artifacts.prompt, renderTrust(given), given.renderPredicate);
  sameRun(receipt, env);
  const expected = given.expect;
  if (
    receipt.prompt_id !== expected.promptId ||
    receipt.sink !== expected.sink ||
    receipt.model !== expected.model ||
    receipt.final_digest !== expected.finalDigest
  ) {
    throw new Error('the render is not the one the runner asked for');
  }
  const release = verifyRelease(artifacts.attestation, artifacts.lock, {
    trustedRoot: JSON.parse(regularFile(given.trustedRoot, TRUSTED_ROOT_BYTES).toString('utf8')),
    signer: given.releaseSigner,
    issuer: given.releaseIssuer,
    minimum: given.minimum,
    revoked: given.revoked,
  });
  rendered(release, receipt);
  const tools = new Map();
  for (const name of given.tools ?? []) tools.set(name, governedTool(release, name, artifacts.tool(name), toolPrefix));
  const limit = expected.steps === undefined ? null : { steps: expected.steps, reminder: governedReminder(release, artifacts.reminder()) };
  const notes = given.notes === undefined ? null : governedNotes(release, artifacts.notes());
  const carried = carriedOf(expected.carried);
  const prompt = artifacts.prompt.toString('utf8');
  let opens = prompt;
  if (carried) {
    const original = artifacts.original();
    const prior = verifyRender(artifacts.originalRender(), original, renderTrust(given), given.renderPredicate);
    if (prior.final_digest !== carried.original || prior.model !== receipt.model || prior.run.repository?.toLowerCase() !== env.GITHUB_REPOSITORY?.toLowerCase()) {
      throw new CarryRefused('the carried render is not the one its history was governed by');
    }
    opens = original.toString('utf8');
  }
  return {
    governed: { prompt, opens, model: receipt.model, tools, limit, notes, carried },
    receipt,
    version: release.version,
  };
}

function reason(error) {
  let said = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  while (Buffer.byteLength(said) > MAX_REASON) said = said.slice(0, -1);
  return said || 'refused';
}

function carryRefused(given, text, log) {
  if (typeof given?.carryRefusal !== 'string' || !isAbsolute(given.carryRefusal)) return;
  try {
    writeFileSync(given.carryRefusal, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') log('warn', 'could not keep the refused carry for the link party to report', { reason: reason(error) });
  }
}

export function reporter(given, log) {
  return (delivery) => {
    if (typeof given?.report !== 'string' || !isAbsolute(given.report)) return;
    try {
      appendFileSync(given.report, `${JSON.stringify(delivery)}\n`, { flag: 'a', mode: 0o600 });
    } catch (error) {
      log('warn', 'could not keep a prompt delivery for the runner to report', { reason: reason(error) });
    }
  };
}

function refusing(said, report) {
  report({ outcome: 'refused', reason: said });
  const refuse = async () => {
    throw new Error(`prompt governance refused this run: ${said}`);
  };
  return {
    hooks: Object.fromEntries(GOVERNED_HOOKS.map((name) => [name, refuse])),
    v2: Object.fromEntries(GOVERNED_HOOKS_V2.map((name) => [name, refuse])),
    guard() {
      throw new Error(`prompt governance refused this run: ${said}`);
    },
    follow: (response) => response,
    failed() {},
    arm() {},
    offered: () => null,
  };
}

function onePart(parts) {
  if (!Array.isArray(parts) || parts.length !== 1) throw new Error('the prompt is not exactly one part');
  const part = parts[0];
  if (part?.synthetic === true || part?.type !== 'text' || typeof part?.text !== 'string') {
    throw new Error('the prompt is not one owned text part');
  }
  return part.text;
}

function onlyText(content) {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const part = content[0];
  return part?.type === 'text' && typeof part.text === 'string' ? part.text : null;
}

async function buffered(reader) {
  const chunks = [];
  let size = 0;
  const next = async () => {
    let timer;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the answer stalled')), STALL_MS);
    });
    try {
      return await Promise.race([reader.read(), stalled]);
    } catch (error) {
      reader.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  for (let read = await next(); !read.done; read = await next()) {
    size += read.value.byteLength;
    chunks.push(read.value);
    if (size > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks, size);
}

function governing(state, given, report, provider, log) {
  const { governed, receipt, version } = state;
  const talk = conversation(governed.prompt, governed.model, [...governed.tools.keys()], governed.limit, governed.carried);
  const directives = governed.notes
    ? linkNotes({ dir: given.notes, notes: governed.notes, nonce: given.nonce, flow: String(given.flow ?? '') }, { warn: (said) => log('warn', said) })
    : null;
  const refusals = new Set();
  let broken = '';
  let messaged = false;
  let delivered = false;
  let armed = false;
  const said = (outcome, why) => ({
    outcome,
    prompt_id: receipt.prompt_id,
    prompt_version: receipt.prompt_version,
    sink: receipt.sink,
    final_digest: receipt.final_digest,
    catalog_version: version,
    catalog_digest: receipt.catalog_digest,
    ...(given.arm ? { arm: given.arm } : {}),
    ...(why ? { reason: why } : {}),
  });
  const refuse = (why, breaks) => {
    const text = reason(why);
    if (breaks) broken ||= text;
    if (why instanceof CarryRefused) carryRefused(given, text, log);
    if (!refusals.has(text) && refusals.size < MAX_REFUSALS) {
      refusals.add(text);
      report(said('refused', text));
    }
    throw new Error(`prompt governance refused the call: ${text}`);
  };
  const onProvider = (input) => {
    if (input?.model?.providerID !== undefined && input.model.providerID !== provider) {
      throw new Error(`the prompt was sent to ${String(input.model.providerID)}, not the governed provider`);
    }
    if (input?.model?.modelID !== undefined && input.model.modelID !== governed.model) {
      throw new Error(`the prompt was sent to ${String(input.model.modelID)}, and the render was for ${governed.model}`);
    }
  };
  const sealed = () => {
    if (broken) throw new Error(`prompt governance refused the call: ${broken}`);
  };
  const guarded = (work, breaks = true) => {
    sealed();
    try {
      return work();
    } catch (error) {
      return refuse(error, breaks);
    }
  };
  const clearedSystem = (sent, system) =>
    guarded(() => {
      onProvider(sent);
      if (!Array.isArray(system)) throw new Error('the system context is unavailable');
      system.splice(0);
    }, false);
  const governedCall = async (event) =>
    guarded(() => {
      const tool = String(event?.tool ?? '');
      if (DELEGATION.has(tool.toLowerCase())) throw new Error(`${tool.toLowerCase()} delegation was attempted`);
      if (!governed.tools.has(tool)) throw new Error(`the ${tool} tool is not governed`);
    });
  const compacting = async () =>
    guarded(() => {
      throw new Error('context compaction was attempted');
    });
  return {
    hooks: {
      'chat.message': async (input, output) =>
        guarded(() => {
          if (!armed) throw new Error("the provider's guarded fetch was never installed, so nothing would check what leaves");
          onProvider(input);
          if (messaged) throw new Error('a second top-level prompt was submitted');
          if (onePart(output?.parts) !== governed.prompt) throw new Error('the top-level prompt is not the governed one');
          messaged = true;
        }),
      'experimental.chat.messages.transform': async (_input, output) =>
        guarded(() => {
          const [first, ...rest] = Array.isArray(output?.messages) ? output.messages : [];
          if (first?.info?.role !== 'user' || onePart(first.parts) !== governed.prompt) {
            throw new Error('the conversation lost the governed prompt');
          }
          if (rest.some((entry) => entry?.info?.role !== 'assistant')) {
            throw new Error('the conversation holds a turn after the prompt that the model did not take');
          }
        }),
      'experimental.chat.system.transform': async (input, output) => clearedSystem(input, output?.system),
      'tool.execute.before': governedCall,
      'experimental.session.compacting': compacting,
    },
    v2: {
      prompt: async (event) =>
        guarded(() => {
          if (!armed) throw new Error("the provider's request hook was never installed, so nothing would check what leaves");
          if (messaged) throw new Error('a second top-level prompt was submitted');
          const prompt = event?.prompt;
          if (typeof prompt?.text !== 'string' || (Array.isArray(prompt.files) && prompt.files.length > 0) || prompt.text !== governed.prompt) {
            throw new Error('the top-level prompt is not the governed one');
          }
          messaged = true;
        }),
      context: async (event) => {
        clearedSystem({ model: { providerID: event?.model?.providerID, modelID: event?.model?.id } }, event?.system);
        return guarded(() => {
          const [first, ...rest] = Array.isArray(event?.messages) ? event.messages : [];
          if (first?.role !== 'user' || onlyText(first.content) !== governed.opens) throw new Error('the conversation lost the governed prompt');
          const asked = rest.filter((entry) => entry?.role === 'user');
          if (governed.carried && (asked.length !== 1 || onlyText(asked[0].content) !== governed.prompt)) {
            throw new CarryRefused('the carried conversation does not go on with its render alone');
          }
          if (rest.some((entry) => entry?.role !== 'assistant' && entry?.role !== 'tool' && !(governed.carried && entry === asked[0]))) {
            throw new Error('the conversation holds a turn after the prompt that the model did not take');
          }
        });
      },
      tool: async (event) => {
        const held = directives?.held();
        if (held) throw new Error(held);
        return governedCall(event);
      },
      after: async (event) => {
        if (!directives || event?.status !== 'completed') return;
        const drained = directives.drain();
        if (!drained) return;
        const content = event.result?.content;
        const texts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
        event.result = { ...event.result, content: [...texts, { type: 'text', text: drained }] };
      },
      compaction: compacting,
      title: async (event) => {
        event.result = 'ksai';
      },
    },
    guard(body) {
      sealed();
      try {
        if (typeof body !== 'string') throw new Error('the provider request body is not JSON text');
        return governRequest(body, governed, talk);
      } catch (error) {
        if (error instanceof Errand) throw new Error(`prompt governance refused the call: ${reason(error)}`, { cause: error });
        return refuse(error, false);
      }
    },
    follow(response) {
      if (!response.ok || !response.body) {
        talk.failed();
        return response;
      }
      sealed();
      const upstream = response.body.getReader();
      let beat;
      const checked = new ReadableStream({
        async start(controller) {
          beat = setInterval(() => controller.enqueue(KEEPALIVE), KEEPALIVE_MS);
          try {
            let bytes;
            try {
              bytes = await buffered(upstream);
            } catch (error) {
              talk.failed();
              throw error;
            }
            try {
              talk.response(bytes);
            } catch (error) {
              if (!(error instanceof UpstreamFailure) && !(error instanceof IncompleteAnswer)) refuse(error, true);
              talk.failed();
              throw error;
            }
            if (!delivered) {
              delivered = true;
              report(said('delivered'));
            }
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            clearInterval(beat);
          }
        },
        cancel() {
          clearInterval(beat);
          upstream.cancel().catch(() => {});
        },
      });
      return new Response(checked, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    failed() {
      talk.failed();
    },
    arm() {
      armed = true;
    },
    offered: (name) => governed.tools.get(name) ?? null,
  };
}

export function governance(raw, env, log, provider, toolPrefix = TOOL_PREFIX, report = reporter(raw, log)) {
  let given;
  try {
    given = options(raw);
  } catch (error) {
    return refusing(reason(error), report);
  }
  try {
    return governing(verified(given, env, toolPrefix), given, report, provider, log);
  } catch (error) {
    log('error', 'prompt governance refused this run', { reason: reason(error) });
    if (error instanceof CarryRefused) carryRefused(given, reason(error), log);
    return refusing(reason(error), report);
  }
}
