import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CGROUP_ROOT = '/sys/fs/cgroup';

const commandError = (result) => `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim() || `exit ${result?.status ?? 'unknown'}`;

async function removeAbandonedCgroup(at) {
  let failure = 'the abandoned cgroup remained populated';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = spawnSync('sudo', ['--non-interactive', 'tee', '--', `${at}/cgroup.kill`], {
      encoding: 'utf8', input: '1\n',
    });
    if (result.status !== 0) {
      failure = `cannot kill the abandoned cgroup: ${commandError(result)}`;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
      continue;
    }
    const events = spawnSync('sudo', ['--non-interactive', 'cat', '--', `${at}/cgroup.events`], { encoding: 'utf8' });
    if (events.status !== 0) {
      failure = `cannot read the abandoned cgroup state: ${commandError(events)}`;
    } else if (/^populated 0$/m.test(String(events.stdout))) {
      const removed = spawnSync('sudo', ['--non-interactive', 'rmdir', '--', at], { encoding: 'utf8' });
      if (removed.status === 0) return '';
      failure = `cannot remove the empty cgroup: ${commandError(removed)}`;
    }
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
  }
  return failure;
}

const notify = (message) => new Promise((resolvePromise) => {
  if (!process.send) {
    resolvePromise();
    return;
  }
  process.send(message, () => resolvePromise());
});

async function guardCgroup(at, parent) {
  let cleaning = false;
  const cleanup = async (reason) => {
    if (cleaning) return;
    cleaning = true;
    clearInterval(parentWatch);
    const failure = await removeAbandonedCgroup(at);
    if (failure) console.error(`cannot remove abandoned native resource cgroup ${at}: ${failure}`);
    await notify({ type: 'cleaned', removed: !failure, reason });
    process.exit(failure ? 1 : 0);
  };
  const parentWatch = setInterval(() => {
    if (process.ppid !== parent) void cleanup('parent');
  }, 50);
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
    process.once(signal, () => void cleanup(signal));
  }
  process.on('message', (message) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'cleanup') {
      void cleanup('requested');
    }
  });
  if (process.ppid !== parent) return cleanup('parent');
  await notify({ type: 'ready', at });
}

async function runInCgroup(at, _returnAt, parent, command, args) {
  if (process.ppid !== parent) {
    const failure = await removeAbandonedCgroup(at);
    if (failure) console.error(`cannot remove abandoned native resource cgroup ${at}: ${failure}`);
    throw new Error('the model runner exited before the native resource wrapper started');
  }
  const joined = spawnSync('sudo', ['--non-interactive', 'tee', '--', `${at}/cgroup.procs`], {
    encoding: 'utf8', input: `${process.pid}\n`,
  });
  if (joined.status !== 0) throw new Error(`cannot join the native resource cgroup: ${joined.stderr || `exit ${joined.status}`}`);
  if (process.ppid !== parent) {
    throw new Error('the model runner exited before the native resource cgroup was joined');
  }
  const child = spawn(command, args, { stdio: 'inherit' });
  const handlers = [
    { signal: 'SIGINT', handler: () => child.kill('SIGINT') },
    { signal: 'SIGHUP', handler: () => child.kill('SIGHUP') },
    { signal: 'SIGTERM', handler: () => child.kill('SIGTERM') },
  ];
  for (const { signal, handler } of handlers) {
    process.once(signal, handler);
  }
  return new Promise((resolvePromise) => {
    let finished = false;
    const finish = async (code) => {
      if (finished) return;
      finished = true;
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      resolvePromise(code);
    };
    child.on('error', () => void finish(127));
    child.on('close', (code, signal) => void finish(code ?? (signal ? 1 : 0)));
  });
}

async function preflight() {
  const { destroyCgroup, prepareCgroup, processCgroup } = await import('./opencode-run.mjs');
  const root = processCgroup(readFileSync('/proc/self/cgroup', 'utf8'));
  const at = prepareCgroup({ root });
  if (!await destroyCgroup(at)) throw new Error(`cannot remove the native resource cgroup ${at}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [at, returnAt, parentRaw, separator, command, ...args] = process.argv.slice(2);
  const parent = Number(parentRaw);
  if (at === '--preflight') {
    try {
      await preflight();
    } catch (error) {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    }
  } else if (at === '--guard') {
    const guardReturnAt = returnAt;
    const guardParent = Number(parentRaw);
    const guardAt = `${guardReturnAt}/ksai-opencode-${guardParent}`;
    if (!(guardReturnAt === CGROUP_ROOT || new RegExp(`^${CGROUP_ROOT}/[^\\0\\n]+$`).test(guardReturnAt ?? ''))
      || guardReturnAt.split('/').some((part) => part === '.' || part === '..')
      || !Number.isSafeInteger(guardParent) || guardParent < 1 || separator !== undefined) {
      console.error('usage: opencode-cgroup.mjs --guard RETURN_CGROUP PARENT_PID');
      process.exitCode = 2;
    } else {
      try {
        await guardCgroup(guardAt, guardParent);
      } catch (error) {
        console.error(error?.message ?? String(error));
        process.exitCode = 1;
      }
    }
  } else if (at !== `${returnAt}/ksai-opencode-${parent}`
    || !(returnAt === CGROUP_ROOT || new RegExp(`^${CGROUP_ROOT}/[^\\0\\n]+$`).test(returnAt ?? ''))
    || returnAt === at || returnAt.startsWith(`${at}/`) || returnAt.split('/').some((part) => part === '.' || part === '..')
    || !Number.isSafeInteger(parent) || parent < 1 || separator !== '--' || !command) {
    console.error('usage: opencode-cgroup.mjs /sys/fs/cgroup/ksai-opencode-PID RETURN_CGROUP PARENT_PID -- COMMAND [ARG...]');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await runInCgroup(at, returnAt, parent, command, args);
    } catch (error) {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    }
  }
}
