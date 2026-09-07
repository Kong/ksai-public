function escapeForRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_TRIGGER_PHRASE = '/ksai';

function triggerPhrases(trigger) {
  const extra = String(trigger ?? '').trim();
  const phrases =
    extra && extra !== DEFAULT_TRIGGER_PHRASE
      ? [DEFAULT_TRIGGER_PHRASE, extra]
      : [DEFAULT_TRIGGER_PHRASE];
  return phrases.sort((a, b) => b.length - a.length);
}

function triggerAlternation(trigger) {
  return `(?:${triggerPhrases(trigger)
    .map((phrase) => escapeForRegExp(phrase))
    .join('|')})`;
}

function triggerMatcher(trigger) {
  return new RegExp(`(^|\\s)${triggerAlternation(trigger)}(?=\\s|$)`);
}

function afterTrigger(body, trigger) {
  const text = String(body ?? '');
  const match = text.match(triggerMatcher(trigger));
  return match ? text.slice(match.index + match[0].length).trimStart() : null;
}

function preparePrompt({
  commentBody = '',
  additionalPrompt = '',
  trigger = '',
  isContinuation = '',
  onReview = '',
  onOwnPull = '',
} = {}) {
  if (String(isContinuation ?? '') === 'true') return { prompt: '', hasTrigger: true, request: '' };
  if (String(onReview ?? '') === 'true') return { prompt: '', hasTrigger: true, request: '' };
  const prompt = [commentBody || '', additionalPrompt || ''].filter(Boolean).join('\n');
  const hasTrigger = triggerMatcher(trigger).test(prompt);
  if (hasTrigger) return { prompt, hasTrigger, request: afterTrigger(prompt, trigger) };
  if (String(onOwnPull ?? '') === 'true') return { prompt, hasTrigger: true, request: prompt };
  return { prompt, hasTrigger, request: null };
}

const safeText = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 .,:;()/'-]/g, '?')
    .slice(0, 200);

const plural = (count, one, many = '') => (Number(count) === 1 ? one : many || `${one}s`);

const counted = (count, one, many = '') => `${count} ${plural(count, one, many)}`;

const annotation = (message) => `::error::${String(message).replaceAll('%', '%25').replaceAll(/[\r\n]/g, ' ')}`;

module.exports = {
  annotation,
  safeText,
  escapeForRegExp,
  DEFAULT_TRIGGER_PHRASE,
  triggerPhrases,
  triggerAlternation,
  triggerMatcher,
  afterTrigger,
  preparePrompt,
  plural,
  counted,
};
