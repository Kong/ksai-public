import { readFileSync, realpathSync } from 'node:fs';

import { governance } from '../governor.mjs';
import { STATUS_TOOL, TOOL_PREFIX_V2 } from '../release.mjs';
import { asker, decided, retryAsked } from '../retry-ask.mjs';

export const optionsOf = (given, read = readFileSync) => (typeof given?.from === 'string' && given.from ? JSON.parse(read(given.from, 'utf8')) : given);

export const statusTool = (defined) => ({
  name: STATUS_TOOL,
  description: defined.description,
  input: defined.input_schema,
  options: { codemode: false },
  execute: async (input) => ({ content: String(input?.update ?? '') }),
});

const logged = (level, message, extra) => {
  const reason = extra?.reason ? `: ${extra.reason}` : '';
  console.error(`::${level === 'error' ? 'error' : 'warning'}::${message}${reason}`);
};

export const UNADMITTED = 'this OpenCode instance serves a Location the run did not open, so it runs nothing';

const resolved = (directory) => {
  try {
    return realpathSync(String(directory));
  } catch {
    return String(directory);
  }
};

export const admitted = (options, location) => !options?.directory || resolved(location?.directory ?? '') === resolved(options.directory);

export const UNASKED = 'a governed run has nobody to answer a permission ask, so what it asked is refused';

export function refusedAsk(event) {
  if (event?.effect !== 'ask') return;
  event.effect = 'deny';
  event.message = UNASKED;
}

export function retrying(governor, ask) {
  return async (event) => {
    governor.failed();
    if (!ask || !event?.decision?.retry) return;
    event.decision = decided(event.decision, await ask(retryAsked(event)));
  };
}

export async function refuseAll(ctx) {
  const refuse = () => {
    throw new Error(UNADMITTED);
  };
  await ctx.tool.hook('execute.before', refuse);
  await ctx.session.hook('prompt', refuse);
}

export async function governed(ctx, options) {
  const governor = governance(options, process.env, logged, 'anthropic', TOOL_PREFIX_V2);
  const hooks = governor.v2;
  await ctx.session.hook('prompt', hooks.prompt);
  await ctx.session.hook('context', hooks.context);
  await ctx.session.hook('compaction', hooks.compaction);
  await ctx.session.hook('title', hooks.title);
  await ctx.tool.hook('execute.before', hooks.tool);
  if (hooks.after) await ctx.tool.hook('execute.after', hooks.after);
  await ctx.session.hook('http.request', async (event) => {
    const accepted = governor.guard(await event.request.text());
    event.request = new Request(event.request.url, { method: event.request.method, headers: event.request.headers, body: accepted });
  });
  await ctx.session.hook('http.response', (event) => {
    event.response = governor.follow(event.response);
  });
  await ctx.session.hook('retry', retrying(governor, asker(options?.retry)));
  await ctx.permission.hook('evaluate', refusedAsk);
  const status = governor.offered(STATUS_TOOL);
  if (status) await ctx.tool.transform((editor) => editor.add(statusTool(status)));
  governor.arm();
}
