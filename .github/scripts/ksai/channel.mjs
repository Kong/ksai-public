import promptText from '../lib/prompt-text.cjs';
import { plain } from './progress.mjs';

const { channelHeader, usableNonce } = promptText;

export const TICK = Object.freeze({ long: 10, short: 5, floor: 5, final: 1 });

const MAX_MARKS = 600;

const MAX_NOTE_CHARS = 300;

export const MAX_DRAIN = 7;

const MAX_NOTES = MAX_DRAIN + 2;

export const MAX_ERRORS = 20;

export const NOTICE = Object.freeze(
  Object.assign(Object.create(null), {
    review: 'A run stopped that way publishes no review at all.',
    implement: 'A step that ends without writing its manifest is recorded as not done.',
  }),
);

export function delaySeconds(remaining) {
  const long = TICK.long * 60;
  const short = TICK.short * 60;
  const floor = TICK.floor * 60;
  if (remaining - long >= floor) return long;
  if (remaining - short >= floor) return short;
  if (remaining > floor) return remaining - floor;
  return TICK.final * 60;
}

export function marks(totalSeconds) {
  const total = Math.floor(Number(totalSeconds));
  if (!Number.isFinite(total) || total <= 0) return [];
  const found = [];
  let left = total;
  while (left > 0 && found.length < MAX_MARKS) {
    left -= delaySeconds(left);
    if (left > 0) found.push(left);
  }
  return found;
}

export function dueMark(list, remaining) {
  const passed = list.filter((mark) => mark >= remaining);
  return passed.length === 0 ? null : passed.at(-1);
}

export function deadlineNote(killAtMs, flow) {
  const at = Number(killAtMs);
  if (!Number.isFinite(at) || at <= 0) return '';
  let stamp = '';
  try {
    stamp = new Date(at).toISOString().replace(/\.\d+Z$/, 'Z');
  } catch {
    return '';
  }
  const cost = NOTICE[String(flow ?? '')] ?? '';
  return (
    `This run is stopped at ${stamp}, epoch second ${Math.floor(at / 1000)}, ` +
    `by a signal it cannot catch.${cost ? ` ${cost}` : ''}`
  );
}

export function clockNote(remainingSeconds, flow) {
  const left = Math.floor(Number(remainingSeconds) / 60);
  const when =
    left < 1
      ? 'Less than a minute remains'
      : `About ${left} ${left === 1 ? 'minute remains' : 'minutes remain'}`;
  const cost = NOTICE[String(flow ?? '')] ?? '';
  return `${when} before this run is stopped by a signal it cannot catch.${cost ? ` ${cost}` : ''}`;
}

export { usableNonce };

export function stopHeld(text) {
  try {
    const held = JSON.parse(String(text ?? ''));
    const deadline = Number(held?.deadline);
    return {
      text: String(held?.text ?? ''),
      deadline: Number.isFinite(deadline) ? deadline : 0,
      hold: held?.hold === true,
      hard: held?.hard === true,
    };
  } catch {
    return { text: '', deadline: 0, hold: false, hard: false };
  }
}

export function stopReason(text, nonce) {
  const said = plain(text, MAX_NOTE_CHARS);
  if (!usableNonce(nonce) || said === '') return '';
  return `${channelHeader(nonce)} This run was asked to stop: ${said} No further tool call will be permitted. Write your final message now.`;
}

export function stopNote(text, secondsLeft, flow) {
  const said = plain(text, MAX_NOTE_CHARS);
  const left = Math.floor(Number(secondsLeft));
  if (said === '' || !Number.isFinite(left) || left <= 0) return '';
  const when =
    left < 60
      ? `${left} ${left === 1 ? 'second' : 'seconds'}`
      : `about ${Math.floor(left / 60)} ${left < 120 ? 'minute' : 'minutes'}`;
  const cost = NOTICE[String(flow ?? '')] ?? '';
  return (
    `This run was asked to stop: ${said} You have ${when} to finish what is already started and write your ` +
    `final message, after which no further tool call will be permitted.${cost ? ` ${cost}` : ''}`
  );
}

export function render(notes, nonce) {
  if (!usableNonce(nonce)) return '';
  const lines = notes
    .slice(0, MAX_NOTES)
    .map((note) => plain(note, MAX_NOTE_CHARS))
    .filter((note) => note !== '');
  if (lines.length === 0) return '';
  return [channelHeader(nonce), ...lines.map((line) => `- ${line}`)].join('\n');
}
