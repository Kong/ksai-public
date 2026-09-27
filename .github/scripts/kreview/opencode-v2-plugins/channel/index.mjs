import { channelQueue } from '../../../lib/channel-hook.mjs';

export function channel(env, parentOf) {
  const queue = channelQueue(env);
  const streams = new Map();

  const streamOf = async (sessionID) => {
    const id = String(sessionID ?? '');
    if (id === '') return 'main';
    if (!streams.has(id)) streams.set(id, Promise.resolve(parentOf(id)).then((parent) => (parent ? id : 'main'), () => 'main'));
    return streams.get(id);
  };

  return {
    async before(event) {
      const stream = await streamOf(event.sessionID);
      const answer = queue.answer('PreToolUse', stream, String(event.tool ?? ''));
      if (answer.permissionDecision !== 'deny') return;
      throw new Error(
        [queue.drain(stream), String(answer.permissionDecisionReason ?? 'this run has been asked to stop')].filter(Boolean).join('\n\n'),
      );
    },
    async after(event) {
      const stream = await streamOf(event.sessionID);
      queue.answer('PostToolUse', stream, String(event.tool ?? ''));
      if (!queue.holds(stream) || event.status !== 'completed') return;
      const content = event.result?.content;
      const texts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      event.result = { ...event.result, content: [...texts, { type: 'text', text: queue.drain(stream) }] };
    },
  };
}

export default {
  id: 'ksai.channel',
  async setup(ctx) {
    const hooks = channel(process.env, async (sessionID) => (await ctx.session.get({ sessionID }))?.parentID);
    await ctx.tool.hook('execute.before', hooks.before);
    await ctx.tool.hook('execute.after', hooks.after);
  },
};
