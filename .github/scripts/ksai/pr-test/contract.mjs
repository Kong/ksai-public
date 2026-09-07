import { readFile } from 'node:fs/promises';

export const KINDS = ['docker-compose', 'mise', 'make'];

const TARGET = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const FIELDS = Object.assign(Object.create(null), {
  'docker-compose': { required: ['file'], optional: ['health', 'depends_on', 'services'] },
  mise: { required: ['up'], optional: ['health', 'depends_on', 'down'] },
  make: { required: ['up'], optional: ['health', 'depends_on', 'down'] },
});

const TARGET_KINDS = new Set(['mise', 'make']);

export async function loadContract(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`no contract at ${path}. Declare one with kinds: ${KINDS.join(', ')}`, {
      cause: error,
    });
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`, { cause: error });
  }

  return parseContract(document, path);
}

export function parseContract(document, source = '.ksai/pr-test.json') {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${source}: not a mapping`);
  }
  if (document.version !== 1) fail(`version must be 1, got ${JSON.stringify(document.version)}`);
  for (const key of Object.keys(document)) {
    if (!['version', 'default', 'environments'].includes(key)) fail(`unknown top-level key ${key}`);
  }

  const environments = document.environments;
  if (!environments || typeof environments !== 'object' || Array.isArray(environments)) {
    throw new Error(`${source}: declares no environments`);
  }

  for (const name of Object.keys(environments)) {
    if (!TARGET.test(name)) fail(`environment name ${JSON.stringify(name)} is not a bare name`);
  }

  for (const [name, entry] of Object.entries(environments)) checkEnvironment(name, entry, fail);

  const names = Object.keys(environments);
  const defaults = document.default ?? [];
  if (!Array.isArray(defaults) || defaults.length === 0) {
    fail('default must list at least one environment');
  } else {
    for (const name of defaults) {
      if (typeof name !== 'string' || !names.includes(name)) {
        fail(`default names unknown environment ${String(name)}`);
      }
    }
  }

  for (const [name, entry] of Object.entries(environments)) {
    const dependencies = Array.isArray(entry?.depends_on) ? entry.depends_on : [];
    for (const dependency of dependencies) {
      if (!names.includes(dependency)) fail(`${name}.depends_on names unknown ${dependency}`);
    }
  }
  checkCycles(environments, names, fail);

  if (problems.length > 0) {
    throw new Error(`${source} is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  return { version: document.version, default: defaults, environments };
}

function checkCycles(environments, names, fail) {
  const complete = new Set();
  const active = new Set();

  const visit = (name, path) => {
    if (complete.has(name)) return;
    if (active.has(name)) {
      const first = path.indexOf(name);
      fail(`environments form a dependency cycle: ${[...path.slice(first), name].join(' -> ')}`);
      return;
    }

    active.add(name);
    const dependencies = environments[name]?.depends_on;
    if (Array.isArray(dependencies)) {
      for (const dependency of dependencies) {
        if (typeof dependency === 'string' && names.includes(dependency)) {
          visit(dependency, [...path, name]);
        }
      }
    }
    active.delete(name);
    complete.add(name);
  };

  for (const name of names) visit(name, []);
}

function checkEnvironment(name, entry, fail) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail(`${name} is not a mapping`);

  const shape = FIELDS[entry.kind];
  if (!shape) {
    return fail(`${name}.kind ${JSON.stringify(entry.kind)} is not one of ${KINDS.join(', ')}`);
  }

  for (const key of shape.required) {
    if (typeof entry[key] !== 'string' || entry[key] === '') {
      fail(`${name} of kind ${entry.kind} needs a ${key} string`);
    }
  }

  const allowed = new Set(['kind', ...shape.required, ...shape.optional]);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail(`${name} has unknown key ${key}`);
  }

  if (TARGET_KINDS.has(entry.kind)) {
    for (const key of ['up', 'down']) {
      if (entry[key] && !TARGET.test(entry[key])) {
        fail(`${name}.${key} ${JSON.stringify(entry[key])} is not a bare task name`);
      }
    }
  }

  if (entry.depends_on !== undefined) {
    const valid =
      Array.isArray(entry.depends_on) &&
      entry.depends_on.every((dependency) => typeof dependency === 'string' && TARGET.test(dependency));
    if (!valid) fail(`${name}.depends_on must be an array of bare environment names`);
  }

  const escapes = (file) => file.startsWith('/') || file.split('/').includes('..');
  if (entry.kind === 'docker-compose' && typeof entry.file === 'string' && escapes(entry.file)) {
    fail(`${name}.file must be a repository-relative path without .. segments`);
  }

  if (entry.services !== undefined) {
    const bare = (value) => typeof value === 'string' && TARGET.test(value);
    if (!Array.isArray(entry.services) || !entry.services.every(bare)) {
      fail(`${name}.services must be an array of bare service names`);
    }
  }

  const health = typeof entry.health === 'string' ? resolveHost(entry.health, 'localhost') : entry.health;
  if (entry.health !== undefined && !isHttpUrl(health)) {
    fail(`${name}.health must be an http(s) URL`);
  }
}

export function selectEnvironments(contract, requested) {
  const names = requested?.length ? requested : contract.default;

  for (const name of names) {
    if (!Object.hasOwn(contract.environments, name)) {
      const declared = Object.keys(contract.environments).join(', ');
      throw new Error(`unknown environment ${name}. This contract declares: ${declared}`);
    }
  }

  const ordered = [];
  const visit = (name, seen) => {
    if (ordered.includes(name)) return;
    if (seen.has(name)) throw new Error(`environments form a dependency cycle at ${name}`);
    seen.add(name);
    for (const dependency of contract.environments[name].depends_on ?? []) visit(dependency, seen);
    ordered.push(name);
  };

  for (const name of names) visit(name, new Set());
  return ordered.map((name) => ({ name, ...contract.environments[name] }));
}

export const resolveHost = (url, host) => url?.replaceAll('${HOST}', host);

export function isHttpUrl(url) {
  if (typeof url !== 'string' || url === '') return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
