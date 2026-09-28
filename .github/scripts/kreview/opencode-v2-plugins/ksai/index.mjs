import { readFileSync } from 'node:fs';

import { admitted, governed, optionsOf, refuseAll } from '../../../governance/opencode-v2-plugin/index.mjs';
import { offerChildTools } from './child-tools.mjs';
import { guard } from './guard.mjs';
import { capped, serve } from './models.mjs';
import { policy } from './policy.mjs';

const SESSION_HOOKS = Object.freeze(['context', 'compaction', 'generate', 'title']);

export default {
  id: 'ksai',
  async setup(ctx) {
    const options = ctx.options ?? {};
    const governance = optionsOf(options.governance);
    if (!admitted(governance, ctx.location)) {
      await refuseAll(ctx);
      return;
    }
    const model = await serve(ctx, typeof options.model === 'string' ? JSON.parse(readFileSync(options.model, 'utf8')) : options.model);
    const cap = capped(model);
    const ruled = policy(options.policy);
    await ctx.model.transform(ruled.models);
    await ctx.tool.hook('execute.before', ruled.before);
    for (const name of SESSION_HOOKS) {
      await ctx.session.hook(name, cap);
      await ctx.session.hook(name, ruled.context);
    }
    const directory = String(ctx.location?.directory || process.env.GITHUB_WORKSPACE || '');
    if (options.guard) {
      const guarded = guard(directory);
      await ctx.shell.hook('create.before', guarded.shell);
      await ctx.tool.hook('execute.before', guarded.before);
    }
    if (options.children) await offerChildTools(ctx, options.children, directory);
    await governed(ctx, governance);
  },
};
