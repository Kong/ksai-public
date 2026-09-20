import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { promptRendering } from '../lib/cp-prompts.mjs';
import { renderFlow } from './governed-flow.mjs';
import { renderAudit, renderReview } from './governed-review.mjs';

const RENDERS = { review: renderReview, audit: renderAudit, flow: renderFlow };

async function main(argv, env) {
  const render = RENDERS[argv[0]];
  if (!render) throw new Error(`usage: governed-render.mjs ${Object.keys(RENDERS).join('|')}`);
  const said = await render(env);
  if (said.shadow) {
    console.log(`::notice::the control plane rendered this ${argv[0]}'s prompt from prompt release ${said.shadow}; this run sends its own`);
    console.log(`::notice::${said.parity}`);
  }
  if (said.version) console.log(`the control plane rendered this ${argv[0]} from prompt release ${said.version}`);
  writeOutputs(env.GITHUB_OUTPUT, {
    prompt_file: said.prompt_file ?? '',
    options_file: said.options_file ?? '',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shadow = promptRendering(process.env) === 'shadow';
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.log(`::${shadow ? 'warning' : 'error'}::${error.message}`);
    if (!shadow) process.exitCode = 1;
  }
}
