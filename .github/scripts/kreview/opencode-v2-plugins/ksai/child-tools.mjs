import { isolatedChildTools } from '../../opencode-child-tools-core.mjs';
import { v2Tool } from './tools.mjs';

export function childTools(options, directory, env = process.env) {
  const rules = Array.isArray(options?.permissions) ? options.permissions : [];
  return Object.entries(isolatedChildTools(env)).map(([name, definition]) => v2Tool(name, definition, { rules, directory }));
}

export async function offerChildTools(ctx, options, directory) {
  const tools = childTools(options, directory);
  await ctx.tool.transform((editor) => {
    for (const tool of tools) {
      editor.remove(tool.name);
      editor.add(tool);
    }
  });
}
