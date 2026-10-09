import { counted } from '../lib/text.cjs';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { parseRules } = require('./suppress.cjs');
const { DEFAULT_TIMEOUT, gotFrom, mask } = require('../lib/control-plane.cjs');

const REPO_SHAPE = /^[^/\s]+\/[^/\s]+$/;
const ROUTE = '/v1/run/suppressions';

export function servedRules(served, scope, warn) {
  const answer = /** @type {{scope?: unknown, rules?: unknown} | null} */ (served);
  if (answer?.scope !== scope) {
    warn(`The control plane answered for ${JSON.stringify(answer?.scope)}, not ${scope}; posting every finding.`);
    return { error: 'the control plane answered for another repository' };
  }
  if (answer.rules != null && !Array.isArray(answer.rules)) {
    warn('The control plane answered with rules that are not a list; posting every finding.');
    return { error: 'the control plane answered with rules that are not a list' };
  }
  const listed = Array.isArray(answer.rules) ? answer.rules : [];
  return { rules: parseRules(listed.map((rule) => JSON.stringify(rule)).join('\n'), { scope, warn }) };
}

export async function loadSuppressions({
  env = process.env,
  fetchImpl = fetch,
  scope,
  timeout = DEFAULT_TIMEOUT,
  secret = mask,
  warn = (_message) => {},
}) {
  const source = { control_plane: String(env.KSAI_CP_ENDPOINT ?? '').trim() || null, route: ROUTE };
  const empty = (error) => ({ scope, rules: [], source, ok: false, error });
  if (!REPO_SHAPE.test(String(scope ?? ''))) return empty(`reviewed repository ${JSON.stringify(scope)} is not owner/repo`);

  const got = await gotFrom({ env, fetch: fetchImpl, route: ROUTE, timeout, secret });
  if (got.why) {
    warn(`${got.why}; posting every finding.`);
    return empty(got.why);
  }
  const read = servedRules(got.answer, scope, warn);
  return read.error ? empty(read.error) : { scope, rules: read.rules, source, ok: true, error: null };
}

const annotate = (message) =>
  `::warning::${String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`;

async function main() {
  const bundlePath = process.env.KREVIEW_SUPPRESSIONS_BUNDLE;
  if (!bundlePath) {
    process.stdout.write(annotate('KREVIEW_SUPPRESSIONS_BUNDLE is unset; nothing to write.'));
    return;
  }

  const bundle = await loadSuppressions({
    scope: process.env.KREVIEW_REVIEWED_REPO,
    warn: (message) => process.stdout.write(annotate(message)),
  });

  writeFileSync(bundlePath, JSON.stringify(bundle));
  process.stdout.write(
    `Loaded ${counted(bundle.rules.length, 'suppression rule')} for ${bundle.scope} from ${bundle.source.control_plane ?? 'no control plane'}` +
      `${bundle.ok ? '' : ` (unavailable: ${bundle.error})`}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
