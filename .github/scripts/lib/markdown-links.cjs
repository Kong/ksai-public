'use strict';

const LINK_PAREN_DEPTH = 32;

const LINK_LABEL_MOST = 1000;

const CONTAINER_DEPTH = 32;

const CODE_INDENT = 4;

const QUOTE = -1;

const DESTINATION_END = new Set([' ', '\t', '\n', '\v', '\f', '\r']);

const DEFINITION_LABEL_AT = /\[((?:\\[^\n]|[^\\[\]\n])+)\]:/y;

const REFERENCE_AT = /\[((?:\\[^\n]|[^\\[\]\n])*)\]/y;

const LIST_MARKER_AT = /(?:[-*+]|(\d{1,9})[.)])(?=[ \t\r\n]|$)/y;

const LINE_BLOCK_AT = /#{1,6}(?=[ \t\r\n]|$)|([-*_])(?:[ \t]*\1){2,}[ \t\r]*(?=\n|$)/y;

const SETEXT_AT = /(?:=+|-+)[ \t\r]*(?=\n|$)/y;

const FENCE_AT = /(`{3,}|~{3,})([^\n]*)/y;

const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const HTML_BLOCKS = [
  { at: /<(?:script|pre|style|textarea)(?=[\s>]|$)/iy, end: /<\/(?:script|pre|style|textarea)>/i },
  { at: /<!--/y, end: /-->/ },
  { at: /<\?/y, end: /\?>/ },
  { at: /<![A-Z]/y, end: />/ },
  { at: /<!\[CDATA\[/y, end: /\]\]>/ },
  { at: new RegExp(`</?(?:${HTML_BLOCK_TAGS})(?=[\\s>]|/>|$)`, 'iy'), end: null },
  {
    at: /(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^'\n]*'|"[^"\n]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t\r]*(?=\n|$)/y,
    end: null,
    interrupts: false,
  },
];

const TITLE_CLOSE = new Map([
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
]);

const escapes = (text, at) => text[at] === '\\' && text[at + 1] > ' ';

const spaceAt = (text, at) => text[at] === ' ' || text[at] === '\t' || text[at] === '\r';

function lineRestAt(text, from) {
  let at = from;
  while (spaceAt(text, at)) at += 1;
  return at;
}

const blankLineAfter = (text, newline, bodyOf) => text[lineRestAt(text, bodyOf(newline + 1))] === '\n';

function spacesAt(text, from, bodyOf) {
  const at = lineRestAt(text, from);
  return text[at] === '\n' ? lineRestAt(text, bodyOf(at + 1)) : at;
}

const linkReference = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const linkOf = (start, close, end, target, targetAt, reference, name) => ({ start, close, end, target, targetAt, reference, name });

function linkDestination(text, from) {
  let at = from;
  if (text[at] === '<') {
    for (at += 1; text[at] !== '>'; at += 1) {
      if (at >= text.length || text[at] === '\n' || text[at] === '<') return null;
      if (escapes(text, at)) at += 1;
    }
    return { target: text.slice(from + 1, at), targetAt: from + 1, end: at + 1 };
  }
  let depth = 0;
  for (; at < text.length && !DESTINATION_END.has(text[at]); at += 1) {
    if (escapes(text, at)) {
      at += 1;
    } else if (text[at] === '(') {
      depth += 1;
      if (depth > LINK_PAREN_DEPTH) return null;
    } else if (text[at] === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (at === from && text[at] !== ')') return null;
  return { target: text.slice(from, at), targetAt: from, end: at };
}

function linkTitle(text, from, bodyOf) {
  const close = TITLE_CLOSE.get(text[from]);
  if (close === undefined) return -1;
  for (let at = from + 1; at < text.length; at += 1) {
    if (escapes(text, at)) {
      at += 1;
    } else if (text[at] === close) {
      return at + 1;
    } else if ((close === ')' && text[at] === '(') || (text[at] === '\n' && blankLineAfter(text, at, bodyOf))) {
      return -1;
    }
  }
  return -1;
}

function titledEnd(text, destination, bodyOf) {
  const at = spacesAt(text, destination, bodyOf);
  const title = at > destination ? linkTitle(text, at, bodyOf) : -1;
  return { title, end: title === -1 ? at : spacesAt(text, title, bodyOf) };
}

function inlineLink(text, open, bodyOf) {
  if (text[open] !== '(') return null;
  const destination = linkDestination(text, spacesAt(text, open + 1, bodyOf));
  if (!destination) return null;
  const { end } = titledEnd(text, destination.end, bodyOf);
  return text[end] === ')' ? { ...destination, end: end + 1 } : null;
}

const matchAt = (pattern, text, at) => {
  pattern.lastIndex = at;
  return pattern.exec(text);
};

function linkDefinition(text, line, bodyOf) {
  const label = matchAt(DEFINITION_LABEL_AT, text, line);
  const destination = label && linkDestination(text, spacesAt(text, DEFINITION_LABEL_AT.lastIndex, bodyOf));
  if (!destination) return null;
  const { title } = titledEnd(text, destination.end, bodyOf);
  const endsLine = (at) => at !== -1 && (text[lineRestAt(text, at)] ?? '\n') === '\n';
  const end = endsLine(title) ? title : endsLine(destination.end) ? destination.end : -1;
  return end === -1 ? null : linkOf(line, undefined, end, destination.target, destination.targetAt, undefined, label[1]);
}

function linkAfter(text, start, close, defined, bodyOf, limit) {
  const inline = inlineLink(text, close + 1, bodyOf);
  if (inline && inline.end <= limit) return linkOf(start, close, inline.end, inline.target, inline.targetAt);
  if (defined.size === 0 || close - start > LINK_LABEL_MOST) return null;
  const label = text.slice(start + 1, close);
  const matched = matchAt(REFERENCE_AT, text, close + 1);
  const full = matched && REFERENCE_AT.lastIndex <= limit ? matched : null;
  const reference = full ? full[1] || label : label;
  return defined.has(linkReference(reference)) ? linkOf(start, close, full ? REFERENCE_AT.lastIndex : close + 1, undefined, undefined, reference) : null;
}

function indentOf(text, from, column, most = Infinity) {
  let at = from;
  let col = column;
  for (; col < most && (text[at] === ' ' || text[at] === '\t'); at += 1) {
    const next = text[at] === '\t' ? col + 4 - (col % 4) : col + 1;
    if (next > most) return [at, most];
    col = next;
  }
  return [at, col];
}

const oneColumnOf = (text, at, column) => (text[at] === '\t' && column % 4 !== 3 ? [at, column + 1] : [at + 1, column + 1]);

const afterQuote = (text, at, column) => (text[at + 1] === ' ' || text[at + 1] === '\t' ? oneColumnOf(text, at + 1, column + 1) : [at + 1, column + 1]);

function fenceAt(text, at) {
  const fenced = matchAt(FENCE_AT, text, at);
  return fenced && !(fenced[1][0] === '`' && fenced[2].includes('`')) ? fenced : null;
}

function pipesOf(text, from, to) {
  const pipes = [];
  for (let at = from; at < to; at += 1) {
    if (text[at] === '\\') at += 1;
    else if (text[at] === '|') pipes.push(at);
  }
  return pipes;
}

function cellsOf(text, from, to, pipes) {
  let last = to - 1;
  while (last > from && spaceAt(text, last)) last -= 1;
  return pipes.length + 1 - (pipes[0] === from ? 1 : 0) - (pipes.at(-1) === last ? 1 : 0);
}

function delimiterCells(text, from, to) {
  const row = text.slice(from, to).trim();
  if (!row.includes('|')) return 0;
  const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((one) => DELIMITER_CELL.test(one)) ? cells.length : 0;
}

const htmlAt = (text, at, interrupting) =>
  text[at] === '<' ? (HTML_BLOCKS.find((one) => (!interrupting || one.interrupts !== false) && matchAt(one.at, text, at)) ?? null) : null;

function blocksOf(text) {
  const blocks = [];
  const breaks = [];
  const bodies = new Map();
  const paragraphs = [];
  const containers = [];
  let fence = null;
  let html = null;
  let header = null;
  let table = 0;
  let paragraph = false;
  for (let line = 0; line < text.length; ) {
    const newline = text.indexOf('\n', line);
    const lineEnd = newline === -1 ? text.length : newline;
    const contentEnd = text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const next = lineEnd + 1;
    let at = line;
    let col = 0;
    let depth = 0;
    for (const container of containers) {
      const [start, column] = indentOf(text, at, col);
      if (container === QUOTE) {
        if (column - col >= CODE_INDENT || text[start] !== '>') break;
        [at, col] = afterQuote(text, start, column);
      } else if (start >= contentEnd) {
        [at, col] = [start, column];
      } else if (column >= container) {
        [at, col] = indentOf(text, at, col, container);
      } else {
        break;
      }
      depth += 1;
    }
    if (at > line) bodies.set(line, at);
    if (fence && depth === containers.length) {
      const [start, column] = indentOf(text, at, col);
      const closing = column - col < CODE_INDENT && fenceAt(text, start);
      if (closing && closing[1][0] === fence.mark && closing[1].length >= fence.length && closing[2].trim() === '') {
        blocks.push(linkOf(fence.start, undefined, lineEnd));
        fence = null;
      }
      line = next;
      continue;
    }
    if (fence) {
      blocks.push(linkOf(fence.start, undefined, line - 1));
      fence = null;
    }
    if (html && depth === containers.length) {
      const [start] = indentOf(text, at, col);
      if (html.end !== null || start < contentEnd) {
        if (html.end?.test(text.slice(at, lineEnd))) {
          blocks.push(linkOf(html.start, undefined, lineEnd));
          html = null;
        }
        line = next;
        continue;
      }
    }
    if (html) {
      blocks.push(linkOf(html.start, undefined, line - 1));
      html = null;
    }
    const matched = depth;
    while (depth < CONTAINER_DEPTH) {
      const [start, column] = indentOf(text, at, col);
      if (column - col >= CODE_INDENT) break;
      if (text[start] === '>') {
        containers.length = depth;
        containers.push(QUOTE);
        [at, col] = afterQuote(text, start, column);
      } else {
        const marker = !matchAt(LINE_BLOCK_AT, text, start) && matchAt(LIST_MARKER_AT, text, start);
        if (!marker) break;
        const markerEnd = LIST_MARKER_AT.lastIndex;
        const markerColumn = column + markerEnd - start;
        const [content, contentColumn] = indentOf(text, markerEnd, markerColumn);
        const empty = content >= contentEnd;
        if (paragraph && depth === containers.length && (empty ||(marker[1] !== undefined && Number(marker[1]) !== 1))) break;
        const wide = empty || contentColumn - markerColumn > CODE_INDENT;
        containers.length = depth;
        containers.push(wide ? markerColumn + 1 : contentColumn);
        [at, col] = !wide ? [content, contentColumn] : empty ? [content, markerColumn + 1] : oneColumnOf(text, markerEnd, markerColumn);
      }
      depth += 1;
      paragraph = false;
    }
    const [start, column] = indentOf(text, at, col);
    const code = column - col >= CODE_INDENT;
    const fenced = code ? null : fenceAt(text, start);
    const opened = code || fenced ? null : htmlAt(text, start, paragraph && depth === containers.length);
    const blockLine = start >= contentEnd || code || fenced || opened || matchAt(LINE_BLOCK_AT, text, start);
    if (depth !== matched || depth !== containers.length || blockLine) table = 0;
    const delimiter =
      !table && paragraph && header?.depth === depth && depth === containers.length && !blockLine && delimiterCells(text, start, contentEnd) === header.cells;
    if (table || delimiter) {
      if (delimiter) {
        if (paragraphs.at(-1)?.start === header.start) paragraphs.pop();
        if (breaks.at(-1) !== header.line) breaks.push(header.line);
        breaks.push(...header.pipes);
        paragraph = false;
        table = header.cells;
      }
      const pipes = pipesOf(text, start, contentEnd);
      const inner = pipes[0] === start ? pipes.slice(1) : pipes;
      breaks.push(line, ...pipes);
      if (inner.length >= table && cellsOf(text, start, contentEnd, pipes) > table) blocks.push(linkOf(inner[table - 1], undefined, lineEnd));
      header = null;
    } else if (start >= contentEnd) {
      containers.length = depth;
      paragraph = false;
      breaks.push(line);
    } else if (code) {
      if (!paragraph) {
        containers.length = depth;
        blocks.push(linkOf(line, undefined, lineEnd));
      }
    } else if (fenced) {
      containers.length = depth;
      fence = { start: line, mark: fenced[1][0], length: fenced[1].length };
      paragraph = false;
    } else if (opened) {
      containers.length = depth;
      paragraph = false;
      if (opened.end?.test(text.slice(start, lineEnd))) blocks.push(linkOf(line, undefined, lineEnd));
      else html = { start: line, end: opened.end };
    } else if (matchAt(LINE_BLOCK_AT, text, start) || (paragraph && depth === containers.length && matchAt(SETEXT_AT, text, start))) {
      containers.length = depth;
      paragraph = false;
      breaks.push(line);
    } else {
      if (!paragraph) {
        containers.length = depth;
        breaks.push(line);
        paragraphs.push({ start, breakAt: breaks.length, blockAt: blocks.length });
      }
      paragraph = true;
      const pipes = pipesOf(text, start, contentEnd);
      header = pipes.length > 0 ? { line, start, depth, pipes, cells: cellsOf(text, start, contentEnd, pipes) } : null;
      line = next;
      continue;
    }
    header = null;
    line = next;
  }
  if (fence) blocks.push(linkOf(fence.start, undefined, text.length));
  if (html) blocks.push(linkOf(html.start, undefined, text.length));
  const bodyOf = (at) => bodies.get(at) ?? at;
  const definitions = [];
  for (const { start, breakAt, blockAt } of paragraphs) {
    const end = Math.min(breaks[breakAt] ?? text.length, blocks[blockAt]?.start ?? text.length);
    for (let at = start; at < end && text[at] === '['; ) {
      const definition = linkDefinition(text, at, bodyOf);
      if (!definition || definition.end > end) break;
      definitions.push(definition);
      const after = text.indexOf('\n', definition.end);
      if (after === -1) break;
      at = lineRestAt(text, bodyOf(after + 1));
    }
  }
  const ordered = definitions.length === 0 ? blocks : [...blocks, ...definitions].sort((a, b) => a.start - b.start);
  return { blocks: ordered, breaks, bodyOf };
}

function backtickRuns(text) {
  const runs = new Map();
  for (let at = text.indexOf('`'); at !== -1; ) {
    let end = at;
    while (text[end] === '`') end += 1;
    if (!runs.has(end - at)) runs.set(end - at, { starts: [], next: 0 });
    runs.get(end - at).starts.push(at);
    at = text.indexOf('`', end);
  }
  return runs;
}

function codeSpanEnd(text, runs, at, limit) {
  let end = at;
  while (text[end] === '`') end += 1;
  const run = runs.get(end - at);
  if (run === undefined) return end;
  while (run.next < run.starts.length && run.starts[run.next] <= at) run.next += 1;
  const closer = run.starts[run.next];
  return closer !== undefined && closer < limit ? closer + end - at : end;
}

function* drained(held) {
  yield* held;
  held.length = 0;
}

function* markdownLinks(text) {
  const { blocks, breaks, bodyOf } = blocksOf(text);
  const defined = new Set(blocks.flatMap(({ name }) => (name === undefined ? [] : [linkReference(name)])));
  const runs = backtickRuns(text);
  const openers = [];
  const enclosable = [];
  let inactive = 0;
  let escaped = -1;
  let block = 0;
  let paragraph = 0;
  for (let at = 0; at < text.length; at += 1) {
    while (block < blocks.length && blocks[block].start < at) block += 1;
    let breaking = false;
    for (; paragraph < breaks.length && breaks[paragraph] <= at; paragraph += 1) breaking ||= breaks[paragraph] === at;
    const blockStart = block < blocks.length ? blocks[block].start : text.length;
    const paragraphEnd = paragraph < breaks.length ? breaks[paragraph] : text.length;
    if (blockStart === at || breaking) {
      if (enclosable.length > 0) yield* drained(enclosable);
      openers.length = 0;
      inactive = 0;
    }
    if (blockStart === at) {
      if (blocks[block].name !== undefined) yield blocks[block];
      at = blocks[block].end - 1;
    } else if (escapes(text, at)) {
      at += 1;
      escaped = at;
    } else if (text[at] === '`') {
      at = codeSpanEnd(text, runs, at, Math.min(blockStart, paragraphEnd)) - 1;
    } else if (text[at] === '[') {
      openers.push({ start: at, image: text[at - 1] === '!' && escaped !== at - 1 });
    } else if (text[at] === ']' && openers.length > 0) {
      const opener = openers.pop();
      const active = opener.image || openers.length >= inactive;
      inactive = Math.min(inactive, openers.length);
      const link = active && linkAfter(text, opener.start, at, defined, bodyOf, Math.min(blockStart, paragraphEnd));
      if (link) {
        at = link.end - 1;
        if (!opener.image) inactive = openers.length;
        while (enclosable.length > 0 && enclosable.at(-1).start > link.start) enclosable.pop();
        enclosable.push(link);
        if (openers.length === 0) yield* drained(enclosable);
      }
    }
  }
  yield* enclosable;
}

module.exports = { linkReference, markdownLinks };
