import { main } from '../lib/channel-hook.mjs';

export const KsaiRunChannel = async () => {
  const argv = [
    process.env.KSAI_CHANNEL_DIR ?? '',
    process.env.KSAI_CHANNEL_KILL_AT ?? '0',
    process.env.KSAI_CHANNEL_ARMED_AT ?? '0',
    process.env.KSAI_CHANNEL_FLOW ?? 'unknown',
    process.env.KSAI_CHANNEL_NONCE ?? 'none',
    process.env.KSAI_CHANNEL_WARN ?? '0',
  ];

  const held = new Map();
  let parent = '';

  const streamOf = (input) => {
    const session = String(input?.sessionID ?? '');
    if (parent === '' && session !== '') parent = session;
    return session === '' || session === parent ? 'main' : session;
  };

  const drain = (stream) => {
    const said = (held.get(stream) ?? []).join('\n\n');
    held.delete(stream);
    return said;
  };

  const answerFor = (event, stream, input) => {
    let answer = {};
    try {
      const payload = JSON.stringify({
        hook_event_name: event,
        agent_id: stream,
        tool_name: input?.tool ?? '',
      });
      answer = JSON.parse(main(argv, () => payload) || '{}')?.hookSpecificOutput ?? {};
    } catch {
      return {};
    }
    const body = String(answer.additionalContext ?? '');
    if (body !== '') held.set(stream, [...(held.get(stream) ?? []), body]);
    return answer;
  };

  return {
    'tool.execute.before': async (input, _output) => {
      const stream = streamOf(input);
      const answer = answerFor('PreToolUse', stream, input);
      if (answer.permissionDecision !== 'deny') return;
      throw new Error(
        [drain(stream), String(answer.permissionDecisionReason ?? 'this run has been asked to stop')]
          .filter(Boolean)
          .join('\n\n'),
      );
    },
    'tool.execute.after': async (input, output) => {
      const stream = streamOf(input);
      answerFor('PostToolUse', stream, input);
      if (!held.has(stream)) return;
      if (typeof output?.output !== 'string') return;
      output.output = `${output.output}\n\n${drain(stream)}`;
    },
  };
};
