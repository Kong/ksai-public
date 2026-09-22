'use strict';

function runSettingsArmOf(source) {
  const current = source?.run_settings_arm;
  return current === undefined || current === null ? source?.dials_arm ?? null : current;
}

module.exports = { runSettingsArmOf };
