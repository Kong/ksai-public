import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTIVE = /^[0-9]{1,12}\.json$/;
const LINE_MOST = 400;
const KINDS = new Set(['note', 'stop', 'stop.enforce']);
const VALUES = Object.freeze({
  count: (value) => /^[0-9]{1,12}$/.test(value),
  instant: (value) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value),
  line: (value) => value.length <= LINE_MOST && !/\p{C}/u.test(value),
});

export function notesOf(body) {
  const parsed = JSON.parse(body.toString('utf8'));
  if (typeof parsed?.header !== 'string' || !parsed.header.includes('{nonce}') || parsed.templates === null || typeof parsed.templates !== 'object') {
    throw new Error('the run notes are malformed');
  }
  for (const [name, template] of Object.entries(parsed.templates)) {
    if (typeof template?.text !== 'string' || Object.values(template.values ?? {}).some((type) => !Object.hasOwn(VALUES, type))) {
      throw new Error(`the ${name} run note is malformed`);
    }
  }
  return parsed;
}

export function noteText(notes, directive, flow) {
  const template = Object.hasOwn(notes.templates, directive.template) ? notes.templates[directive.template] : null;
  if (!template) throw new Error(`the attested run notes hold no ${directive.template} template`);
  const values = new Map();
  for (const [name, type] of Object.entries(template.values ?? {})) {
    const value = directive.values?.find((one) => one?.name === name)?.value;
    if (typeof value !== 'string' || !VALUES[type](value)) throw new Error(`the ${directive.template} note carries no ${type} ${name}`);
    values.set(name, value);
  }
  const text = template.text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name) => values.get(name) ?? whole);
  const notice = directive.kind === 'stop.enforce' || !Object.hasOwn(notes.notices ?? {}, flow) ? '' : notes.notices[flow];
  return notice ? `${text} ${notice}` : text;
}

export function linkNotes({ dir, notes, nonce, flow }, { read = readFileSync, list = readdirSync, warn = (_said) => {} } = {}) {
  const header = notes.header.replaceAll('{nonce}', nonce);
  const seen = new Set();
  let enforced = '';
  const arrived = () => {
    let names = [];
    try {
      names = list(dir).filter((name) => DIRECTIVE.test(name) && !seen.has(name));
    } catch {
      return [];
    }
    return names.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)).flatMap((name) => {
      seen.add(name);
      try {
        const directive = JSON.parse(read(join(dir, name), 'utf8'));
        if (!KINDS.has(directive?.kind)) throw new Error(`a run directive of kind ${String(directive?.kind)}`);
        return [{ kind: directive.kind, text: noteText(notes, directive, flow) }];
      } catch (error) {
        warn(`a run directive could not be said: ${error?.message ?? error}`);
        return [];
      }
    });
  };
  const waiting = [];
  const take = () => {
    for (const one of arrived()) {
      if (one.kind === 'stop.enforce') enforced ||= `${header} ${one.text}`;
      else waiting.push(one.text);
    }
  };
  return {
    held() {
      take();
      return enforced;
    },
    drain() {
      take();
      if (!waiting.length) return '';
      return [header, ...waiting.splice(0).map((text) => `- ${text}`)].join('\n');
    },
  };
}
