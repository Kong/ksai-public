import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LOCK_NAME = /(?:^|\/)node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)$/;
const DEPENDENCIES = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const NUMBER = '(?:0|[1-9]\\d*)';
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SUFFIX = `(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;
const EXACT_VERSION = `${NUMBER}\\.${NUMBER}\\.${NUMBER}${SUFFIX}`;
const PART = `(?:${NUMBER}|[xX*])`;
const PARTIAL_VERSION = `${PART}(?:\\.${PART}(?:\\.${PART}${SUFFIX})?)?`;
const VERSION = new RegExp(`^v?${EXACT_VERSION}$`);
const RANGE_VERSION = new RegExp(`^[v=]*${PARTIAL_VERSION}$`);
const COMPARATOR = new RegExp(`^(?:[<>]=?|=|~>?|\\^)?[v=]*${PARTIAL_VERSION}$`);

function versionMatches(value, pattern) {
  return pattern.test(value) && value.replace(/^[v<>=~^]+/, '').split(/[-+]/, 1)[0].split('.')
    .every((part) => !/^\d+$/.test(part) || Number.isSafeInteger(Number(part)));
}

function publicRange(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  if (value.trim() === '') return true;
  return value.trim().split(/\s*\|\|\s*/).every((range) => {
    if (range === '') return true;
    const bounds = range.split(/\s+-\s+/);
    if (bounds.length === 2) return bounds.every((bound) => versionMatches(bound, RANGE_VERSION));
    return range.replace(/([~^=<>])\s+/g, '$1').split(/\s+/).every((part) => versionMatches(part, COMPARATOR));
  });
}

function publicPackage(name, version) {
  return PACKAGE_NAME.test(name) && publicRange(version)
    ? `${name}@${version}` : null;
}

function overridesOf(overrides, parent, specs) {
  for (const [key, value] of Object.entries(overrides)) {
    const name = key === '.' ? parent : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!PACKAGE_NAME.test(name) || !overridesOf(value, name, specs)) return false;
    } else {
      const spec = publicPackage(name, value);
      if (!spec) return false;
      specs.add(spec);
    }
  }
  return true;
}

export function npmCacheSpecs(workspace, lockfile) {
  try {
    const read = (name) => {
      const at = path.join(workspace, name);
      if (!lstatSync(at).isFile()) throw new Error('the package file is not a regular file');
      return JSON.parse(readFileSync(at, 'utf8'));
    };
    const manifest = read('package.json');
    const lock = read(lockfile);
    if (manifest.workspaces || ![2, 3].includes(lock.lockfileVersion) || !lock.packages) return null;
    const specs = new Set();
    for (const field of DEPENDENCIES) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        const spec = publicPackage(name, version);
        if (!spec) return null;
        specs.add(spec);
      }
    }
    if (!overridesOf(manifest.overrides ?? {}, '', specs)) return null;
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (location === '') continue;
      const name = location.match(LOCK_NAME)?.[1];
      const spec = name && publicPackage(name, entry.version);
      if (!spec || !versionMatches(entry.version, VERSION) || entry.link) return null;
      if (entry.inBundle === true && entry.resolved === undefined) continue;
      const resolved = new URL(entry.resolved);
      if (resolved.origin !== 'https://registry.npmjs.org'
        || resolved.username || resolved.password || resolved.search || resolved.hash) return null;
      specs.add(spec);
    }
    return specs.size <= 2000 ? [...specs].sort() : null;
  } catch {
    return null;
  }
}
