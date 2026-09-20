import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { deliveriesAt, governanceOptions, governedRoot, rendererFor, trustedRootAt } from '../governance/anchors.mjs';
import { parityOf, promptRendering, renderThroughControlPlane } from '../lib/cp-prompts.mjs';
import { opencodePermissions } from '../lib/opencode.mjs';

const GOVERNED_TOOLS = Object.freeze(['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'write']);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PLUGIN = /^[a-z][a-z0-9-]{0,63}$/;

export function governedTools(env) {
  const permission = opencodePermissions({ allowed: env.OPENCODE_ALLOWED, disallowed: env.OPENCODE_DISALLOWED });
  return GOVERNED_TOOLS.filter((name) =>
    name === 'bash' ? Object.values(permission.bash ?? {}).includes('allow') : permission[name] === 'allow');
}

function laidDown(dir, files, plugin) {
  if (!PLUGIN.test(plugin)) throw new Error(`${plugin} is not a plugin name`);
  const prefix = `plugins/${plugin}/`;
  const kept = files.filter((file) => file.destination.startsWith(prefix));
  if (!kept.length) throw new Error(`the prompt release carries no ${plugin} plugin files`);
  for (const file of kept) {
    if (isAbsolute(file.destination) || file.destination.split('/').includes('..')) {
      throw new Error(`the prompt release names ${file.destination}, which is not a path under the release`);
    }
    const at = join(dir, file.destination);
    mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
    writeFileSync(at, file.body, { mode: 0o600 });
  }
  return join(dir, 'plugins', plugin);
}

export async function renderFlow(env, deps = {}) {
  const mode = promptRendering(env);
  if (mode === 'local') return {};
  const at = String(env.REQUEST_FILE ?? '').trim();
  if (!at) throw new Error('a governed run was asked to render with no request, so nothing could be verified');
  const name = String(env.GOVERNED_NAME ?? '').trim();
  if (!NAME.test(name)) throw new Error(`a governed run names itself in one word, and this one is ${name || '(empty)'}`);
  const request = JSON.parse(readFileSync(at, 'utf8'));
  if (mode === 'cp') rendererFor(env.KSAI_CP_ENDPOINT, deps.pinned);
  const tools = governedTools(env);
  const root = governedRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rendered = await renderThroughControlPlane({ request, dir: join(root, name), tools, limited: false, env, ...deps });
  if (mode === 'shadow') {
    return { shadow: `${rendered.version}${rendered.arm ? ` (${rendered.arm})` : ''}`, parity: parityOf(readFileSync(rendered.prompt, 'utf8'), env.PROMPT_FILE) };
  }
  const plugin = String(env.GOVERNED_PLUGIN ?? '').trim();
  const options = governanceOptions({
    endpoint: env.KSAI_CP_ENDPOINT,
    artifacts: rendered.dir,
    report: deliveriesAt(root),
    trustedRoot: trustedRootAt(root),
    expect: rendered.expect,
    tools,
    arm: rendered.arm,
  }, deps.pinned);
  const file = join(root, `${name}.options.json`);
  writeFileSync(file, JSON.stringify(options), { mode: 0o600 });
  if (plugin) laidDown(join(root, name), rendered.files, plugin);
  return { prompt_file: rendered.prompt, options_file: file, version: rendered.version };
}
