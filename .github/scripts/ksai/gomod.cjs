const { AUTHZ_LOGIN_SHAPE: OWNER } = require('./context.cjs');

const MODULE_FILE = 'go.mod';

const SUM_FILE = 'go.sum';

const { warn } = require('./warn.cjs');

const depth = (dir) => (dir === '.' ? 0 : dir.split('/').length);

function parseTokens(text) {
  const pairs = [];
  const refused = [];
  String(text ?? '')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '') return;
      const where = `line ${index + 1}`;
      const at = line.indexOf('=');
      if (at === -1) {
        refused.push(where);
        return;
      }
      const owner = line.slice(0, at);
      const token = line.slice(at + 1).trim();
      if (!OWNER.test(owner) || token === '') {
        refused.push(where);
        return;
      }
      if (pairs.some((one) => one.owner.toLowerCase() === owner.toLowerCase())) {
        refused.push(where);
        return;
      }
      pairs.push({ owner, token });
    });
  return { pairs, refused };
}

const OWNER_IN_PATH = /(?<![A-Za-z0-9._+-])github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\//g;

const MAX_CASINGS = 4;

function recase(pairs, text) {
  const minted = new Map(pairs.map((pair) => [pair.owner.toLowerCase(), pair]));
  const spellings = new Map(pairs.map((pair) => [pair.owner.toLowerCase(), []]));
  const capped = [];
  for (const [, owner] of String(text ?? '').matchAll(OWNER_IN_PATH)) {
    const key = owner.toLowerCase();
    const pair = minted.get(key);
    if (!pair || owner === pair.owner || !OWNER.test(owner)) continue;
    const found = spellings.get(key);
    if (found.includes(owner)) continue;
    if (found.length >= MAX_CASINGS) {
      if (!capped.includes(pair.owner)) capped.push(pair.owner);
      continue;
    }
    found.push(owner);
  }
  for (const owner of capped) {
    warn(
      `the tracked Go module files spell \`${owner}\` in more than ${MAX_CASINGS} cases, so the rest are left ` +
        'to the public proxy and a private module under one of them will not download',
    );
  }
  const out = [];
  for (const pair of pairs) {
    out.push(pair, ...spellings.get(pair.owner.toLowerCase()).map((owner) => ({ owner, token: pair.token })));
  }
  return out;
}

function gitConfigEnv(pairs) {
  const env = {};
  let count = 0;
  for (const { owner, token } of pairs) {
    env[`GIT_CONFIG_KEY_${count}`] = `url.https://x-access-token:${token}@github.com/${owner}/.insteadOf`;
    env[`GIT_CONFIG_VALUE_${count}`] = `https://github.com/${owner}/`;
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

function goPrivate(pairs) {
  return pairs.map(({ owner }) => `github.com/${owner}/*`).join(',');
}

function moduleDirs(text) {
  const dirs = [];
  for (const raw of String(text ?? '').split('\0')) {
    const line = raw.trim();
    if (line === '') continue;
    const cut = line.lastIndexOf('/');
    if (line.slice(cut + 1) !== MODULE_FILE) continue;
    const dir = cut === -1 ? '.' : line.slice(0, cut);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
}

module.exports = {
  MODULE_FILE,
  SUM_FILE,
  warn,
  gitConfigEnv,
  goPrivate,
  moduleDirs,
  parseTokens,
  recase,
};
