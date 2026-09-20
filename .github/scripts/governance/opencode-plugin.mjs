import { governedFetch } from './fetch.mjs';
import { governance } from './governor.mjs';

const PROVIDER = 'anthropic';

export const KsaiPromptGovernance = async ({ client }, options = {}) => {
  const log = (level, message, extra) => {
    Promise.resolve(client?.app?.log({ body: { service: 'ksai-prompt-governance', level, message, ...(extra ? { extra } : {}) } })).catch(() => {});
  };
  const governor = governance(options, process.env, log, PROVIDER);
  return {
    ...governor.hooks,
    async config(cfg) {
      cfg.provider ??= {};
      const entry = (cfg.provider[PROVIDER] ??= {});
      entry.options ??= {};
      const origin = entry.options.baseURL ? new URL(entry.options.baseURL).origin : '';
      entry.options.fetch = governedFetch(governor, entry.options.fetch ?? fetch, origin);
      governor.arm();
    },
  };
};
