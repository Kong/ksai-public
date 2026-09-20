import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deliveriesAt, governanceOptions, governedRoot, rendererFor, trustedRootAt } from '../governance/anchors.mjs';
import { parityOf, promptRendering, renderThroughControlPlane, reportDeliveries } from '../lib/cp-prompts.mjs';

export async function governedAsk(env, deps = {}) {
  const mode = promptRendering(env);
  if (mode === 'local') return null;
  const at = String(env.REQUEST_FILE ?? '').trim();
  if (!at) throw new Error('a governed ask was given no render request, so nothing could be verified');
  const request = JSON.parse(readFileSync(at, 'utf8'));
  const model = String(env.MODEL ?? '').trim();
  if (request?.model !== model) throw new Error(`the render request names ${String(request?.model)}, and this call asks ${model}`);
  if (mode === 'cp') rendererFor(env.KSAI_CP_ENDPOINT, deps.pinned);
  const root = governedRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const asked = mkdtempSync(join(root, 'ask-'));
  const rendered = await renderThroughControlPlane({ request, dir: join(asked, 'render'), statics: false, env, ...deps });
  if (mode === 'shadow') {
    console.log(`::notice::the control plane rendered ${request.prompt_id} from prompt release ${rendered.version}; this call sends its own`);
    console.log(`::notice::${parityOf(readFileSync(rendered.prompt, 'utf8'), env.PROMPT_FILE)}`);
    return null;
  }
  const report = deliveriesAt(asked);
  const options = governanceOptions({
    endpoint: env.KSAI_CP_ENDPOINT,
    artifacts: rendered.dir,
    report,
    trustedRoot: trustedRootAt(root),
    expect: rendered.expect,
    tools: [],
    arm: rendered.arm,
  }, deps.pinned);
  const { governance } = await import('../governance/governor.mjs');
  const governor = governance(options, env, deps.log ?? (() => {}), 'anthropic');
  governor.arm();
  return {
    prompt: readFileSync(rendered.prompt, 'utf8'),
    governor,
    report: () => reportDeliveries({ files: [report], root: asked, env, ...deps }),
  };
}
