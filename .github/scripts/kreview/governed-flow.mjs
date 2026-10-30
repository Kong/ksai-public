import { governedToolsV2 } from './opencode-v2.mjs';

export function governedTools(env) {
  return governedToolsV2({ allowed: env.OPENCODE_ALLOWED, disallowed: env.OPENCODE_DISALLOWED });
}
