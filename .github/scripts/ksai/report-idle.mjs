import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { mask } = require('../lib/control-plane.cjs');

const IDLE = Object.freeze(['approve', 'resume', 'held']);

export async function reportIdle({ ask, env = process.env, command = '', job = '', ...asking }) {
  const idle = String(command ?? '').trim().toLowerCase();
  if (!IDLE.includes(idle)) return { reported: false, why: `${JSON.stringify(command)} is not a way a run ends with nothing to do` };
  try {
    await ask({
      endpoint: String(env.KSAI_CP_ENDPOINT ?? '').trim(),
      path: '/run/no-work',
      body: { authorized: false, job: String(job ?? ''), idle },
      env,
      ...asking,
    });
    return { reported: true, why: '' };
  } catch (error) {
    return { reported: false, why: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const { ask } = await import(new URL('../run-token/token.mjs', import.meta.url).href);
  const said = await reportIdle({ ask, command: process.env.IDLE_COMMAND, job: process.env.JOB, secret: mask });
  const what = process.env.IDLE_COMMAND === 'held' ? 'this run held every thread' : `this ${process.env.IDLE_COMMAND} released nothing`;
  if (said.reported) {
    process.stdout.write(`ksai told the control plane ${what}\n`);
    return;
  }
  process.stdout.write(`::warning::ksai could not tell the control plane ${what}, so its task may read as failed: ${said.why}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
