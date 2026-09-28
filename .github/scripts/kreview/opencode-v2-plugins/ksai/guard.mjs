import {
  TOOL_DENIED_ENV,
  TOOL_INJECTION_ENV,
  TOOL_WRAPPER_ENV,
  assertToolPath,
  callerDeniedEnvironment,
  patchPaths,
} from '../../opencode-tool-sandbox.mjs';

const PATH_TOOLS = new Set(['read', 'edit', 'write', 'grep', 'glob']);

export function guard(root, env = process.env) {
  const keep = new Set(TOOL_WRAPPER_ENV);
  return {
    shell(event) {
      for (const name of new Set([...Object.keys(env), ...Object.keys(event.env)])) event.env[name] = keep.has(name) ? env[name] : '';
      for (const name of [...TOOL_DENIED_ENV, ...TOOL_INJECTION_ENV, ...callerDeniedEnvironment(env)]) event.env[name] = '';
    },
    before(event) {
      const input = event.input && typeof event.input === 'object' ? event.input : {};
      if (PATH_TOOLS.has(event.tool)) assertToolPath(typeof input.path === 'string' && input.path ? input.path : root, root);
      if (event.tool === 'patch') for (const path of patchPaths(input.patchText)) assertToolPath(path, root);
    },
  };
}
