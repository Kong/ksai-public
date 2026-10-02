import { canonical } from '../governance/artifacts.mjs';
import { COUNTERS, usageCounter, usageEvent } from './usage-counter.mjs';
import { ending, openUsage, saved } from './usage-source.mjs';

export const USAGE_ASK = Object.freeze({ 'ksai-link-usage': COUNTERS });

export const SNAPSHOT_EVENTS = 64;

const pairOf = (one) => canonical([one.session, one.model]);

export function usageCollector({ path, scope, send }) {
  let state = openUsage(path, scope);
  const counter = usageCounter(state.snapshots);
  const queued = new Map();
  const unacked = new Set();
  const waiting = new Set();
  let offered = false;
  let refusal = '';
  const keep = (next) => {
    try {
      state = saved(path, next);
      return true;
    } catch (error) {
      if (!refusal) refusal = `this run's usage cannot be counted: ${error.message}`;
      wake();
      return false;
    }
  };
  const wake = () => {
    for (const waiter of waiting) waiter();
  };
  const until = (settled) => new Promise((resolve, reject) => {
    const waiter = () => {
      try {
        if (!settled()) return;
        resolve();
      } catch (error) {
        reject(error);
      }
      waiting.delete(waiter);
    };
    waiting.add(waiter);
    waiter();
  });
  const undelivered = () => counter.snapshots().some((one) => {
    const { id } = usageEvent(state.source, one);
    return queued.get(pairOf(one)) !== id || unacked.has(id);
  });
  const ask = () => {
    if (!keep({ ...state, asking: true })) return;
    send('usage.source', `usage.source/${state.intent}`, { intent: state.intent, counters: COUNTERS });
  };
  const flush = () => {
    if (refusal || state.mode !== 'cumulative' || !offered) return;
    const snapshots = counter.snapshots();
    if (!keep({ ...state, snapshots })) return;
    const moved = snapshots.map((one) => [pairOf(one), usageEvent(state.source, one)]).filter(([pair, event]) => queued.get(pair) !== event.id);
    for (let at = 0; at < moved.length; at += SNAPSHOT_EVENTS) {
      const batch = moved.slice(at, at + SNAPSHOT_EVENTS);
      send('usage.snapshot', `usage.snapshot/${batch[0][1].id}`, { source: state.source, events: batch.map(([, event]) => ({ id: event.id, usage: event.usage })) });
      for (const [pair, event] of batch) {
        queued.set(pair, event.id);
        unacked.add(event.id);
      }
    }
  };
  return {
    counted(session, model, call) {
      if (refusal || state.mode === 'legacy' || state.mode === 'unavailable') return;
      try {
        counter.add(session, model, call);
        keep({ ...state, snapshots: counter.snapshots() });
      } catch (error) {
        refusal = `this run's usage cannot be counted: ${error.message}`;
        wake();
      }
    },
    admit(session, model) {
      if (refusal || state.mode !== 'cumulative') return refusal;
      const why = offered ? counter.admits(session, model) : 'the engine no longer takes cumulative usage';
      if (why) {
        refusal = `session ${session} on ${model} may make no provider call, because ${why} and the control plane could not take its usage`;
        wake();
      }
      return refusal;
    },
    welcomed(body) {
      offered = body?.usage?.counters === COUNTERS;
      if (offered && !refusal) {
        if (state.mode === 'unregistered' || state.mode === 'ambiguous') ask();
        flush();
      }
      wake();
    },
    answered(body) {
      if (body?.intent !== state.intent || refusal) return;
      if (body.outcome === 'refused') {
        refusal = `the control plane refused this run's usage source (${body.reason}), so its usage cannot be counted`;
      } else if (body.outcome === 'registered' && state.source !== null && state.source !== body.source) {
        refusal = `the engine answered source ${body.source} for the intent registered as ${state.source}`;
      } else if (body.outcome === 'registered') {
        if (keep({ ...state, source: body.source, mode: 'cumulative', asking: false })) flush();
      } else if (body.outcome === 'unavailable' && state.mode !== 'cumulative') {
        keep({ ...state, mode: 'unavailable', asking: false });
      }
      wake();
    },
    acked(message) {
      if (message?.kind !== 'usage.snapshot') return;
      for (const event of message.body?.events ?? []) unacked.delete(event.id);
      wake();
    },
    tick: () => flush(),
    ready: () => until(() => {
      if (!refusal && state.mode === 'cumulative' && !offered) refusal = 'the engine no longer takes this registered run\'s cumulative usage, and a registered run never falls back to the legacy report';
      if (!refusal && (state.mode === 'ambiguous' || state.asking) && !offered) refusal = 'this run\'s usage source registration may have committed and was never confirmed, and the engine takes no cumulative usage to confirm it';
      if (refusal) throw new Error(refusal);
      return state.mode === 'cumulative' || state.mode === 'unavailable' || state.mode === 'legacy' || (!offered && state.mode === 'unregistered');
    }),
    delivered(nudge = () => {}) {
      flush();
      const kept = () => refusal !== '' || !offered || state.mode !== 'cumulative' || !undelivered();
      if (!kept()) nudge();
      return until(kept);
    },
    legacy() {
      if (refusal || state.mode === 'cumulative' || state.mode === 'ambiguous' || state.asking) return false;
      return state.mode === 'legacy' || keep({ ...state, mode: 'legacy' });
    },
    ending() {
      if (refusal) return { legacy: false, error: refusal };
      const settled = ending(state);
      if (state.mode !== 'cumulative') return settled;
      return undelivered() ? { legacy: false, error: 'the engine never acknowledged this run\'s last cumulative usage, and a registered run never falls back to the legacy report' } : settled;
    },
    mode: () => state.mode,
  };
}
