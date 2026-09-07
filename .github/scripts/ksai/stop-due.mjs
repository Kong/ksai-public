import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { stopHeld } from './channel.mjs';

const MAX_REASON_CHARS = 200;

export function stopDue(text, now = Date.now()) {
  const held = stopHeld(text);
  const said = held.text.trim();
  if (said === '' || now < held.deadline) return '';
  const flat = said.replaceAll(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replaceAll(/\s+/g, ' ').trim();
  const cut = [...flat].slice(0, MAX_REASON_CHARS).join('');
  return `somebody asked this run to ${held.hold ? 'pause' : 'stop'}: ${cut}`;
}

export function heldPlan(text) {
  return stopHeld(text).hold;
}

export function main(env = process.env, read = readFileSync, now = Date.now()) {
  const at = String(env.STOP_FILE ?? '');
  if (at === '') return '';
  try {
    return stopDue(read(at, 'utf-8'), now);
  } catch {
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const said = main();
  if (said !== '') process.stdout.write(`${said}\n`);
}
