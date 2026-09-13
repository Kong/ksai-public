'use strict';

const { safeEcho, JIRA_KEY_SHAPE } = require('../lib/select-arm.cjs');

const SITE_SHAPE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10}$/;

const PROJECT_SHAPE = /^[A-Z][A-Z0-9]{1,9}$/;

function parseProjects(raw) {
  const seen = new Set();
  for (const word of String(raw ?? '').split(/[\s,]+/)) {
    if (word) seen.add(word.toUpperCase());
  }
  return Object.freeze([...seen]);
}

function resolveKey({ planKey = null, criteriaMarker = null, projects = null } = {}) {
  const fromMarker = criteriaMarker?.kind === 'jira' ? criteriaMarker.key : '';
  const key = String(fromMarker || planKey || '').toUpperCase();
  if (!key) return { none: true };

  if (!JIRA_KEY_SHAPE.test(key)) {
    return { error: `\`${safeEcho(key)}\` is not a Jira issue key, so there is no project to check it against` };
  }
  const project = key.slice(0, key.indexOf('-'));

  const allowed = Object.freeze([...(projects ?? [])]);
  if (!allowed.length) {
    return {
      error:
        'no Jira projects are allowed in this repository, so no ticket can be read. Set `jira_projects` in ' +
        'the workflow that calls this action to the project keys this repository may plan from.',
    };
  }
  const unusable = allowed.filter((one) => !PROJECT_SHAPE.test(String(one)));
  if (unusable.length) {
    return {
      error:
        `\`jira_projects\` names ${unusable.map((one) => `\`${safeEcho(one)}\``).join(', ')}, which is not a Jira ` +
        'project key. Fix the list rather than leaving it to refuse tickets that should have been allowed.',
    };
  }
  if (!allowed.includes(project)) {
    return {
      error: `the Jira project \`${safeEcho(project)}\` is not one this repository may read. Allowed: ${allowed.join(', ')}.`,
    };
  }
  return { key };
}

function resolveKeyFrom(env) {
  return resolveKey({
    planKey: env.PLAN_KEY,
    criteriaMarker: env.STEP_KEY ? { kind: 'jira', key: env.STEP_KEY } : null,
    projects: parseProjects(env.JIRA_PROJECTS),
  });
}

module.exports = {
  SITE_SHAPE,
  PROJECT_SHAPE,
  parseProjects,
  resolveKey,
  resolveKeyFrom,
};
