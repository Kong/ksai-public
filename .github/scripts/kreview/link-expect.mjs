import { setTimeout as sleep } from 'node:timers/promises';

import controlPlane from '../lib/control-plane.cjs';

const CALL_MS = 30_000;

export const OUTCOME_EXPECTED = 'outcome.expected';

export async function outcomeExpected({ endpoint, fetch, token, job, link, flow, wait = sleep }) {
  const body = JSON.stringify({ job, link, flow, event: { id: `outcome-expected/${link}`, kind: OUTCOME_EXPECTED } });
  const said = await controlPlane.reportKept(fetch, `${endpoint}/v1/run/tasks`, { token, body, timeout: CALL_MS }, wait);
  if (said.why) {
    throw new Error(`the control plane holds no expectation of this run's outcome: ${said.why}${said.tried > 1 ? ` after ${said.tried} tries` : ''}`);
  }
}
