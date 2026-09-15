import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { listed } from '../lib/opencode.mjs';
import {
  assertToolPath,
  isolatedToolCommand,
  toolLauncherEnvironment,
} from './opencode-tool-sandbox.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESULTS = 100;
const TIMEOUT_MS = 30_000;

const string = (description) => ({ type: 'string', description });
const optionalString = (description) => ({ type: ['string', 'null'], description });

const requestedPath = (value, context) => {
  const directory = String(context.directory || context.worktree || process.env.GITHUB_WORKSPACE || '');
  const worktree = String(context.worktree || process.env.GITHUB_WORKSPACE || directory);
  const requested = value ? (isAbsolute(value) ? value : resolve(directory, value)) : directory;
  return assertToolPath(requested, worktree);
};

export function runIsolatedTool(
  command,
  args,
  cwd,
  env = process.env,
  run = spawnSync,
) {
  const isolated = isolatedToolCommand(command, args, cwd, true, env);
  const result = run(isolated.command, isolated.args, {
    cwd,
    encoding: 'utf8',
    env: toolLauncherEnvironment(env),
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: TIMEOUT_MS,
  });
  const partial = result.error && ['ENOBUFS', 'ETIMEDOUT'].includes(Reflect.get(result.error, 'code'));
  if (result.error && !partial) throw new Error(`isolated ${command} failed: ${result.error.message}`);
  if (!partial && result.status !== 0 && result.status !== 1) {
    const said = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`isolated ${command} exited ${result.status ?? 'without status'}${said ? `: ${said}` : ''}`);
  }
  return String(result.stdout ?? '');
}

const grepRows = (raw, cwd) => {
  const rows = [];
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'match') continue;
    const named = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const text = String(event.data?.lines?.text ?? '').replace(/\r?\n$/, '');
    if (typeof named !== 'string' || !Number.isInteger(lineNumber)) continue;
    rows.push({ path: resolve(cwd, named), line: lineNumber, text });
    if (rows.length > MAX_RESULTS) break;
  }
  return rows;
};

const grepTool = (env, run) => ({
  description: 'Search file contents with a regular expression.',
  args: {
    pattern: string('Regular expression to search for.'),
    path: optionalString('File or directory to search, or null for the current directory.'),
    include: optionalString('Glob of files to include, or null for every file.'),
  },
  async execute(args, context) {
    if (!args?.pattern) throw new Error('pattern is required');
    const search = requestedPath(args.path, context);
    const info = statSync(search);
    const cwd = info.isDirectory() ? search : dirname(search);
    const target = info.isDirectory() ? '.' : basename(search);
    await context.ask({
      permission: 'grep',
      patterns: [args.pattern],
      always: ['*'],
      metadata: { pattern: args.pattern, path: args.path, include: args.include },
    });
    const command = [
      '--json', '--line-number', '--color', 'never', '--max-columns', '2000', '--max-columns-preview',
      ...(args.include ? ['--glob', args.include] : []),
      '--', args.pattern, target,
    ];
    const rows = grepRows(runIsolatedTool('rg', command, cwd, env, run), cwd);
    if (rows.length === 0) return { title: args.pattern, output: 'No files found', metadata: { matches: 0, truncated: false } };
    const truncated = rows.length > MAX_RESULTS;
    const shown = rows.slice(0, MAX_RESULTS);
    const output = [`Found ${shown.length} matches${truncated ? ' (more matches available)' : ''}`];
    let current = '';
    for (const row of shown) {
      if (current !== row.path) {
        if (current) output.push('');
        current = row.path;
        output.push(`${row.path}:`);
      }
      output.push(`  Line ${row.line}: ${row.text}`);
    }
    return {
      title: args.pattern,
      output: output.join('\n'),
      metadata: { matches: shown.length, truncated },
    };
  },
});

const globTool = (env, run) => ({
  description: 'Find files by glob pattern.',
  args: {
    pattern: string('Glob pattern to match.'),
    path: optionalString('Directory to search, or null for the current directory.'),
  },
  async execute(args, context) {
    if (!args?.pattern) throw new Error('pattern is required');
    const search = requestedPath(args.path, context);
    if (!statSync(search).isDirectory()) throw new Error(`glob path must be a directory: ${search}`);
    await context.ask({
      permission: 'glob',
      patterns: [args.pattern],
      always: ['*'],
      metadata: { pattern: args.pattern, path: args.path },
    });
    const raw = runIsolatedTool('rg', ['--files', '--glob', args.pattern, '--', '.'], search, env, run);
    const files = raw.split('\n').filter(Boolean).slice(0, MAX_RESULTS + 1).map((file) => resolve(search, file));
    const truncated = files.length > MAX_RESULTS;
    const shown = files.slice(0, MAX_RESULTS);
    return {
      title: relative(String(context.worktree ?? search), search),
      output: [
        ...(shown.length ? shown : ['No files found']),
        ...(truncated ? ['', `(Results are truncated: showing first ${MAX_RESULTS} results.)`] : []),
      ].join('\n'),
      metadata: { count: shown.length, truncated },
    };
  },
});

const frontmatter = (source) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return null;
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  return name ? { name, content: source.slice(match[0].length) } : null;
};

const skillFiles = (root, limit = 10) => {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit || entry.isSymbolicLink()) continue;
      const at = join(directory, entry.name);
      if (entry.isDirectory()) visit(at);
      else if (entry.name !== 'SKILL.md') found.push(at);
    }
  };
  visit(root);
  return found;
};

const namedSkill = (at, name) => {
  const parsed = frontmatter(readFileSync(at, 'utf8'));
  return parsed?.name === name ? { ...parsed, location: at } : null;
};

const trustedSkill = (name, env) => {
  for (const root of listed(env.OPENCODE_SKILLS)) {
    let canonical;
    try {
      canonical = realpathSync(root);
    } catch {
      continue;
    }
    const pending = [canonical];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const at = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(at);
          continue;
        }
        if (entry.name !== 'SKILL.md') continue;
        const skill = namedSkill(at, name);
        if (skill) return skill;
      }
    }
  }
  return null;
};

const skillTool = (env) => ({
  description: 'Load a trusted KSAI workflow skill.',
  args: { name: string('Skill name from available_skills.') },
  async execute(args, context) {
    const skill = trustedSkill(String(args?.name ?? ''), env);
    if (!skill) throw new Error(`trusted skill not found: ${String(args?.name ?? '')}`);
    await context.ask({ permission: 'skill', patterns: [skill.name], always: [skill.name], metadata: {} });
    const directory = dirname(skill.location);
    return {
      title: `Loaded skill: ${skill.name}`,
      output: [
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        '',
        skill.content.trim(),
        '',
        `Base directory for this skill: ${directory}`,
        'Relative paths in this skill are relative to this base directory.',
        '<skill_files>',
        skillFiles(directory).map((file) => `<file>${file}</file>`).join('\n'),
        '</skill_files>',
        '</skill_content>',
      ].join('\n'),
      metadata: { name: skill.name, dir: directory },
    };
  },
});

export const isolatedChildTools = (env = process.env, run = spawnSync) => ({
  grep: grepTool(env, run),
  glob: globTool(env, run),
  skill: skillTool(env),
});
