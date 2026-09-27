import { isolatedChildTools } from '../../opencode-child-tools-core.mjs';
import { v2Tool } from '../tools.mjs';

export function childTools(options, directory, env = process.env) {
  const rules = Array.isArray(options?.permissions) ? options.permissions : [];
  return Object.entries(isolatedChildTools(env)).map(([name, definition]) => v2Tool(name, definition, { rules, directory }));
}

export default {
  id: 'ksai.child-tools',
  async setup(ctx) {
    const tools = childTools(ctx.options, String(ctx.location?.directory || process.env.GITHUB_WORKSPACE || ''));
    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        editor.remove(tool.name);
        editor.add(tool);
      }
    });
  },
};
