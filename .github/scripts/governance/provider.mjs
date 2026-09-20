import { canonical, record } from './artifacts.mjs';
import { MAX_RESPONSE_BYTES } from './conversation.mjs';

const REQUEST_KEYS = new Set([
  'model',
  'max_tokens',
  'thinking',
  'output_config',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'system',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
]);
const TOOL_KEYS = new Set(['name', 'description', 'input_schema', 'eager_input_streaming', 'cache_control']);
const TOOL_CHOICES = new Set(['auto', 'any', 'none']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const THINKING = new Set(['adaptive', 'enabled', 'disabled']);
const THINKING_DISPLAYS = new Set(['summarized', 'omitted']);

export class Errand extends Error {}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function governedSettings(request) {
  if (request.output_config !== undefined) {
    const output = record(request.output_config, 'the output config');
    if (!onlyKeys(output, ['effort']) || (output.effort !== undefined && !EFFORTS.has(output.effort))) {
      throw new Error('the output config carries something nothing governs');
    }
  }
  if (request.thinking !== undefined) {
    const thinking = record(request.thinking, 'the thinking config');
    const budget = thinking.budget_tokens;
    if (
      !onlyKeys(thinking, ['type', 'display', 'budget_tokens']) ||
      !THINKING.has(thinking.type) ||
      (thinking.display !== undefined && !THINKING_DISPLAYS.has(thinking.display)) ||
      (budget !== undefined && !Number.isSafeInteger(budget))
    ) {
      throw new Error('the thinking config carries something nothing governs');
    }
  }
}

function governedPrompt(message, prompt) {
  const first = record(message, 'the first message');
  if (first.role !== 'user' || !Array.isArray(first.content) || first.content.length !== 1) return false;
  const block = record(first.content[0], "the first message's content");
  const extra = Object.keys(block).filter((key) => !['type', 'text', 'cache_control'].includes(key));
  return !extra.length && block.type === 'text' && block.text === prompt;
}

function emptySystem(system) {
  return system === undefined || system === '' || (Array.isArray(system) && system.length === 0);
}

function governedTools(tools, governed) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new Error("the request's tools are not a list");
  const seen = new Set();
  return tools.map((entry) => {
    const tool = record(entry, 'a requested tool');
    if (Object.keys(tool).some((key) => !TOOL_KEYS.has(key))) throw new Error(`the ${String(tool.name)} tool carries fields nothing governs`);
    const known = governed.get(String(tool.name));
    if (!known) throw new Error(`the ${String(tool.name)} tool is not governed`);
    if (seen.has(known.name)) throw new Error(`the ${known.name} tool is offered twice`);
    seen.add(known.name);
    if (canonical(tool.input_schema) !== known.schema) {
      throw new Error(`the ${known.name} tool's input schema is not the governed one`);
    }
    return { ...tool, description: known.description };
  });
}

export function governRequest(body, governed, talk) {
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('the provider request is oversized');
  const request = record(JSON.parse(body), 'the provider request');
  const unknown = Object.keys(request).filter((key) => !REQUEST_KEYS.has(key));
  if (unknown.length) throw new Error(`the provider request carries ${unknown.join(', ')}, which nothing governs`);
  if (request.model !== governed.model) throw new Errand(`the request asks ${String(request.model)}, and the render was for ${governed.model}`);
  if (request.stream !== true) throw new Error('the provider request does not stream, so its answer cannot be followed');
  if (!emptySystem(request.system)) throw new Error('the provider request carries a system prompt nothing governs');
  if (request.stop_sequences !== undefined && (!Array.isArray(request.stop_sequences) || request.stop_sequences.length)) {
    throw new Error('the provider request carries stop sequences nothing governs');
  }
  governedSettings(request);
  if (request.tool_choice !== undefined) {
    const choice = record(request.tool_choice, 'the tool choice');
    if (Object.keys(choice).some((key) => key !== 'type') || !TOOL_CHOICES.has(choice.type)) {
      throw new Error('the tool choice names something nothing governs');
    }
  }
  if (!Array.isArray(request.messages) || !request.messages.length || !governedPrompt(request.messages[0], governed.prompt)) {
    throw new Errand('the provider request lost the governed prompt');
  }
  const tools = governedTools(request.tools, governed.tools);
  talk.request(request.messages);
  return request.tools === undefined ? body : JSON.stringify({ ...request, tools });
}
