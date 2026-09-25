import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import controlPlane from '../lib/control-plane.cjs';

const { mask, reachedFor } = controlPlane;
const wait = (ms) => new Promise((done) => { setTimeout(done, ms); });

export async function reportProviderObservations(env = process.env, fetchImpl = fetch, reach = reachedFor, pause = wait) {
  const root = join(String(env.RUNNER_TEMP ?? ''), 'ksai-provider-observations');
  const files = existsSync(root) ? readdirSync(root).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).sort() : [];
  if (files.length === 0) {
    if (env.MODEL_CONCLUSION === 'success') throw new Error('the model succeeded without a provider-boundary prompt observation');
    return 0;
  }
  const reached = await reach({ env, fetch: fetchImpl, timeout: 10 * 60_000, secret: mask });
  if (reached.why) throw new Error(reached.why);
  for (const file of files) {
    const one = JSON.parse(readFileSync(join(root, file), 'utf8'));
    const body = readFileSync(join(root, `${one.id}.${one.mode === 'cp' ? 'dynamic' : 'body'}`));
    const request = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reached.token}`,
        'content-type': 'application/json',
        'x-ksai-prompt-mode': one.mode,
        'x-ksai-observation-id': one.id,
        'x-ksai-request-digest': one.request_digest,
        'x-ksai-prompt-digest': one.prompt_digest,
        'x-ksai-model': one.model,
        'x-ksai-provider-status': String(one.status),
        'x-ksai-request-bytes': String(one.request_bytes),
      },
      body,
      signal: reached.signal,
    };
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await pause(250 * 2 ** (attempt - 1));
      response = await fetchImpl(`${reached.base}/v1/prompts/observations`, request);
      if (![404, 502, 503].includes(response.status)) break;
    }
    if (!response.ok) throw new Error(`the control plane refused provider observation ${one.id}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = await reportProviderObservations();
    console.log(`reported ${count} provider-boundary prompt observations`);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
