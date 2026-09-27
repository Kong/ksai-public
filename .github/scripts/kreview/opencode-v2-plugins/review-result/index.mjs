import result from '../../review-result.cjs';
import { v2Tool } from '../tools.mjs';

export function reviewResult(env = process.env) {
  const held = result.plugin(env);
  const definition = held.tool[result.TOOL_NAME];
  return {
    tool: v2Tool(result.TOOL_NAME, {
      description: definition.description,
      args: definition.args,
      execute: (input, context) => definition.execute(input, { agent: context.agent, sessionID: context.sessionID }),
    }),
    shell: (event) => held['shell.env'](undefined, { env: event.env }),
    before: () => held['tool.execute.before'](),
    dispose: () => held.dispose(),
  };
}

export default {
  id: 'ksai.review-result',
  async setup(ctx) {
    const hooks = reviewResult();
    await ctx.tool.transform((editor) => editor.add(hooks.tool));
    await ctx.shell.hook('create.before', hooks.shell);
    await ctx.tool.hook('execute.before', hooks.before);
    return hooks.dispose;
  },
};
