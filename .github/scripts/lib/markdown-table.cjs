'use strict';

function cellText(value) {
  const text = String(value ?? '').replaceAll('\t', '    ').replace(/\r\n?/g, '\n');
  return text.replaceAll('|', '\\|').replaceAll('\n', '<br/>');
}

function markdownTable(header, rows) {
  const columns = Array.from({ length: Math.max(header.length, ...rows.map((row) => row.length)) }, (_, at) => at);
  const line = (cells) => `|${columns.map((at) => ` ${cellText(cells[at])} `).join('|')}|`;
  const rule = columns.map((at) => (rows.some((row) => at < row.length) ? ' --- ' : ' ---:'));
  return [line(header), `|${rule.join('|')}|`, ...rows.map((row) => line(row))].join('\n');
}

module.exports = { markdownTable };
