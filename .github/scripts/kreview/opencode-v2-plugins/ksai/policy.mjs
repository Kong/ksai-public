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

export function policy(options = {}) {
  const allowed = new Set(list(options.models));
  const workspace = String(options.workspace ?? '');
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
    context(event) {
      if (options.strip_instructions !== true || workspace === '' || !Array.isArray(event.messages)) return;
      event.messages = withoutReviewedInstructions(event.messages, workspace);
    },
  };
}
