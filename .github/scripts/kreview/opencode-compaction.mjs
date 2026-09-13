import { appendFileSync, statSync } from 'node:fs';

const MAX_EVENTS = 64;
const MAX_BYTES = 32 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * KsaiCompactionObserver records the lifecycle boundary absent from `run --format json`.
 *
 * This module exports one function because OpenCode calls every plugin-file export as a plugin.
 */
export const KsaiCompactionObserver = async () => {
  const path = String(process.env.KSAI_COMPACTION_FILE ?? '');
  if (!path) return {};

  let events = 0;
  let writable = true;
  const append = (record) => {
    if (!writable) return false;
    try {
      const line = `${JSON.stringify(record)}\n`;
      if (statSync(path).size + Buffer.byteLength(line) > MAX_BYTES) {
        writable = false;
        return false;
      }
      appendFileSync(path, line, { encoding: 'utf8' });
      return true;
    } catch {
      writable = false;
      return false;
    }
  };

  if (!append({ type: 'ksai_compaction_ready', version: 1 })) return {};
  process.once('exit', () => append({ type: 'ksai_compaction_complete', version: 1 }));
  return {
    event: async ({ event }) => {
      if (event?.type !== 'session.compacted') return;
      if (events >= MAX_EVENTS) {
        append({ type: 'ksai_compaction_overflow' });
        writable = false;
        return;
      }
      const session = String(event?.properties?.sessionID ?? '');
      if (!SESSION.test(session)) {
        append({ type: 'ksai_compaction_invalid' });
        writable = false;
        return;
      }
      if (append({ type: 'session.compacted', session_id: session, observed_at_ms: Date.now() })) events += 1;
    },
  };
};
