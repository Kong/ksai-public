import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const escaped = (message) => String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function input(name, env = process.env) {
  return String(env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
}

export function command(name, message, write = (line) => process.stdout.write(line)) {
  write(`::${name}::${escaped(message)}\n`);
}

export function secret(value, write = (line) => process.stdout.write(line)) {
  if (value !== '') write(`::add-mask::${value}\n`);
}

function keyed(file, name, value) {
  if (!file) throw new Error(`the runner gave this step nowhere to keep ${name}`);
  const fence = `ksai_${randomUUID()}`;
  appendFileSync(file, `${name}<<${fence}\n${value}\n${fence}\n`);
}

export function output(name, value, env = process.env) {
  keyed(env.GITHUB_OUTPUT, name, value);
}

export function state(name, value, env = process.env) {
  keyed(env.GITHUB_STATE, name, value);
}

export function exported(name, value, env = process.env) {
  keyed(env.GITHUB_ENV, name, value);
}
