'use strict';

const { scrub } = require('./plan.cjs');
const { inertBlock } = require('../lib/inert-markdown.cjs');

const MAX_REPLY_CHARS = 1000;

const REPLYING_PHASES = Object.freeze(['fix', 'revise']);

const replyBody = (reply, { triggerPhrase = null } = {}) =>
  inertBlock(scrub(typeof reply === 'string' ? reply : '', { triggerPhrase }).trim());

module.exports = { MAX_REPLY_CHARS, REPLYING_PHASES, replyBody };
