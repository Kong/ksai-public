import { answersAnthropic, authHeaders, bearer } from '../lib/opencode-token.mjs';

/**
 * KsaiFederatedAnthropic keeps a review authenticated for longer than one token lives.
 *
 * A bearer lives ten minutes on the federation and about five on the gateway, and a review may run
 * for thirty. opencode expands the config's `{env:...}` once, when it connects, so the header this
 * hook writes is the only thing that can carry a token minted after the run started.
 *
 * **This module exports one function and nothing else.** opencode reads a plugin file by walking
 * every export: a non-function throws `Plugin export is not a function` and loses the whole file,
 * and a helper that happens to be a function is *called as a plugin*, with its plugin input where
 * its own arguments should be. Both were true here once, and the review that found it reported
 * success - the static header carried the run and nothing said the hook had never loaded. The
 * renewal lives in `opencode-token.mjs` for that reason, and `opencode-auth.test.mjs` pins it.
 */
export const KsaiFederatedAnthropic = async () => ({
  'chat.headers': async (input, output) => {
    if (!answersAnthropic(input?.model?.providerID ?? input?.provider?.info?.id)) return;
    const token = await bearer();
    if (!token) return;
    Object.assign(output.headers, authHeaders(token));
  },
});
