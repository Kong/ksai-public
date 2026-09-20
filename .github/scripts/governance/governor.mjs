import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { DIGEST, readArtifacts, regularFile } from './artifacts.mjs';
import { IncompleteAnswer, MAX_RESPONSE_BYTES, UpstreamFailure, conversation } from './conversation.mjs';
import { Errand, governRequest } from './provider.mjs';
import { governedReminder, governedTool, rendered, verifyRelease, versionParts } from './release.mjs';
import { certificateTrust, keyTrust, verifyRender } from './render.mjs';

export const GOVERNED_HOOKS = Object.freeze([
  'chat.message',
  'experimental.chat.messages.transform',
  'experimental.chat.system.transform',
  'tool.execute.before',
  'experimental.session.compacting',
]);

const KEEPALIVE_MS = 15_000;
const KEEPALIVE = new TextEncoder().encode(': validating\n\n');
const STALL_MS = 300_000;
const TRUSTED_ROOT_BYTES = 1024 * 1024;
const MAX_REASON = 512;
const MAX_REFUSALS = 16;
const MAX_STEPS = 256;

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
  if (given.steps !== undefined && (!Number.isSafeInteger(given.steps) || given.steps < 1 || given.steps > MAX_STEPS)) {
    throw new Error(`governance.steps is not a step limit from 1 to ${MAX_STEPS}`);
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

function verified(given, env) {
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
  for (const name of given.tools ?? []) tools.set(name, governedTool(release, name, artifacts.tool(name)));
  const limit = given.steps === undefined ? null : { steps: given.steps, reminder: governedReminder(release, artifacts.reminder()) };
  return {
    governed: { prompt: artifacts.prompt.toString('utf8'), model: receipt.model, tools, limit },
    receipt,
    version: release.version,
  };
}

function reason(error) {
  let said = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  while (Buffer.byteLength(said) > MAX_REASON) said = said.slice(0, -1);
  return said || 'refused';
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
    guard() {
      throw new Error(`prompt governance refused this run: ${said}`);
    },
    follow: (response) => response,
    failed() {},
    arm() {},
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

function governing(state, given, report, provider) {
  const { governed, receipt, version } = state;
  const talk = conversation(governed.prompt, governed.model, [...governed.tools.keys()], governed.limit);
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
      'experimental.chat.system.transform': async (input, output) => {
        return guarded(() => {
          onProvider(input);
          if (!Array.isArray(output?.system)) throw new Error('the system context is unavailable');
          output.system.splice(0);
        }, false);
      },
      'tool.execute.before': async (input) =>
        guarded(() => {
          const tool = String(input?.tool ?? '');
          if (tool.toLowerCase() === 'task') throw new Error('task delegation was attempted');
          if (!governed.tools.has(tool)) throw new Error(`the ${tool} tool is not governed`);
        }),
      'experimental.session.compacting': async () =>
        guarded(() => {
          throw new Error('context compaction was attempted');
        }),
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
  };
}

export function governance(raw, env, log, provider, report = reporter(raw, log)) {
  let given;
  try {
    given = options(raw);
  } catch (error) {
    return refusing(reason(error), report);
  }
  try {
    return governing(verified(given, env), given, report, provider);
  } catch (error) {
    log('error', 'prompt governance refused this run', { reason: reason(error) });
    return refusing(reason(error), report);
  }
}
