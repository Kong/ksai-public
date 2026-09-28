import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_REPLY_CHARS, replyBody } from '../../../ksai/reply-limit.cjs';

const MANIFEST = '.ksai-manifest.json';

const text = (value) => (typeof value === 'string' ? value : '');

function edited(at, input) {
  let held;
  try {
    held = readFileSync(at, 'utf8');
  } catch {
    return '';
  }
  const from = text(input.oldString);
  const found = from ? held.indexOf(from) : -1;
  if (found === -1) return '';
  const to = text(input.newString);
  if (input.replaceAll === true) return held.split(from).join(to);
  return `${held.slice(0, found)}${to}${held.slice(found + from.length)}`;
}

function threadsOf(content) {
  try {
    const threads = JSON.parse(content)?.threads;
    return Array.isArray(threads) ? threads : [];
  } catch {
    return [];
  }
}

export function replyLimit(root) {
  const manifest = resolve(root, MANIFEST);
  return (event) => {
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    if (!text(input.path) || resolve(root, input.path) !== manifest) return;
    const content = event.tool === 'write' ? text(input.content) : event.tool === 'edit' ? edited(manifest, input) : '';
    for (const row of threadsOf(content)) {
      const length = replyBody(row?.reply).length;
      if (length <= MAX_REPLY_CHARS) continue;
      throw new Error(
        `the reply for thread ${JSON.stringify(text(row?.id))} is ${length} characters, over the limit of ${MAX_REPLY_CHARS}. ` +
          'One reply over it refuses the whole manifest and discards the commit, so this change to the manifest was refused: ' +
          `write it again with that reply at most ${MAX_REPLY_CHARS} characters.`,
      );
    }
  };
}
