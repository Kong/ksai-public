export const BLOCKED_PROBE = 'https://example.com/';

const REACH_MS = 3_000;
const RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENDPOINT = /^([A-Za-z0-9.-]+):(\d{1,5})$/;

export function runnerLabels(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let labels = [text];
  if (text.startsWith('[')) {
    try {
      labels = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(labels) || labels.length < 1 || !labels.every((label) => typeof label === 'string' && RUNNER_LABEL.test(label))) return null;
  return [...new Set(labels)].sort();
}

export function sameRunner(selected, own) {
  const left = runnerLabels(selected);
  const right = runnerLabels(own);
  return left !== null && right !== null && left.join('\n') === right.join('\n');
}

export function endpointUrl(endpoint) {
  const match = ENDPOINT.exec(String(endpoint).trim());
  if (!match) return null;
  const [, host, port] = match;
  return port === '80' ? `http://${host}/` : `https://${host}${port === '443' ? '' : `:${port}`}/`;
}

export async function reaches(url, fetchImpl = fetch, timeoutMs = REACH_MS) {
  try {
    await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

const refused = (reason) => Object.freeze({ claimed: false, reason });

export async function claimStage({
  runner, runsOn, egressEndpoints = '', jobMinutes, mostMinutes, endpoint, gatewayUrl, fetchImpl = fetch, timeoutMs = REACH_MS,
}) {
  if (!sameRunner(runsOn, runner)) return refused(`the control plane selected ${runsOn || 'no runner'}, so the gated job carries this stage`);
  const minutes = Number(jobMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > Number(mostMinutes)) {
    return refused(`the stage asks for ${jobMinutes || 'no'} job minutes, more than the ${mostMinutes} this job holds`);
  }
  const extra = String(egressEndpoints).split(/\s+/).filter(Boolean);
  const urls = [endpoint, gatewayUrl, ...extra.map((one) => endpointUrl(one))];
  if (urls.some((url) => !url)) return refused('a required egress host is not a host and port');
  const answered = await Promise.all([...urls, BLOCKED_PROBE].map((url) => reaches(url, fetchImpl, timeoutMs)));
  const unreachable = urls.filter((_, index) => !answered[index]);
  if (unreachable.length) return refused(`the egress policy does not reach ${unreachable.join(', ')}`);
  if (answered.at(-1)) return refused(`${BLOCKED_PROBE} answered, so the egress block is not in force`);
  return Object.freeze({ claimed: true, reason: 'this job carries the package stage' });
}
