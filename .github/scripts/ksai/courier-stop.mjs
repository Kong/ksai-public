import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const DRAIN_SECONDS = 90;

const PID_SHAPE = /^[1-9][0-9]*$/;

const quietly = (act) => {
  try {
    act();
    return true;
  } catch {
    return false;
  }
};

const sizeOf = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

export async function stopCourier({
  pidFile = '',
  channelDir = '',
  kill = process.kill.bind(process),
  sleep = delay,
  drainSeconds = DRAIN_SECONDS,
  log = console.log,
} = {}) {
  if (pidFile && existsSync(pidFile)) {
    const text = readFileSync(pidFile, 'utf8').trim();
    const pid = PID_SHAPE.test(text) ? Number(text) : 0;
    const alive = () => quietly(() => kill(pid, 0));

    if (pid > 0 && quietly(() => kill(pid, 'SIGTERM'))) {
      for (let waited = 0; waited < drainSeconds && alive(); waited += 1) await sleep(1000);
      if (alive()) {
        log(`::warning::The courier did not drain within ${drainSeconds} seconds, so it will be stopped now`);
        quietly(() => kill(pid, 'SIGKILL'));
      }
    } else if (pid > 0) {
      log('The courier had already exited');
    } else {
      log(`::warning::${pidFile} names no single process, so the courier was left alone`);
    }
    rmSync(pidFile, { force: true });
  }

  const courierLog = join(channelDir, 'courier.log');
  if (channelDir && sizeOf(courierLog) > 0) {
    log('::group::What the courier read');
    log(readFileSync(courierLog, 'utf8').replace(/\n$/, ''));
    log('::endgroup::');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await stopCourier({ pidFile: process.env.PID_FILE, channelDir: process.env.CHANNEL_DIR });
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
