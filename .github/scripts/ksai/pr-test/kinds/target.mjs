import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { killGroup, quote, runDetached, startDetached, tail } from '../exec.mjs';

export const kind = 'mise';

const INVOCATION = {
  mise: (target) => ['mise', ['run', target]],
  make: (target) => ['make', [target]],
};

export const alsoImplements = ['make'];

export async function setup(entry, context) {
  const [command, args] = INVOCATION[entry.kind](entry.up);
  const started = quote(command, args);

  if (entry.health) return startServer(entry, context, command, args, started);

  const logPath = join(context.runDir, `${entry.name}.log`);
  const result = await runDetached(command, args, {
    cwd: context.repoRoot,
    logPath,
    timeoutMs: context.setupTimeoutMs ?? 600_000,
  });

  const log = await readLog(logPath);

  return {
    started_by: started,
    ok: result.code === 0,
    detail: result.code === 0 ? `task ${entry.up} finished` : tail(log),
    pid: result.pid,
    logPath,
  };
}

async function readLog(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return 'no output was captured';
  }
}

async function startServer(entry, context, command, args, started) {
  const logPath = join(context.runDir, `${entry.name}.log`);
  const pid = await startDetached(command, args, { cwd: context.repoRoot, logPath });

  return { started_by: started, ok: true, detail: `pid ${pid}, log ${logPath}`, pid, logPath };
}

export function describe(entry) {
  const [command, args] = INVOCATION[entry.kind](entry.up);
  return { task: entry.up, command: quote(command, args) };
}

export async function teardown(entry, context) {
  if (entry.down) {
    const [command, args] = INVOCATION[entry.kind](entry.down);
    const result = await runDetached(command, args, {
      cwd: context.repoRoot,
      logPath: join(context.runDir, `${entry.name}.down.log`),
    });
    return { ok: result.code === 0, command: quote(command, args) };
  }

  const pid = context.pids?.[entry.name];
  if (!pid) return { ok: true, command: null };

  const signalled = killGroup(pid);
  return {
    ok: true,
    command: `kill -TERM -${pid}`,
    detail: signalled ? 'signalled' : 'already gone',
  };
}
