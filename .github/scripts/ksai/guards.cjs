'use strict';

const loadKsaiConfig = require('./config.cjs');
const { parseDisabledCommands } = require('../lib/select-arm.cjs');
const { bareMode } = require('./bare.cjs');
const { STOP_MODES } = require('./halt.cjs');

const listed = (text) =>
  String(text ?? '')
    .split(/[,\n]/)
    .map((one) => one.trim())
    .filter(Boolean);

function bareOf(input, fromFile, bare) {
  if (String(input ?? '').trim() === '') return String(fromFile ?? '').trim().toLowerCase() === 'off' ? 'off' : '';
  return bare.error ? String(input) : bare.mode;
}

function stopOf(input, fromFile) {
  const asked = String(input ?? '').trim().toLowerCase();
  if (asked !== '' && !STOP_MODES.includes(asked)) return String(input);
  return fromFile === 'hard' ? 'hard' : asked || 'soft';
}

function combinedGuards({ served, config }) {
  const bare = bareMode({ input: served.bare_comments, fromFile: config.bareComments ?? '' });
  const approval = String(served.require_plan_approval ?? '').trim() === 'true' || config.requirePlanApproval === true;
  return {
    disabled_commands: [
      ...new Set([...parseDisabledCommands(served.disabled_commands), ...(config.disabledCommands ?? [])]),
    ].join(','),
    denied_paths: [...new Set([...listed(served.denied_paths), ...(config.deniedPaths ?? [])])].join(','),
    require_plan_approval: approval ? 'true' : 'false',
    bare_comments: bareOf(served.bare_comments, config.bareComments, bare),
    stop_mode: stopOf(served.stop_mode, config.halt?.mode),
  };
}

async function readGuards({ github, core, context, env }) {
  const config = await loadKsaiConfig({ github, core, owner: context.repo.owner, repo: context.repo.repo });
  if (!config.error) return config;
  if (config.unread || env.CONTINUATION === 'true') {
    core.setFailed(`${config.error}, so the guards this repository sets cannot be read and nothing runs.`);
    return null;
  }
  core.warning(`${config.error}; every job that reads the file refuses this run and says why.`);
  return {};
}

async function guards({ github, core, context, env }) {
  const config = await readGuards({ github, core, context, env });
  if (config === null) return;
  const served = {
    disabled_commands: env.DISABLED_COMMANDS,
    denied_paths: env.DENIED_PATHS,
    require_plan_approval: env.REQUIRE_PLAN_APPROVAL,
    bare_comments: env.BARE_COMMENTS,
    stop_mode: env.STOP_MODE,
  };
  for (const [name, value] of Object.entries(combinedGuards({ served, config }))) core.setOutput(name, value);
}

module.exports = { combinedGuards, guards };
