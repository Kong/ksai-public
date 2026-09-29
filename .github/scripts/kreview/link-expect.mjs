import { setTimeout as sleep } from 'node:timers/promises';

import controlPlane from '../lib/control-plane.cjs';

const CALL_MS = 30_000;
const TRIES = 6;
const WAIT_MS = 1_000;

export const OUTCOME_EXPECTED = 'outcome.expected';

const passing = (status) => status === 409 || status === undefined || status === 429 || status >= 500;

export async function outcomeExpected({ endpoint, fetch, token, job, link, flow, wait = sleep }) {
  const body = JSON.stringify({ job, link, flow, event: { id: `outcome-expected/${link}`, kind: OUTCOME_EXPECTED } });
  for (let tried = 1; ; tried += 1) {
    const said = await controlPlane.answered(fetch, `${endpoint}/v1/run/work-sessions`, { token, body, timeout: CALL_MS });
    if (!said.why) return;
    if (!passing(said.status) || tried >= TRIES) {
      throw new Error(`the control plane holds no expectation of this run's outcome: ${said.why}${tried > 1 ? ` after ${tried} tries` : ''}`);
    }
    await wait(WAIT_MS * tried);
  }
}
