const INSTRUCTIONS = 'Instructions from: ';

const list = (value) => (Array.isArray(value) ? value.map(String) : []);

const inside = (path, root) => root !== '' && (path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`));

export function reviewedInstruction(text, workspace) {
  if (typeof text !== 'string' || !text.startsWith(INSTRUCTIONS)) return false;
  const path = text.slice(INSTRUCTIONS.length).split('\n', 1)[0].trim();
  return inside(path, workspace);
}

export function withoutReviewedInstructions(messages, workspace) {
  const kept = [];
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
      kept.push(message);
      continue;
    }
    const content = message.content.filter((part) => !(part?.type === 'text' && reviewedInstruction(part.text, workspace)));
    if (content.length === 0) continue;
    kept.push(content.length === message.content.length ? message : { ...message, content });
  }
  return kept;
}

export function policy(options = {}, now = Date.now) {
  const allowed = new Set(list(options.models));
  const attempts = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 2;
  const deadline = Number(options.deadline_ms) || 0;
  const stepMs = Number(options.step_ms) || 30_000;
  const workspace = String(options.workspace ?? '');
  const limits = options.output_limits && typeof options.output_limits === 'object' ? options.output_limits : {};
  return {
    models(editor) {
      for (const model of editor.list('anthropic')) {
        if (!allowed.has(model.id)) editor.remove(model.providerID, model.id);
      }
    },
    before(event) {
      const input = event.input && typeof event.input === 'object' ? event.input : {};
      if (event.tool === 'subagent' && input.background === true) {
        throw new Error('a subagent runs in the foreground here: its parent turn is what the deadline and the spend report measure');
      }
      if (event.tool === 'shell' && input.background === true && options.background_shell !== true) {
        throw new Error('a background shell is not available in this phase');
      }
      if (event.tool === 'subagent' && typeof input.model === 'string' && input.model !== '') {
        throw new Error('a subagent runs on the model its own definition names; pick the agent, not a model');
      }
    },
    retry(event) {
      if (!event.decision.retry) return;
      const late = deadline > 0 && now() + Number(event.decision.delay ?? 0) + stepMs > deadline;
      if (event.attempt > attempts + 1 || late) event.decision = { retry: false };
    },
    context(event) {
      const ceiling = Number(limits[event.model?.id]);
      if (Number.isInteger(ceiling) && ceiling > 0 && event.options) {
        event.options.maxTokens = Math.min(ceiling, Number(event.options.maxTokens) || ceiling);
      }
      if (options.strip_instructions !== true || workspace === '' || !Array.isArray(event.messages)) return;
      event.messages = withoutReviewedInstructions(event.messages, workspace);
    },
  };
}

export default {
  id: 'ksai.policy',
  async setup(ctx) {
    const hooks = policy(ctx.options);
    await ctx.model.transform(hooks.models);
    await ctx.tool.hook('execute.before', hooks.before);
    await ctx.session.hook('retry', hooks.retry);
    for (const name of ['context', 'compaction', 'generate', 'title']) await ctx.session.hook(name, hooks.context);
  },
};
