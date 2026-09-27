import { KsaiPtyPilot } from '../../opencode-pty.mjs';
import { asking, v2Tool } from '../tools.mjs';

const ZOD = new URL('../../../vendor/opencode-pty/node_modules/zod/index.js', import.meta.url);

export const ptyAsk = (rules) => asking(rules, { bash: 'shell' });

export const exitNotice = (input) => ({
  sessionID: String(input?.path?.id ?? ''),
  text: (Array.isArray(input?.body?.parts) ? input.body.parts : []).filter((part) => part?.type === 'text').map((part) => String(part.text)).join('\n'),
});

export async function ptyTools(options, directory, deliver, { load = (href) => import(href), pilot = KsaiPtyPilot } = {}) {
  const rules = Array.isArray(options?.permissions) ? options.permissions : [];
  const { z } = await load(ZOD.href);
  const schemaOf = (args) => {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(z.object(args));
    return schema;
  };
  const held = await pilot({ client: { session: { promptAsync: async (input) => deliver(exitNotice(input)) } } });
  const ask = ptyAsk(rules);
  return {
    tools: Object.entries(held.tool).map(([name, definition]) => v2Tool(name, definition, { schemaOf, ask, directory })),
    dispose: held.dispose,
  };
}

export default {
  id: 'ksai.pty',
  async setup(ctx) {
    const directory = String(ctx.location?.directory || process.env.GITHUB_WORKSPACE || '');
    const deliver = async ({ sessionID, text }) => {
      if (!sessionID || !text) return;
      try {
        await ctx.session.synthetic({ sessionID, text, description: 'a PTY session exited', delivery: 'steer' });
      } catch (error) {
        console.error(`::warning::a PTY exit notice did not reach ${sessionID}: ${String(error?.message ?? error).slice(0, 300)}`);
        throw error;
      }
    };
    const { tools, dispose } = await ptyTools(ctx.options, directory, deliver);
    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
    return dispose;
  },
};
