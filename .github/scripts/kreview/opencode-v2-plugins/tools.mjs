import { evaluate } from '../../lib/opencode-v2.mjs';

const nullable = (schema) => Array.isArray(schema?.type) && schema.type.includes('null');

export function inputSchema(args) {
  const properties = { ...args };
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !nullable(properties[key])),
    additionalProperties: false,
  };
}

export const asking = (rules, actions = {}) => async ({ permission, patterns = ['*'] }) => {
  const action = actions[permission] ?? permission;
  for (const pattern of patterns.length ? patterns : ['*']) {
    if (evaluate(rules, action, pattern) !== 'allow') throw new Error(`Permission denied: ${action} ${pattern}`);
  }
};

export function v2Tool(name, definition, { rules = [], directory = '', schemaOf = inputSchema, ask = asking(rules) } = {}) {
  return {
    name,
    description: definition.description,
    input: schemaOf(definition.args),
    options: { codemode: false },
    async execute(input, context) {
      const said = await definition.execute(input, {
        sessionID: context.sessionID,
        agent: context.agent,
        directory,
        worktree: directory,
        ask,
        abort: new AbortController().signal,
      });
      if (typeof said === 'string') return { content: said };
      return { content: String(said?.output ?? ''), ...(said?.metadata ? { metadata: said.metadata } : {}) };
    },
  };
}
