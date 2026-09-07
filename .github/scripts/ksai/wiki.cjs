'use strict';

const MAX_WIKI_CHARS = 2000;

const WIKI_SPECIALS = /[\\{}[\]*_?\-+^~|!#]/g;

const WIKI_LINE_PREFIX = /^(h[1-6]|bq)\./gm;

const WIKI_SCHEME = /([A-Za-z]):(?=\S)/g;

const GITHUB_URL_SHAPE =
  /^https:\/\/github\.com\/(?=[A-Za-z0-9._/-]{1,200}$)(?:[A-Za-z0-9._-]+\/){0,20}[A-Za-z0-9._-]+$/;

const WIKI_PARTIAL_ENTITY = /&[#A-Za-z0-9]*$/;

function entity(char) {
  return `&#${char.codePointAt(0)};`;
}

function escapeWiki(value, { max = MAX_WIKI_CHARS } = {}) {
  const escaped = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(WIKI_SPECIALS, entity)
    .replace(WIKI_LINE_PREFIX, (_all, start) => `${entity(start)}${start.slice(1)}.`)
    .replace(WIKI_SCHEME, (_all, before) => `${before}&#58;`);

  const chars = [...escaped];
  if (chars.length <= max) return escaped;
  const cut = chars.slice(0, max).join('').replace(WIKI_PARTIAL_ENTITY, '');
  return `${cut}…`;
}

module.exports = {
  MAX_WIKI_CHARS,
  GITHUB_URL_SHAPE,
  escapeWiki,
};
