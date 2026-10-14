import path from 'node:path';

function safeRoot(value) {
  return value === '*' || (typeof value === 'string' && value !== '' && value === path.posix.normalize(value)
    && !value.startsWith('/') && value !== '..' && !value.startsWith('../') && !value.includes('\\')
    && !value.includes('\0'));
}

function registry(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      && parsed.search === '' && parsed.hash === '' && ['', '443'].includes(parsed.port);
  } catch {
    return false;
  }
}

export function packageTrees(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 32 * 1024) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > 256) return [];
  const seen = new Set();
  for (const one of parsed) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)
      || Object.keys(one).some((name) => !['manager', 'root', 'registry'].includes(name))
      || !['go', 'npm'].includes(one.manager) || !safeRoot(one.root)) return [];
    const configured = one.registry ?? '';
    if (one.manager === 'go' ? configured !== '' : !registry(configured)) return [];
    const key = `${one.manager}\0${one.root}`;
    if (seen.has(key)) return [];
    seen.add(key);
  }
  return parsed;
}
