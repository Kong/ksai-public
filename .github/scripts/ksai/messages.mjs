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
