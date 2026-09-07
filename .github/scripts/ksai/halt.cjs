'use strict';

const STOP_MODES = Object.freeze(['soft', 'hard']);

const PRESERVE_MODES = Object.freeze(['auto', 'off']);

const DEFAULT_GRACE_SECONDS = 120;

const DEFAULT_WARN_SECONDS = 60;

const MAX_GRACE_SECONDS = 900;

const asMode = (value, modes) => {
  const said = String(value ?? '').trim().toLowerCase();
  return modes.includes(said) ? said : null;
};

function seconds(value, fallback) {
  const said = String(value ?? '').trim();
  if (said === '') return fallback;
  if (!/^[0-9]{1,4}$/.test(said)) return null;
  const held = Number(said);
  return held > MAX_GRACE_SECONDS ? null : held;
}

function stopSettings({
  mode = '',
  preserve = '',
  grace = '',
  warn = '',
  fileMode = '',
  filePreserve = '',
  fileGrace = '',
  fileWarn = '',
} = {}) {
  const askedMode = asMode(mode, STOP_MODES);
  if (askedMode === null && String(mode ?? '').trim() !== '') {
    return { error: `stop_mode must be one of ${STOP_MODES.join(', ')}, got '${String(mode)}'` };
  }
  const askedPreserve = asMode(preserve, PRESERVE_MODES);
  if (askedPreserve === null && String(preserve ?? '').trim() !== '') {
    return { error: `stop_preserve must be one of ${PRESERVE_MODES.join(', ')}, got '${String(preserve)}'` };
  }
  const askedGrace = seconds(grace, DEFAULT_GRACE_SECONDS);
  if (askedGrace === null) {
    return { error: `stop_grace_seconds must be a whole number of seconds up to ${MAX_GRACE_SECONDS}, got '${String(grace)}'` };
  }
  const askedWarn = seconds(warn, DEFAULT_WARN_SECONDS);
  if (askedWarn === null) {
    return { error: `stop_warn_seconds must be a whole number of seconds up to ${MAX_GRACE_SECONDS}, got '${String(warn)}'` };
  }

  const heldGrace = seconds(fileGrace, askedGrace);
  const heldWarn = seconds(fileWarn, askedWarn);
  const resolvedMode = asMode(fileMode, STOP_MODES) === 'hard' ? 'hard' : askedMode ?? 'soft';
  const resolvedPreserve = asMode(filePreserve, PRESERVE_MODES) === 'off' ? 'off' : askedPreserve ?? 'auto';
  const resolvedGrace = resolvedMode === 'hard' ? 0 : Math.min(askedGrace, heldGrace === null ? askedGrace : heldGrace);
  const resolvedWarn = Math.min(resolvedGrace, heldWarn === null ? askedWarn : Math.min(askedWarn, heldWarn));

  const outputs = {
    mode: resolvedMode,
    preserve: resolvedPreserve,
    grace: resolvedGrace,
    warn: resolvedWarn,
  };
  return outputs;
}

module.exports = {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_WARN_SECONDS,
  MAX_GRACE_SECONDS,
  PRESERVE_MODES,
  STOP_MODES,
  stopSettings,
};
