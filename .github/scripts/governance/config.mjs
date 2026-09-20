import { fileURLToPath } from 'node:url';

import { runtimeConfig } from '../lib/opencode.mjs';

export const GOVERNANCE_PLUGIN = fileURLToPath(new URL('./opencode-plugin.mjs', import.meta.url));

const KEPT = new Set(['*', 'external_directory']);

function governedPermission(permission, tools) {
  const governed = { ...permission, '*': 'deny', task: 'deny' };
  for (const key of Object.keys(governed)) {
    if (!KEPT.has(key) && !tools.has(key)) governed[key] = 'deny';
  }
  for (const name of tools) governed[name] ??= 'allow';
  return governed;
}

export function governedConfig({ governance, permission = { '*': 'deny' }, agent = 'build', skills = [], guards = [], ...runtime }) {
  const tools = new Set(governance.tools ?? []);
  const config = runtimeConfig({
    ...runtime,
    agents: {},
    skills: tools.has('skill') ? skills : [],
    permission: governedPermission(permission, tools),
    plugins: [...guards, [GOVERNANCE_PLUGIN, governance]],
  });
  config.compaction = { auto: false, prune: false };
  if (governance.steps !== undefined) config.agent = { [agent]: { mode: 'primary', steps: governance.steps } };
  return config;
}
