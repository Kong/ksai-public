import { rendererFor } from './anchors.mjs';
import { canonical, digest } from './artifacts.mjs';
import { MAX_CARRIED_TURNS } from './conversation.mjs';
import { TOOL_PREFIX_V2 } from './release.mjs';
import shipped from './trust.json' with { type: 'json' };
import { certificateTrust, keyTrust, verifyStatement } from './render.mjs';

export function planToolsDigest(plan) {
  const statics = new Map(plan.statics.map((one) => [one.id, one.body]));
  const tools = [...plan.tools].sort().map((name) => {
    const body = statics.get(`${TOOL_PREFIX_V2}${name}`);
    if (body === undefined) throw new Error(`the plan governs the ${name} tool and carries no definition of it`);
    const tool = JSON.parse(body);
    if (tool.name !== name || !Array.isArray(tool.description_lines)) throw new Error(`the plan's ${name} tool is malformed`);
    return { name, description: tool.description_lines.join('\n'), input_schema: tool.input_schema };
  });
  return digest(canonical(tools));
}

export const bare = (sealed) => String(sealed).replace(/^sha256:/, '');

export function resumeTrust(endpoint, pinned = shipped) {
  if (typeof pinned.resumePredicate !== 'string' || pinned.resumePredicate === '') {
    throw new Error('this KSAI release pins no resume permit type, so no carried conversation can be verified');
  }
  const renderer = rendererFor(endpoint, pinned);
  const trust = renderer.renderKey ? keyTrust(renderer.renderKey) : certificateTrust(renderer.renderAuthority, renderer.renderSigner);
  return { trust, predicate: pinned.resumePredicate };
}

export const PERMIT_SUBJECT = 'export';

const HEX = /^[0-9a-f]{64}$/;
const SESSION = /^ses_[A-Za-z0-9]{1,64}$/;
const MAX_TURNS = MAX_CARRIED_TURNS;

function valid(value, test, name) {
  if (!test(value)) throw new Error(`the resume permit names no valid ${name}`);
  return value;
}

export function verifyResumePermit(bundle, { trust, predicate }, expected, now = new Date()) {
  const statement = verifyStatement(Buffer.from(typeof bundle === 'string' ? bundle : JSON.stringify(bundle)), trust, predicate, now);
  const permit = statement.predicate ?? {};
  const kept = permit.export ?? {};
  const exportSha = valid(kept.sha256, (value) => HEX.test(String(value)), 'export.sha256');
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  if (subjects.length !== 1 || subjects[0]?.name !== PERMIT_SUBJECT || subjects[0]?.digest?.sha256 !== exportSha) {
    throw new Error('the resume permit was signed for another export');
  }
  const named = {
    repository: String(expected.repository).toLowerCase(), run_id: Number(expected.runId), run_attempt: Number(expected.attempt), job: expected.job, link: expected.link,
    model: expected.model, variant: expected.variant, tools_sha256: bare(expected.toolsDigest),
    'continuation.render_sha256': expected.continuation, 'original.render_sha256': expected.original,
  };
  for (const [name, value] of Object.entries(named)) {
    const [head, tail] = name.split('.');
    const said = tail ? permit[head]?.[tail] : permit[head];
    if (said !== value) throw new Error(`the resume permit names ${name} ${JSON.stringify(said)}, and this session's is ${JSON.stringify(value)}`);
  }
  const notAfter = new Date(permit.not_after);
  if (!(notAfter.getTime() > now.getTime())) throw new Error(`the resume permit expired at ${permit.not_after}`);
  const history = permit.history ?? {};
  return {
    checkpoint: valid(permit.checkpoint_id, (value) => HEX.test(String(value)), 'checkpoint_id'),
    modelSession: valid(permit.model_session_id, (value) => SESSION.test(String(value)), 'model_session_id'),
    workSession: valid(permit.work_session_id, (value) => typeof value === 'string' && value !== '' && value.length <= 256, 'work_session_id'),
    export: { sha256: exportSha, bytes: valid(kept.bytes, (value) => Number.isSafeInteger(value) && value > 0, 'export.bytes') },
    carried: {
      history: `sha256:${valid(history.sha256, (value) => HEX.test(String(value)), 'history.sha256')}`,
      turns: valid(history.turns, (value) => Number.isSafeInteger(value) && value >= 2 && value <= MAX_TURNS, 'history.turns'),
      original: expected.original,
    },
    notAfter,
  };
}
