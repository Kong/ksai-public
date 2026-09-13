import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

import {
  PTY_BUFFER_CODE_UNITS,
  PTY_MAX_RETAINED_SESSIONS,
  PTY_MAX_SESSIONS,
  boundedRead,
  boundedTimeout,
  containedWorkdir,
  decodedInput,
  deliveredPtyNotification,
  externalPtyPaths,
  idlePtyRead,
  interactivePtyPermission,
  isolatedPtyCommand,
  permissionCommands,
  pinnedRuntime,
  presentedPtySession,
  prunablePtyRecords,
  refreshPtyLiveness,
  resolvedPtyCommand,
  scrubbedPtyEnvironment,
} from './opencode-pty-core.mjs';
import manifest from '../vendor/opencode-pty/package.json' with { type: 'json' };
import lock from '../vendor/opencode-pty/package-lock.json' with { type: 'json' };

const moduleAt = (path) => new URL(`../vendor/opencode-pty/node_modules/opencode-pty/dist/src/plugin/pty/${path}`, import.meta.url).href;

const terminalSession = (session) => session?.status === 'exited' || session?.status === 'killed';

const signalable = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const processGroupAlive = (pid) => Number.isInteger(pid) && pid > 0 && (signalable(-pid) || signalable(pid));

const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
};

export const KsaiPtyPilot = async ({ client }) => {
  if (!pinnedRuntime(manifest, lock)) throw new Error('the PTY runtime differs from the audited pins');
  process.env.PTY_MAX_BUFFER_SIZE = String(PTY_BUFFER_CODE_UNITS);
  const [{ initManager, manager, registerSessionUpdateCallback, removeSessionUpdateCallback }, { ptySpawn }, { ptyWrite }, { ptyRead }, { ptyList }, { ptyKill }, { formatSessionInfo }] = await Promise.all([
    import(moduleAt('manager.js')),
    import(moduleAt('tools/spawn.js')),
    import(moduleAt('tools/write.js')),
    import(moduleAt('tools/read.js')),
    import(moduleAt('tools/list.js')),
    import(moduleAt('tools/kill.js')),
    import(moduleAt('formatters.js')),
  ]);

  const metricsFile = String(process.env.KSAI_PTY_METRICS_FILE ?? '');
  const pidFile = String(process.env.KSAI_PTY_PID_FILE ?? '');
  const liveFixture = process.env.KSAI_PTY_LIVE_FIXTURE === 'true';
  const metrics = {
    version: 1,
    tool_calls: { pty_spawn: 0, pty_write: 0, pty_read: 0, pty_list: 0, pty_kill: 0 },
    idle_reads: 0,
    sessions_started: 0,
    sessions_completed: 0,
    active_sessions: 0,
    forced_cleanup_count: 0,
    leaked_process_count: null,
    session_duration_ms: [],
  };
  const sessions = new Map();
  const notifications = [];
  const persist = () => {
    if (!metricsFile) return;
    try {
      writeFileSync(metricsFile, `${JSON.stringify(metrics)}\n`);
    } catch {}
  };
  const persistPids = () => {
    if (!pidFile) return;
    try {
      const live = [...sessions.values()]
        .filter((record) => !record.dead && processGroupAlive(record.pid))
        .map((record) => record.pid);
      writeFileSync(pidFile, `${JSON.stringify(live)}\n`);
    } catch {}
  };
  const scheduleHardStop = (record) => {
    if (record.dead || record.hardStop || !processGroupAlive(record.pid)) return;
    record.hardStop = setTimeout(() => {
      if (processGroupAlive(record.pid)) signalProcessGroup(record.pid, 'SIGKILL');
    }, 2_000);
    record.hardStop.unref();
  };
  const refresh = () => {
    const { active, newlyDead } = refreshPtyLiveness(sessions, processGroupAlive);
    for (const record of newlyDead) {
      if (record.timeoutStop) clearTimeout(record.timeoutStop);
      if (record.hardStop) clearTimeout(record.hardStop);
    }
    metrics.active_sessions = active;
    persistPids();
  };
  const update = (session) => {
    let record = sessions.get(session.id);
    if (session.status === 'running' && !record) {
      record = { id: session.id, pid: session.pid, started: Date.parse(session.createdAt), completed: false, cleanup: false, notified: false, notificationFailed: false, dead: false, exit: null, timeoutStop: null, hardStop: null, readObserved: false, lastReadRaw: '' };
      sessions.set(session.id, record);
      record.timeoutStop = setTimeout(() => {
        record.timeoutStop = null;
        scheduleHardStop(record);
      }, session.timeoutSeconds * 1000);
      record.timeoutStop.unref();
      metrics.sessions_started += 1;
    } else if (terminalSession(session) && record && !record.completed) {
      if (record.timeoutStop) clearTimeout(record.timeoutStop);
      record.timeoutStop = null;
      record.completed = true;
      record.exit = session;
      metrics.sessions_completed += 1;
      metrics.session_duration_ms.push(Math.max(0, Date.now() - record.started));
      if (metrics.session_duration_ms.length > PTY_MAX_RETAINED_SESSIONS) metrics.session_duration_ms.shift();
      scheduleHardStop(record);
    }
    refresh();
    persist();
  };
  registerSessionUpdateCallback(update);

  const notify = async (input) => {
    const body = input?.body;
    const delivered = new Set();
    for (const part of body?.parts ?? []) {
      if (part?.type !== 'text' || !String(part.text).startsWith('<pty_exited>')) continue;
      const id = /^ID: (.+)$/m.exec(part.text)?.[1];
      const record = id ? sessions.get(id) : null;
      const info = id ? manager.get(id) ?? record?.exit : null;
      if (info?.exitSignal != null) {
        part.text = part.text.replace(/^Exit Code: .*$/m, `Exit Code: signal ${info.exitSignal}`);
      } else if (info?.exitCode != null) {
        part.text = part.text.replace(/^Exit Code: .*$/m, `Exit Code: ${info.exitCode}`);
      } else {
        part.text = part.text.replace(/^Exit Code: .*$/m, 'Exit Code: unknown');
      }
      if (liveFixture) {
        notifications.push(part.text);
        if (notifications.length > PTY_MAX_RETAINED_SESSIONS) notifications.shift();
      }
      if (record) delivered.add(record);
    }
    if (liveFixture) {
      for (const record of delivered) record.notified = true;
      return;
    }
    return deliveredPtyNotification(delivered, () => client.session.promptAsync(input));
  };
  initManager({ session: { promptAsync: notify } });
  persist();

  const stop = (id, cleanup = false) => {
    const session = manager.get(id);
    if (!session) return false;
    const record = sessions.get(id);
    if (record) {
      record.cleanup ||= cleanup;
      if (record.timeoutStop) clearTimeout(record.timeoutStop);
      record.timeoutStop = null;
      scheduleHardStop(record);
    }
    const stopped = manager.kill(id, false);
    refresh();
    if (record?.dead && cleanup) {
      manager.kill(id, true);
      sessions.delete(id);
      persistPids();
    }
    persist();
    return stopped;
  };

  const prune = () => {
    refresh();
    for (const record of prunablePtyRecords(sessions, PTY_MAX_RETAINED_SESSIONS - 1)) {
      manager.kill(record.id, true);
      sessions.delete(record.id);
    }
    persistPids();
  };
  const collect = () => {
    refresh();
    for (const record of [...sessions.values()].filter((one) => one.dead && one.cleanup && (one.notified || one.notificationFailed))) {
      manager.kill(record.id, true);
      sessions.delete(record.id);
    }
    persistPids();
  };

  const counted = (name, execute) => async (args, ctx) => {
    metrics.tool_calls[name] += 1;
    persist();
    return execute(args, ctx);
  };
  const ask = (ctx, pattern, source) => ctx.ask({
    permission: 'bash',
    patterns: [pattern],
    always: [],
    metadata: { source, command: pattern },
  });
  const askExternal = (ctx, access, source) => ctx.ask({
    permission: 'external_directory',
    patterns: [access.pattern],
    always: [access.pattern],
    metadata: { source, filepath: access.filepath, parentDir: access.parentDir },
  });

  const spawnTool = {
    ...ptySpawn,
    description: `${ptySpawn.description}\n\nKSAI forces exit notification, a bounded timeout and worktree-only cwd; env overrides are refused.`,
    execute: counted('pty_spawn', async (args, ctx) => {
          if (args.env && Object.keys(args.env).length) throw new Error('PTY environment overrides are disabled');
          const roots = [ctx.worktree || ctx.directory];
          const workdir = containedWorkdir(args.workdir, roots);
          const requested = resolvedPtyCommand(args.command, args.args, workdir, roots);
          for (const permission of requested.permissions) await ask(ctx, permission, 'pty_spawn');
          for (const access of externalPtyPaths(requested.args, workdir, roots)) {
            await askExternal(ctx, access, 'pty_spawn');
          }
          collect();
          const running = [...sessions.values()].filter((one) => !one.dead);
          if (running.length >= PTY_MAX_SESSIONS) throw new Error(`PTY permits at most ${PTY_MAX_SESSIONS} running sessions`);
          if (sessions.size >= PTY_MAX_RETAINED_SESSIONS) prune();
          if (sessions.size >= PTY_MAX_RETAINED_SESSIONS) throw new Error(`PTY retains at most ${PTY_MAX_RETAINED_SESSIONS} sessions`);
          const timeoutSeconds = boundedTimeout(args.timeoutSeconds, process.env.KSAI_CHANNEL_KILL_AT);
          const isolated = isolatedPtyCommand(requested.command, requested.args, workdir, !liveFixture && process.platform === 'linux');
          const info = manager.spawn({
            command: isolated.command,
            args: isolated.args,
            workdir,
            title: args.title,
            description: args.description,
            parentSessionId: ctx.sessionID,
            parentAgent: ctx.agent,
            notifyOnExit: true,
            timeoutSeconds,
            env: scrubbedPtyEnvironment(process.env),
          });
          const record = sessions.get(info.id);
          if (record) record.display = { title: args.title ?? requested.display, command: args.command, args: [...(args.args ?? [])] };
          const shown = presentedPtySession(info, record?.display);
          ctx.abort.addEventListener('abort', () => stop(info.id, true), { once: true });
          return [
            '<pty_spawned>',
            `ID: ${info.id}`,
            `Title: ${shown.title}`,
            `Command: ${requested.display}`,
            `Workdir: ${info.workdir}`,
            `PID: ${info.pid}`,
            `Status: ${info.status}`,
            'NotifyOnExit: true',
            `TimeoutSeconds: ${timeoutSeconds}`,
            '</pty_spawned>',
            '',
            '<system_reminder>Wait for the future <pty_exited> message instead of polling pty_read for completion.</system_reminder>',
          ].join('\n');
    }),
  };
  const writeTool = {
    ...ptyWrite,
    execute: counted('pty_write', async (args, ctx) => {
          const session = manager.get(args.id);
          if (!session) throw new Error(`PTY session not found: ${args.id}`);
          if (session.status !== 'running') throw new Error(`PTY session ${args.id} is ${session.status}`);
          const data = decodedInput(args.data);
          const roots = [ctx.worktree || ctx.directory];
          for (const [command, ...commandArgs] of permissionCommands(data)) {
            const permissions = interactivePtyPermission(command, commandArgs, session.workdir, roots);
            for (const permission of permissions) await ask(ctx, permission, 'pty_write');
            for (const access of externalPtyPaths(commandArgs, session.workdir, roots)) {
              await askExternal(ctx, access, 'pty_write');
            }
          }
          if (!manager.write(args.id, data)) throw new Error(`PTY write failed: ${args.id}`);
          return `Sent ${Buffer.byteLength(data)} bounded bytes to ${args.id}`;
    }),
  };
  const readTool = {
    ...ptyRead,
    description: `${ptyRead.description}\n\nKSAI treats pattern as a bounded literal string, not a regular expression.`,
    execute: counted('pty_read', async (args, ctx) => {
          const before = manager.get(args.id);
          const bounded = boundedRead(args);
          const output = await ptyRead.execute({ ...args, ...bounded }, ctx);
          const after = manager.get(args.id);
          const currentRaw = manager.getRawBuffer(args.id)?.raw;
          const record = sessions.get(args.id);
          if (idlePtyRead(before?.status, after?.status, record?.readObserved, record?.lastReadRaw, currentRaw)) {
            metrics.idle_reads += 1;
            persist();
          }
          if (record) {
            record.readObserved = true;
            record.lastReadRaw = currentRaw;
          }
          return output;
    }),
  };
  const listTool = {
    ...ptyList,
    execute: counted('pty_list', (_args, _ctx) => {
      collect();
      const held = manager.list();
      if (held.length === 0) return '<pty_list>\nNo active PTY sessions.\n</pty_list>';
      const lines = ['<pty_list>'];
      for (const session of held) lines.push(...formatSessionInfo(presentedPtySession(session, sessions.get(session.id)?.display)));
      lines.push(`Total: ${held.length} session(s)`, '</pty_list>');
      return lines.join('\n');
    }),
  };
  const killTool = {
    ...ptyKill,
    execute: counted('pty_kill', async (args) => {
      const session = manager.get(args.id);
      if (!session) throw new Error(`PTY session not found: ${args.id}`);
      const shown = presentedPtySession(session, sessions.get(args.id)?.display);
      refresh();
      const wasActive = !sessions.get(args.id)?.dead;
      const cleanup = args.cleanup ?? false;
      if (!stop(args.id, cleanup)) throw new Error(`PTY kill failed: ${args.id}`);
      const cleanupNote = cleanup ? wasActive ? ' (cleanup after exit)' : ' (session removed)' : ' (session retained for log access)';
      return [
        '<pty_killed>',
        `${wasActive ? 'Stopped' : 'Cleaned up'}: ${args.id}${cleanupNote}`,
        `Title: ${shown.title}`,
        `Command: ${shown.command} ${shown.args.join(' ')}`,
        `Final line count: ${session.lineCount}`,
        '</pty_killed>',
      ].join('\n');
    }),
  };
  const tools = { pty_spawn: spawnTool, pty_write: writeTool, pty_read: readTool, pty_list: listTool, pty_kill: killTool };
  if (liveFixture) {
    tools.ksai_pty_live_fixture = {
      ...ptyList,
      description: 'Exercise the private KSAI PTY live fixture.',
      execute: async (_args, ctx) => {
        const waitFor = async (predicate, label) => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value;
            await new Promise((resolve) => { setTimeout(resolve, 20); });
          }
          throw new Error(`PTY live fixture timed out waiting for ${label}`);
        };
        const fixture = fileURLToPath(new URL('./fixtures/opencode-pty-live.mjs', import.meta.url));
        const spawned = await spawnTool.execute({ command: 'node', args: [fixture], workdir: ctx.worktree, description: 'PTY live fixture', timeoutSeconds: 10 }, ctx);
        const id = /^ID: (.+)$/m.exec(spawned)?.[1];
        if (!id) throw new Error('PTY live fixture returned no session id');
        const ready = await waitFor(() => /READY http:\/\/127\.0\.0\.1:\d+/.exec(manager.getRawBuffer(id)?.raw ?? ''), 'server readiness');
        const response = await fetch(ready[0].slice('READY '.length));
        if (await response.text() !== 'healthy') throw new Error('PTY live fixture server was not healthy');
        await writeTool.execute({ id, data: 'ping\\n' }, ctx);
        await waitFor(() => (manager.getRawBuffer(id)?.raw ?? '').includes('PONG'), 'interactive response');
        await writeTool.execute({ id, data: 'fail\\n' }, ctx);
        await waitFor(() => manager.get(id)?.status !== 'running', 'failure exit');
        const failed = manager.get(id);
        const failureOutput = await readTool.execute({ id, offset: 0, limit: 200 }, ctx);
        if (failed?.exitCode !== 7 || !String(failureOutput).includes('FINAL_FAILURE')) {
          throw new Error(`PTY live fixture lost failure diagnostics or exit code: ${failed?.exitCode}`);
        }
        await waitFor(() => notifications.some((one) => one.includes(`ID: ${id}`) && one.includes('Exit Code: 7') && one.includes('Last Line: FINAL_FAILURE')), 'failure notification');
        await killTool.execute({ id, cleanup: true }, ctx);

        const timeoutSpawn = await spawnTool.execute({ command: 'node', args: [fixture, 'stubborn-tree'], workdir: ctx.worktree, description: 'PTY timeout fixture', timeoutSeconds: 1 }, ctx);
        const timeoutId = /^ID: (.+)$/m.exec(timeoutSpawn)?.[1];
        if (!timeoutId) throw new Error('PTY timeout fixture returned no session id');
        await waitFor(() => {
          refresh();
          return manager.get(timeoutId)?.timedOut === true && sessions.get(timeoutId)?.dead;
        }, 'timeout cleanup');
        await waitFor(() => notifications.some((one) => one.includes(`ID: ${timeoutId}`) && one.includes('Exit Code: signal')), 'timeout signal notification');
        await killTool.execute({ id: timeoutId, cleanup: true }, ctx);

        await listTool.execute({}, ctx);
        if (manager.list().length !== 0) throw new Error('PTY live fixture leaked retained sessions');
        return '<pty_fixture>PASS: server, readiness, interaction, failure, timeout, notification and cleanup</pty_fixture>';
      },
    };
  }

  return {
    tool: tools,
    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        for (const session of manager.list().filter((one) => one.parentSessionId === event.properties.info.id)) stop(session.id, true);
      }
    },
    dispose: async () => {
      refresh();
      const running = [...sessions.values()].filter((one) => !one.dead);
      metrics.forced_cleanup_count += running.length;
      for (const record of running) stop(record.id);
      const deadline = Date.now() + 2_500;
      while ([...sessions.values()].some((one) => !one.dead) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        refresh();
      }
      const remaining = [...sessions.values()].filter((one) => !one.dead);
      metrics.active_sessions = remaining.length;
      metrics.leaked_process_count = remaining.length;
      for (const record of [...sessions.values()].filter((one) => one.dead)) {
        manager.kill(record.id, true);
        sessions.delete(record.id);
      }
      removeSessionUpdateCallback(update);
      persistPids();
      persist();
    },
  };
};
