import {
  TOOL_DENIED_ENV,
  TOOL_INJECTION_ENV,
  TOOL_WRAPPER_ENV,
  assertToolPath,
  callerDeniedEnvironment,
  patchPaths,
} from './opencode-tool-sandbox.mjs';

export const KsaiToolGuard = async ({ directory, worktree }) => {
  const root = String(worktree || directory || process.env.GITHUB_WORKSPACE || '');
  const pathFor = (args) => args?.filePath ?? args?.path ?? root;
  return {
    'shell.env': async (_input, output) => {
      const keep = new Set(TOOL_WRAPPER_ENV);
      for (const name of Object.keys(process.env)) output.env[name] = keep.has(name) ? process.env[name] : '';
      for (const name of [...TOOL_DENIED_ENV, ...TOOL_INJECTION_ENV, ...callerDeniedEnvironment()]) output.env[name] = '';
    },
    'tool.execute.before': async (input, output) => {
      const tool = String(input?.tool ?? '');
      if (['read', 'edit', 'write', 'grep', 'glob'].includes(tool)) {
        assertToolPath(pathFor(output?.args), root);
      }
      if (tool === 'apply_patch') {
        for (const path of patchPaths(output?.args?.patchText)) assertToolPath(path, root);
      }
    },
  };
};
