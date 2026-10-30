import { declaredFields } from '../link/link-protocol.mjs';
import json from '../lib/json.cjs';

const { canonicalJson, parseIJson } = json;
const RULE_BYTES_MOST = 32768;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{0,8}[1-9])?Z$/;

function hasControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return true;
  }
  return false;
}

export function policyDeadline(policy, now = Date.now()) {
  const text = policy.deadline_at;
  const deadline = Date.parse(text);
  if (typeof text !== 'string' || !UTC.test(text) || !Number.isFinite(deadline)
    || new Date(deadline).toISOString().slice(0, 19) !== text.slice(0, 19)) {
    throw new Error('the session policy names no canonical UTC deadline');
  }
  if (deadline <= now) throw new Error('the session policy deadline expired');
  return deadline;
}

export function sessionPolicy(value, now = Date.now()) {
  const checked = declaredFields('engine', 'host', 'session.start', { policy: value }).policy;
  if (!checked) throw new Error('the engine supplied no valid typed session policy');
  for (const name of ['allowed_tools', 'disallowed_tools']) {
    if (Buffer.byteLength(checked[name], 'utf8') > RULE_BYTES_MOST || hasControl(checked[name])) {
      throw new Error(`the session policy ${name} exceeds its byte or character limit`);
    }
  }
  policyDeadline(checked, now);
  return Object.freeze({ ...checked, tools: Object.freeze([...checked.tools]) });
}

export function policyTimeLeft(policy, now = Date.now(), reserve = 0) {
  const left = policyDeadline(policy, now) - now - reserve;
  if (left <= 0) throw new Error('the session policy leaves no time before its stop reserve');
  return left;
}

export function assertPlanPolicy(expected, plan, now = Date.now()) {
  const policy = sessionPolicy(plan?.policy, now);
  if (canonicalJson(policy) !== canonicalJson(expected)) {
    throw new Error('the plugin plan changes the accepted session policy');
  }
  if (plan.model?.id !== policy.model || plan.variant !== policy.variant || plan.steps !== policy.steps
    || plan.shell_timeout_ms !== policy.shell_timeout_ms || canonicalJson(plan.tools) !== canonicalJson(policy.tools)) {
    throw new Error('the plugin plan disagrees with its session policy');
  }
  return policy;
}

export function sessionPolicyEnv(policy, inherited = {}) {
  return {
    ...inherited,
    KSAI_SESSION_POLICY: canonicalJson(policy),
    OPENCODE_MODEL: policy.model,
    MODEL: policy.model,
    VARIANT: policy.variant,
    OPENCODE_ALLOWED: policy.allowed_tools,
    OPENCODE_DISALLOWED: policy.disallowed_tools,
    KSAI_GOVERNED_TOOLS: policy.tools.join(','),
    KSAI_GOVERNED_STEPS: String(policy.steps),
    KSAI_SHELL_TIMEOUT_MS: String(policy.shell_timeout_ms),
  };
}

export function sessionPlanPolicy(env, plan, now = Date.now()) {
  const expected = sessionPolicy(parseIJson(String(env.KSAI_SESSION_POLICY ?? ''), 'the accepted session policy'), now);
  return assertPlanPolicy(expected, plan, now);
}
