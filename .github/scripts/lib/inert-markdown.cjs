'use strict';

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n\r]*)$/;
const fenceOf = (line) => {
  const found = FENCE_LINE.exec(line);
  return found && found[2][0] === '`' && found[3].includes('`') ? null : found;
};
const LINE_END = /\r\n?|\n/g;
const PROSE = 0;
const CODE = 1;
const RAW = 2;
const RAW_BLOCKS = [
  [/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
];
const BLOCK_TAG =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|$)/i;
const ZWSP = String.fromCodePoint(0x200b);
const ASCII_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const AT_ENTITY = /^&(?:#0*64|#[xX]0*40|commat);/;
const ANY_AT_ENTITY = /&(?:#0*64|#x0*40|commat);/;
const HTML_TAG = /<(\/?[ \t]*[A-Za-z][A-Za-z0-9-]*(?:[\t\n\f\r />]|$)|[!?])/g;
const WHITESPACE = /\s+/g;

const splitLines = (text) => [text.split(LINE_END), text.match(LINE_END) ?? []];
const joinLines = (lines, ends) => lines.map((line, at) => line + (ends[at] ?? '')).join('');
const blankLine = (line) => /^[ \t]*$/.test(line);
const mentionStart = (char) => /^[A-Za-z0-9]$/.test(char ?? '');
const FOLDING_LETTERS = new Set([0x130, 0x131, 0x17f, 0x212a]);
const startsName = (code) => FOLDING_LETTERS.has(code) || (code < 128 && mentionStart(String.fromCodePoint(code)));
const CONTAINER_PREFIX = /^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]*)+/;
const CHAR_REF = /^&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;
const INLINE_TAGS =
  /^(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/](?:[^<>"']|"[^"]*"|'[^']*')*)?>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)+/;
const startsMention = (text) => {
  const rest = text.slice(INLINE_TAGS.exec(text)?.[0].length ?? 0);
  return startsName(rest.codePointAt(0)) || /^<[A-Za-z/!?]/.test(rest) || CHAR_REF.test(rest);
};
const inertTag = (plain) => plain.replace(HTML_TAG, '&lt;$1');

function walkLines(lines, html, settle) {
  const kinds = Array.from(lines, () => PROSE);
  let open = null;
  let until = null;
  let block = false;
  let certain = false;
  for (let at = 0; at < lines.length; at += 1) {
    let line = lines[at];
    let found = fenceOf(line);
    if (open) {
      kinds[at] = CODE;
      if (found && found[2][0] === open.char && found[2].length >= open.len && found[3] === '') open = null;
      continue;
    }
    let trimmed = line.replace(/^[ \t]+/, '');
    const inHTML = block || until !== null;
    let started = null;
    if (html && until === null && !certain && trimmed.startsWith('<')) {
      for (const [start, end] of RAW_BLOCKS) if (start.test(trimmed)) started = end;
    }
    if ((found && (inHTML || found[1] !== '')) || (started && (trimmed !== line || block))) {
      if (!settle) return kinds.fill(RAW, at);
      if (found && !inHTML) {
        line = trimmed;
      } else {
        line = `${line.slice(0, line.length - trimmed.length)}\\${trimmed}`;
        started = null;
      }
      lines[at] = line;
      found = fenceOf(line);
      trimmed = line.replace(/^[ \t]+/, '');
    }
    if (until) {
      kinds[at] = RAW;
      if (until.test(line)) until = null;
    } else if (blankLine(line)) {
      block = false;
      certain = false;
    } else if (block) {
      kinds[at] = RAW;
      certain ||= BLOCK_TAG.test(trimmed);
    } else if (started) {
      kinds[at] = RAW;
      if (!started.test(line)) until = started;
    } else if (html && trimmed.startsWith('<')) {
      kinds[at] = RAW;
      block = true;
      certain = BLOCK_TAG.test(trimmed);
    } else if (found && (found[2][0] === '~' || !found[3].includes('`'))) {
      kinds[at] = CODE;
      open = { char: found[2][0], len: found[2].length };
    }
  }
  return kinds;
}

const tickRun = (line, at) => {
  let end = at;
  while (line[end] === '`') end += 1;
  return end;
};

function closingRun(line, from, length) {
  for (let next = from; next < line.length; ) {
    if (line[next] !== '`') {
      next += 1;
      continue;
    }
    const closing = tickRun(line, next);
    if (closing - next === length) return closing;
    next = closing;
  }
  return -1;
}

function mentionBoundary(line, at) {
  if (at === 0 || !mentionStart(line[at - 1])) return true;
  const before = line.slice(0, at);
  const token = before.slice(Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t')) + 1).toLowerCase();
  return token.includes('@') || ANY_AT_ENTITY.test(token) || token.includes('www.') || token.includes('://');
}

const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function validDomain(host) {
  const parts = host.split('.');
  return parts.length >= 2 && /^[a-z]+$/.test(parts.at(-1)) && parts.every((part) => DOMAIN_LABEL.test(part));
}

const LINKED_PATH = /^[A-Za-z0-9!#$%&+,./:;=?@^_~-]*$/;
const LINKED_PORT =/^(?:6(?:[0-4]\d{3}|5(?:[0-4]\d{2}|5(?:[0-2]\d|3[0-5])))|[1-5]?\d{1,4})$/;

function inURLPath(line, at, lead) {
  const before = line.slice(0, at);
  const start = Math.max(...[...' \t<>()[]{}"\'`*|\\'].map((char) => before.lastIndexOf(char)));
  const delimiter = start >= 0 ? before[start] : lead;
  if (!delimiter || !' \t(\n'.includes(delimiter)) return false;
  const raw = before.slice(start + 1);
  for (const scheme of ['https://', 'http://']) {
    if (raw.startsWith(scheme)) {
      const rest = raw.slice(scheme.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return false;
      const [name, port, ...more] = rest.slice(0, slash).split(':');
      return (
        more.length === 0 &&
        LINKED_PATH.test(rest.slice(slash + 1)) &&
        validDomain(name) &&
        (port === undefined || LINKED_PORT.test(port))
      );
    }
  }
  return false;
}

function quietLine(line, spans, lead = '') {
  let out = '';
  let clean = true;
  let trusted = spans;
  for (let at = 0; at < line.length; ) {
    const char = line[at];
    if (char === '\\' && at + 1 < line.length && line[at + 1] !== '@' && ASCII_PUNCTUATION.includes(line[at + 1])) {
      out += line.slice(at, at + 2);
      at += 2;
      continue;
    }
    const entity = char === '&' ? AT_ENTITY.exec(line.slice(at))?.[0] : undefined;
    if (entity) {
      out += entity;
      at += entity.length;
      if (startsMention(line.slice(at)) && mentionBoundary(line, at - entity.length)) out += ZWSP;
      continue;
    }
    if (char === '`') {
      const run = tickRun(line, at);
      let end = closingRun(line, run, run - at);
      if (end < 0) {
        clean = false;
        end = run;
      } else if (!trusted) {
        end = run;
      } else if (line.slice(at, end).includes('|')) {
        clean = false;
        trusted = false;
        end = run;
      }
      out += line.slice(at, end);
      at = end;
      continue;
    }
    out += char;
    if (char === '@' && startsMention(line.slice(at + 1)) && mentionBoundary(line, at) && !inURLPath(line, at, lead)) out += ZWSP;
    at += 1;
  }
  return { text: out, clean };
}

function quietMentions(text) {
  if (!/[@&]/.test(text)) return text;
  const [lines, ends] = splitLines(text);
  const kinds = walkLines(lines, true, false);
  let carried = false;
  let nested = false;
  for (let at = 0; at < lines.length; at += 1) {
    if (kinds[at] === CODE || blankLine(lines[at])) {
      carried = false;
      nested = false;
      continue;
    }
    const prefix = CONTAINER_PREFIX.exec(lines[at])?.[0] ?? '';
    if (prefix !== '') {
      const content = lines[at].slice(prefix.length);
      nested = content.startsWith('<') || (nested && content.trim() !== '');
    }
    const quiet = quietLine(lines[at], kinds[at] === PROSE && !carried && !nested, at > 0 ? '\n' : '');
    lines[at] = quiet.text;
    const { clean } = quiet;
    carried = carried || !clean;
  }
  return joinLines(lines, ends);
}

function outsideCodeSpans(line, spans, change) {
  let out = '';
  let plain = 0;
  let clean = true;
  let trusted = spans;
  for (let at = 0; at < line.length; ) {
    if (line[at] === '\\' && at + 1 < line.length && ASCII_PUNCTUATION.includes(line[at + 1])) {
      out += change(line.slice(plain, at)) + line.slice(at, at + 2);
      at += 2;
      plain = at;
      continue;
    }
    if (line[at] !== '`') {
      at += 1;
      continue;
    }
    const run = tickRun(line, at);
    const end = closingRun(line, run, run - at);
    if (end < 0) {
      clean = false;
    } else if (trusted && line.slice(at, end).includes('|')) {
      clean = false;
      trusted = false;
    } else if (trusted) {
      out += change(line.slice(plain, at)) + line.slice(at, end);
      at = end;
      plain = end;
      continue;
    }
    at = run;
  }
  return { text: out + change(line.slice(plain)), clean };
}

function unfence(line) {
  const fenced = FENCE_LINE.exec(line);
  return fenced ? `${fenced[1]}\\${line.slice(fenced[1].length)}` : line;
}

const quietPlaced = (text) => quietMentions(`x ${quietMentions(text)}`).slice(2);

function inertLine(line) {
  const shown = outsideCodeSpans(quietLine(unfence(line), true).text, true, inertTag).text;
  let out = '';
  for (let at = 0; at < shown.length; ) {
    if (shown[at] === '\\' && at + 1 < shown.length && ASCII_PUNCTUATION.includes(shown[at + 1])) {
      out += shown.slice(at, at + 2);
      at += 2;
    } else if (shown[at] === '`') {
      const run = tickRun(shown, at);
      const end = closingRun(shown, run, run - at);
      out += end >= 0 ? shown.slice(at, end) : '\\`'.repeat(run - at);
      at = end >= 0 ? end : run;
    } else {
      out += shown[at];
      at += 1;
    }
  }
  return out;
}

function inertTags(text) {
  if (!text.includes('<')) return text;
  const [lines, ends] = splitLines(text);
  const kinds = walkLines(inertTag(text).split(LINE_END), false, false);
  let carried = false;
  for (let at = 0; at < lines.length; at += 1) {
    if (kinds[at] === CODE || blankLine(lines[at])) {
      carried = false;
      continue;
    }
    const shown = outsideCodeSpans(lines[at], kinds[at] === PROSE && !carried, inertTag);
    lines[at] = shown.text;
    const { clean } = shown;
    carried = carried || !clean;
  }
  return joinLines(lines, ends);
}

function scanFences(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = fenceOf(lines[i]);
    if (!m) continue;
    const [, indent, marker, rest] = m;
    const info = rest.trim();
    if (!open) {
      if (marker[0] === '`' && info.includes('`')) continue;
      open = { start: i, indent, char: marker[0], len: marker.length, info };
      continue;
    }
    if (marker[0] === open.char && marker.length >= open.len && rest === '') {
      blocks.push({ ...open, end: i });
      open = null;
    }
  }
  return { blocks, open };
}

const longestRun = (text, char) => {
  const runs = text.match(char === '`' ? /`+/g : /~+/g);
  return runs ? Math.max(...runs.map((run) => run.length)) : 0;
};

function trimStrayClosers(payload) {
  let kept = payload;
  while (kept.length) {
    const m = fenceOf(kept.at(-1));
    if (!m || m[3] !== '') return kept;
    const inner = kept.slice(0, -1);
    if (scanFences(inner).open) return kept;
    kept = inner;
  }
  return kept;
}

function balanceFences(body, html = true) {
  const [lines, ends] = splitLines(body);
  walkLines(lines, html, true);
  const { blocks, open } = scanFences(lines);
  if (!open) return joinLines(lines, ends);
  const outer = blocks.at(-1);
  const nested =
    open.info === '' &&
    open.start === lines.length - 1 &&
    outer !== undefined &&
    outer.char === open.char &&
    outer.end === open.start - 1;
  const opener = nested ? outer : open;
  const payload = trimStrayClosers(lines.slice(opener.start + 1, nested ? open.start : lines.length));
  const fence = opener.char.repeat(Math.max(opener.len, longestRun(payload.join('\n'), opener.char) + 1));
  const info = opener.info.startsWith(fence[0]) ? ` ${opener.info}` : opener.info;
  return [...lines.slice(0, opener.start), `${opener.indent}${fence}${info}`, ...payload, `${opener.indent}${fence}`].join('\n');
}

const inertAccount = (text) => quietMentions(inertTags(text));
const inertBlock = (text) => inertAccount(balanceFences(text, false));
const plainInline = (text) => quietLine(String(text ?? '').replace(WHITESPACE, ' ').trim(), true).text;
const inertInline = (text) => inertLine(plainInline(text));

function codeCell(value) {
  const text = String(value).replace(LINE_END, ' ');
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const MAX_ARM_CHARS = 256;
const armText = (value) => String(value ?? '').replace(/[^A-Za-z0-9._/:+-]+/g, '').slice(0, MAX_ARM_CHARS);

function inertAfter(text) {
  const [lines, ends] = splitLines(String(text ?? ''));
  lines[0] = unfence(lines[0]);
  return inertBlock(joinLines(lines, ends));
}

function nestable(text) {
  const [lines] = splitLines(String(text ?? ''));
  const expanded = lines.map((line) => {
    const lead = /^[ \t]*/.exec(line)[0];
    if (!lead.includes('\t')) return line;
    let column = 0;
    for (const char of lead) column = char === '\t' ? column + 4 - (column % 4) : column + 1;
    return ' '.repeat(column) + line.slice(lead.length);
  });
  return expanded.join('\n');
}

function foldedBody(body) {
  const [lines, ends] = splitLines(nestable(body));
  if (lines.length < 2) return body;
  return `\n${joinLines(lines.map((line) => (blankLine(line) ? line : `  ${line}`)), ends)}`;
}

module.exports = {
  MAX_ARM_CHARS,
  armText,
  balanceFences,
  codeCell,
  foldedBody,
  inertAccount,
  inertAfter,
  inertBlock,
  inertInline,
  inertLine,
  inertTag,
  inertTags,
  nestable,
  outsideCodeSpans,
  plainInline,
  quietLine,
  quietMentions,
  quietPlaced,
  unfence,
};
