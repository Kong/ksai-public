import { boundedAsk } from '../../bounded-ask.mjs';
import { GUARD_CHECK } from '../../guard-check.mjs';

export const CONTENT_ASK_MS = 60_000;
const FRAME_BYTES = 1 << 20;

const textsOf = (content) => {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return {
    blocks,
    texts: blocks.flatMap((block, at) => (block?.type === 'text' && typeof block.text === 'string' && block.text !== '' ? [{ at, id: `output.${at}`, text: block.text }] : [])),
  };
};

const resultsOf = (answer, texts) => {
  if (!Array.isArray(answer?.items) || answer.items.length !== texts.length) return null;
  for (const [at, item] of answer.items.entries()) {
    if (item?.id !== texts[at].id || !['allow', 'withhold', 'stop'].includes(item.action)) return null;
    if (item.action === 'withhold' && (typeof item.notice !== 'string' || item.notice === '')) return null;
  }
  return answer.items;
};

export function contentGuard(options) {
  const ask = boundedAsk(options?.socket, { within: CONTENT_ASK_MS, requestMost: GUARD_CHECK.bytesMost + FRAME_BYTES, answerMost: GUARD_CHECK.answerMost });
  let latched = '';
  const latch = (why) => {
    latched ||= `the guard stopped this run: ${why}`;
    return new Error(latched);
  };
  return {
    after: async (event) => {
      if (latched) throw new Error(latched);
      if (event?.status !== 'completed') return;
      const { blocks, texts } = textsOf(event.result?.content);
      if (!texts.length) return;
      const input = event.input && typeof event.input === 'object' ? event.input : {};
      const answer = ask ? await ask({ tool: String(event.tool ?? ''), path: typeof input.path === 'string' ? input.path : '', items: texts.map(({ id, text }) => ({ id, text })) }) : null;
      const results = resultsOf(answer, texts);
      if (!results) {
        if (options?.required) throw latch(`the guard gave no valid answer for the ${String(event.tool ?? '')} output`);
        return;
      }
      if (results.some((result) => result.action === 'stop')) throw latch(`the guard stopped the run at the ${String(event.tool ?? '')} output`);
      if (!results.some((result) => result.action === 'withhold')) return;
      const replaced = blocks.map((block) => ({ ...block }));
      for (const [at, result] of results.entries()) {
        if (result.action === 'withhold') replaced[texts[at].at].text = result.notice;
      }
      const content = typeof event.result.content === 'string' ? replaced[0].text : replaced;
      event.result = { ...event.result, content };
    },
  };
}
