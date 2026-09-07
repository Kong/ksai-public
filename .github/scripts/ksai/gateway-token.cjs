'use strict';

const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const HELPER_NAME = 'ksai-gateway-token.sh';
const URL_VAR = 'KSAI_OIDC_REQUEST_URL';
const TOKEN_VAR = 'KSAI_OIDC_REQUEST_TOKEN';

function helperScript(audience) {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'curl --silent --show-error --fail-with-body --max-time 20 --retry 3 \\',
    `  --header "Authorization: Bearer \${${TOKEN_VAR}}" \\`,
    `  "\${${URL_VAR}}&audience=${encodeURIComponent(audience)}" \\`,
    '  | jq --exit-status --raw-output .value',
    '',
  ].join('\n');
}

function writeGatewayTokenHelper({ core, audience, env = process.env }) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    core.setFailed('this job holds no OIDC request token, so id-token: write is missing and no run can authenticate to the gateway');
    return '';
  }

  core.setSecret(requestToken);
  core.exportVariable(URL_VAR, url);
  core.exportVariable(TOKEN_VAR, requestToken);

  const helper = path.join(String(env.RUNNER_TEMP), HELPER_NAME);
  writeFileSync(helper, helperScript(audience), { mode: 0o700 });

  const {
    ACTIONS_ID_TOKEN_REQUEST_URL: _requestUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: _requestToken,
    ...withoutTheMint
  } = env;
  const asTheCliWillSee = { ...withoutTheMint, [URL_VAR]: url, [TOKEN_VAR]: requestToken };

  let token = '';
  try {
    token = execFileSync(helper, { encoding: 'utf8', env: asTheCliWillSee }).trim();
  } catch (error) {
    core.setFailed(`the credential helper could not mint against ${audience}: ${error.message}`);
    return '';
  }

  core.setSecret(token);
  if (token.split('.').length !== 3) {
    core.setFailed(`the credential helper did not print a JWT, so no run can reach ${audience}`);
    return '';
  }

  return helper;
}

module.exports = { writeGatewayTokenHelper, helperScript, HELPER_NAME, URL_VAR, TOKEN_VAR };
