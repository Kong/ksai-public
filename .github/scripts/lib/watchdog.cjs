const MAX_REASON_CHARS = 160;

const ASSUMED_CEILING_MINUTES = 35;

const SALVAGE_MARGIN_MINUTES = 1;

const CEILING_SHAPE = /^[0-9]+$/;

function ceilingMinutes(value) {
  const said = String(value ?? '').trim();
  if (said === '') return ASSUMED_CEILING_MINUTES;
  if (!CEILING_SHAPE.test(said)) return null;
  const minutes = Number(said);
  return minutes > SALVAGE_MARGIN_MINUTES ? minutes : null;
}

/**
 * watchdogDetail names what the watchdog counted, or nothing when it recorded no reason.
 *
 * The caller splices this into a body that goes through `scrub` as a whole, which is what makes it
 * publishable at all: the repeat reason quotes a tool detail the model wrote. It is flattened here
 * because a step output cannot carry a newline and a body that grew one would break the sentence. The
 * cut counts code points rather than UTF-16 units, or it splits a surrogate pair the way `plain` does
 * not and the published comment ends in a replacement character.
 */
function watchdogDetail(env) {
  const said = String(env?.WATCHDOG_REASON ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!said) return '';
  const kept = [...said];
  const shown =
    kept.length > MAX_REASON_CHARS ? `${kept.slice(0, MAX_REASON_CHARS - 1).join('')}…` : said;
  return ` It stopped because ${shown}.`;
}

module.exports = { ASSUMED_CEILING_MINUTES, MAX_REASON_CHARS, SALVAGE_MARGIN_MINUTES, ceilingMinutes, watchdogDetail };
