const API_VERSION = '2023-06-01';

const CALL_TIMEOUT_MS = 120_000;

export function textOf({ content = [] } = {}) {
  const said = (Array.isArray(content) ? content : []).filter((block) => block?.type === 'text');
  if (!said.length) return null;
  return said.map((block) => String(block?.text ?? '')).join('');
}

export async function postMessage({
  origin = '',
  model = '',
  prompt = '',
  system = '',
  maxTokens = 1024,
  effort = '',
  headers = {},
  fetchImpl = fetch,
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(origin).replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': API_VERSION, ...headers },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(effort ? { output_config: { effort } } : {}),
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(`the model call answered HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    const counted = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    return Object.assign({ content: [], usage: counted, stop_reason: '' }, await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function streamedAnswer(stream) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const said = [];
  let stopReason = '';
  for (const frame of String(stream).replaceAll('\r\n', '\n').split('\n\n')) {
    const data = frame.split('\n').find((line) => line.startsWith('data: '));
    if (!data) continue;
    const event = JSON.parse(data.slice('data: '.length));
    if (event.type === 'message_start') Object.assign(usage, event.message?.usage);
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') said.push(String(event.delta.text ?? ''));
    if (event.type === 'message_delta') {
      stopReason = String(event.delta?.stop_reason ?? '');
      Object.assign(usage, event.usage);
    }
  }
  return { content: said.length ? [{ type: 'text', text: said.join('') }] : [], usage, stop_reason: stopReason };
}

export async function streamGovernedMessage({
  origin = '',
  model = '',
  prompt = '',
  maxTokens = 1024,
  effort = '',
  headers = {},
  governor,
  fetchImpl = fetch,
  timeoutMs = CALL_TIMEOUT_MS,
}) {
  const body = governor.guard(JSON.stringify({
    model,
    max_tokens: maxTokens,
    ...(effort ? { output_config: { effort } } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    stream: true,
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(origin).replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': API_VERSION, ...headers },
      body,
    });
    if (!response.ok) {
      governor.failed();
      throw new Error(`the model call answered HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    return streamedAnswer(await governor.follow(response).text());
  } finally {
    clearTimeout(timer);
  }
}
