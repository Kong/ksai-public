import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GOVERNANCE_PLUGIN } from '../governance/config.mjs';
import { renderThroughControlPlane } from '../lib/cp-prompts.mjs';
import { SINKS, renderRequest } from '../lib/render-request.cjs';
import { REVIEW_TOOLS, optionsOf, rootOf } from './governed-review.mjs';

export function stageRequest({ stage, context, model, mandate }) {
  const timing = { research_seconds: stage?.research_seconds, step_target: stage?.step_target };
  const envelope = { sink: SINKS.review, model };
  if (stage?.kind === 'discovery') {
    const scope = stage.scope ?? null;
    return renderRequest({
      ...envelope,
      promptId: 'runtime.review-discovery',
      inputs: [
        { name: 'context', value: context },
        {
          name: 'stage',
          value: { changed_files_path: scope?.changedFilesPath ?? '', diff_path: scope?.diffPath ?? '', focus: stage.focus, has_scope: scope !== null, scope_id: scope?.id ?? '', ...timing },
        },
      ],
    });
  }
  if (stage?.kind === 'audit') {
    return renderRequest({
      ...envelope,
      promptId: 'runtime.review-findings-audit',
      inputs: [
        { name: 'context', value: context },
        { name: 'stage', value: timing },
        { name: 'auditor_mandate', value: mandate },
        { name: 'candidates', value: stage.candidates },
        { name: 'prior', value: stage.prior },
      ],
    });
  }
  throw new Error(`a review stage of kind ${String(stage?.kind)} has no governed prompt`);
}

function governStage(configFile, options) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const plugin = `file://${GOVERNANCE_PLUGIN}`;
  const governed = (config.plugin ?? []).filter((one) => Array.isArray(one) && one[0] === plugin);
  if (governed.length !== 1) throw new Error(`the opencode config loads the governance plugin ${governed.length} times`);
  config.plugin = config.plugin.map((one) => (Array.isArray(one) && one[0] === plugin ? [plugin, options] : one));
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function governedStages(env, context, deps = {}) {
  const root = rootOf(env);
  const plan = JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8'));
  let sequence = 0;
  return async ({ name, stage }) => {
    sequence += 1;
    const request = stageRequest({ stage, context, model: plan.model, mandate: plan.mandate });
    const rendered = await renderThroughControlPlane({ request, dir: join(root, 'stages', `${sequence}-${name}`), tools: [...REVIEW_TOOLS], limited: true, env, ...deps });
    governStage(env.OPENCODE_CONFIG, optionsOf(env, root, rendered, stage.step_target, deps.pinned));
    return { prompt: readFileSync(rendered.prompt, 'utf8'), sha256: rendered.expect.finalDigest.slice('sha256:'.length) };
  };
}
