'use strict';

function overwritten(line) {
  const out = [];
  let at = 0;
  for (const char of line) {
    if (char === '\r') {
      at = 0;
      continue;
    }
    if (at < out.length) out[at] = char;
    else out.push(char);
    at += 1;
  }
  return out.join('');
}

function cellText(value) {
  const text = String(value ?? '').replaceAll('\t', '    ').replaceAll('\r\n', '\n');
  const settled = text.includes('\r') ? text.split('\n').map((line) => overwritten(line)).join('\n') : text;
  return settled.replaceAll('|', '\\|').replaceAll('\n', '<br/>');
}

function markdownTable(header, rows) {
  const columns = Array.from({ length: Math.max(header.length, ...rows.map((row) => row.length)) }, (_, at) => at);
  const line = (cells) => `|${columns.map((at) => ` ${cellText(cells[at])} `).join('|')}|`;
  const rule = columns.map((at) => (rows.some((row) => at < row.length) ? ' --- ' : ' ---:'));
  return [line(header), `|${rule.join('|')}|`, ...rows.map((row) => line(row))].join('\n');
}

module.exports = { markdownTable };
