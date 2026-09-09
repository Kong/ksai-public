import { appendFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { streams as opencodeStreams } from '../kreview/opencode-progress.mjs';
import { POLL_SECONDS, deliver, octokitOver, sweep } from './courier.mjs';
import { read as claudeStreams } from './progress.mjs';
import { armed as reporting, tick } from './status.mjs';

const require = createRequire(import.meta.url);

const wait = (seconds) => new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });

const say = (stateDir, line) => {
  try {
    appendFileSync(join(stateDir, 'courier.log'), `${line}\n`);
  } catch {
    return false;
  }
  return true;
};

const loadAuthorize = () => require('../codeowners-authz/authorize.cjs');

const stopLatch = (signals) => {
  let asked = false;
  const ask = () => { asked = true; };
  signals.once('SIGTERM', ask);
  return { asked: () => asked, close: () => signals.off('SIGTERM', ask) };
};

export function authorizerOver({ github, owner, repo, load = loadAuthorize, writeAccessCommands = null }) {
  let authorize;
  try {
    authorize = load();
  } catch {
    return null;
  }
  const opens = String(writeAccessCommands ?? '').trim() !== '';
  let cache = Object.create(null);
  return async (username) => {
    let stuck = false;
    const core = {
      info() {},
      debug() {},
      warning() {},
      error() {},
      setFailed() {
        stuck = true;
      },
    };
    const allowed = await authorize({ github, core, owner, repo, username, cache });
    if (stuck) {
      cache = Object.create(null);
      return null;
    }
    if (allowed === true) return true;
    if (!opens) return false;
    if (typeof authorize.writeAccess !== 'function') return null;
    const holds = await authorize.writeAccess({ github, core, owner, repo, username, cache });
    if (holds === 'true') return true;
    if (holds === 'false') return false;
    cache = Object.create(null);
    return null;
  };
}

/**
 * readerFor answers the streams the status is measured from, by name and never through a variable
 * holding a module path.
 *
 * A run has one engine and each writes its work somewhere different: a session transcript under
 * `$HOME`, or the event stream this job redirected to a file. Both are reduced to the same array,
 * which is why one reader can be swapped for the other here and nothing below reads an engine.
 *
 * The reader is bound to the environment the courier was handed rather than reading `process.env`
 * of its own, so what a test states is what the reading is taken from.
 */
export function readerFor(env = process.env) {
  return String(env.ENGINE ?? '') === 'opencode' ? () => opencodeStreams(env) : claudeStreams;
}

export async function main(
  env = process.env,
  { fetchImpl = fetch, sleep = wait, once = false, load = loadAuthorize, statusTick = tick, signals = process } = {},
) {
  const stateDir = String(env.CHANNEL_DIR ?? '');
  const repo = String(env.REPO ?? '');
  const number = String(env.THREAD_NUM ?? '');
  const sourceToken = String(env.COURIER_SOURCE_TOKEN ?? '');
  const authToken = String(env.COURIER_AUTH_TOKEN ?? '');
  const apiUrl = String(env.GITHUB_API_URL ?? 'https://api.github.com');
  if (stateDir === '' || repo === '' || number === '' || sourceToken === '' || authToken === '') return 0;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return 0;
  const armed = Number(env.ARMED_AT_MS);
  const since = new Date(Number.isFinite(armed) && armed > 0 ? armed : Date.now()).toISOString();
  const github = octokitOver(authToken, fetchImpl, apiUrl);
  const inbox = join(stateDir, 'inbox');
  const carrying = existsSync(inbox);
  const watching = carrying ? inbox : stateDir;
  const authorize = carrying
    ? authorizerOver({ github, owner, repo: name, load, writeAccessCommands: env.WRITE_ACCESS_COMMANDS })
    : () => false;
  if (!authorize) {
    say(stateDir, 'the courier could not load the authorization it carries every comment through, so it read none');
    return 0;
  }
  const streamsOf = readerFor(env);
  const seen = new Set();
  if (carrying) {
    say(stateDir, `watching ${repo}#${number} for what is written after ${since}`);
    if (String(env.OWN_PULL ?? '') === 'true') {
      say(stateDir, 'this is a pull request this flow opened, so a comment naming no command is carried too');
    }
  } else {
    say(stateDir, 'this run has no channel, so nothing is carried in and the status is all that goes out');
  }
  if (reporting(env)) say(stateDir, 'reporting this run’s status onto the comment it opened with');
  const stopping = stopLatch(signals);
  let status = {};
  let statusTask = null;
  const startStatus = () => {
    if (statusTask) return statusTask;
    statusTask = Promise.resolve()
      .then(() => statusTick(status, env, { fetchImpl, streamsOf }))
      .then((next) => { status = next; return next; })
      .catch((error) => { say(stateDir, `a status could not be published: ${error}`); return status; })
      .finally(() => { statusTask = null; });
    return statusTask;
  };
  try {
    while (existsSync(watching) && !stopping.asked()) {
      let swept = { records: [], refused: [], unresolved: [] };
      try {
        if (carrying) {
          swept = await sweep({
            repo,
            number,
            since,
            token: sourceToken,
            triggerPhrase: String(env.TRIGGER_PHRASE ?? ''),
            botLogin: String(env.BOT_LOGIN ?? ''),
            ownPull: String(env.OWN_PULL ?? '') === 'true',
            graceSeconds: Number(env.STOP_GRACE_SECONDS ?? 0),
            hardStop: String(env.STOP_MODE ?? '') === 'hard',
            authorize,
            seen,
            apiUrl,
            fetchImpl,
          });
        }
      } catch (error) {
        say(stateDir, `a poll could not be made: ${error}`);
      }
      for (const { id, record, at } of swept.records) {
        try {
          deliver(stateDir, id, record, at);
          seen.add(id);
          say(stateDir, `delivered ${record.kind} ${id}`);
        } catch (error) {
          say(stateDir, `a record could not be written: ${error}`);
        }
      }
      for (const login of swept.refused) say(stateDir, `refused a comment: ${login} owns nothing here`);
      for (const login of swept.unresolved) {
        say(stateDir, `could not tell whether ${login} may steer this run, so their comment was left where it was`);
      }
      const runningStatus = startStatus();
      if (once) {
        await runningStatus;
        return 0;
      }
      await sleep(POLL_SECONDS);
    }
    if (stopping.asked() && statusTask) await statusTask;
    return 0;
  } finally {
    stopping.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
