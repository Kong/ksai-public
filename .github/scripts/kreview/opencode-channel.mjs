import { channelQueue } from '../lib/channel-hook.mjs';

export const KsaiRunChannel = async () => {
  const queue = channelQueue(process.env);
  let parent = '';

  const streamOf = (input) => {
    const session = String(input?.sessionID ?? '');
    if (parent === '' && session !== '') parent = session;
    return session === '' || session === parent ? 'main' : session;
  };

  return {
    'tool.execute.before': async (input, _output) => {
      const stream = streamOf(input);
      const answer = queue.answer('PreToolUse', stream, input?.tool);
      if (answer.permissionDecision !== 'deny') return;
      throw new Error(
        [queue.drain(stream), String(answer.permissionDecisionReason ?? 'this run has been asked to stop')]
          .filter(Boolean)
          .join('\n\n'),
      );
    },
    'tool.execute.after': async (input, output) => {
      const stream = streamOf(input);
      queue.answer('PostToolUse', stream, input?.tool);
      if (!queue.holds(stream)) return;
      if (typeof output?.output !== 'string') return;
      output.output = `${output.output}\n\n${queue.drain(stream)}`;
    },
  };
};
