import { governance } from '../governor.mjs';
import { TOOL_PREFIX_V2 } from '../release.mjs';

const logged = (level, message, extra) => {
  const reason = extra?.reason ? `: ${extra.reason}` : '';
  console.error(`::${level === 'error' ? 'error' : 'warning'}::${message}${reason}`);
};

export default {
  id: 'ksai.governance',
  async setup(ctx) {
    const governor = governance(ctx.options, process.env, logged, 'anthropic', TOOL_PREFIX_V2);
    const hooks = governor.v2;
    await ctx.session.hook('prompt', hooks.prompt);
    await ctx.session.hook('context', hooks.context);
    await ctx.session.hook('compaction', hooks.compaction);
    await ctx.session.hook('title', hooks.title);
    await ctx.tool.hook('execute.before', hooks.tool);
    await ctx.session.hook('http.request', async (event) => {
      const accepted = governor.guard(await event.request.text());
      event.request = new Request(event.request.url, { method: event.request.method, headers: event.request.headers, body: accepted });
    });
    await ctx.session.hook('http.response', (event) => {
      event.response = governor.follow(event.response);
    });
    await ctx.session.hook('retry', () => governor.failed());
    governor.arm();
  },
};
