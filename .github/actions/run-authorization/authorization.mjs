import { ask, checkedJob, messageOf, Refused } from '../run-token/token.mjs';

export const WIDEST_FIRST = Object.freeze(['implement', 'review', 'help', 'test']);

const RECORDED = Object.freeze({ review: 'review', fix: 'implement', implement: 'implement', approve: 'implement', test: 'test' });

export function decisionOf({ authorized = '', review = '', implement = '', test = '', help = '', continuation = '', recordCommand = '' }) {
  const recorded = Object.hasOwn(RECORDED, recordCommand) ? RECORDED[recordCommand] : '';
  if (continuation === 'true' && (recorded === '' || recorded === 'implement')) return { authorized: true, command: 'implement' };
  if (authorized !== 'true') return { authorized: false };

  const asked = { review, implement, test, help };
  const named = WIDEST_FIRST.filter((one) => asked[one] === 'true');
  const command = named.includes(recorded) ? recorded : named[0];
  return command === undefined ? { authorized: false } : { authorized: true, command };
}

function noWorkOf({ authorized = '', review = '', implement = '', test = '', help = '', continuation = '', recordCommand = '', recordBoundCommand = '', commentKind = '', noWork = '', nativePending = '', outcome = '' }) {
  return outcome === 'success' && noWork === 'true' && nativePending === 'true' && authorized === 'true' && continuation === 'false' &&
    recordCommand === '' && recordBoundCommand === '' && ['issue', 'review'].includes(commentKind) &&
    [review, implement, test, help].every((one) => one === 'false');
}

export async function reportDecision({
  gate,
  job = '',
  mode = '',
  unreached = false,
  notice = (_said) => {},
  warn = (_said) => {},
  ...asking
}) {
  checkedJob(job);
  const decided = decisionOf(gate);
  const noWork = !decided.authorized && noWorkOf(gate);
  const said = decided.authorized ? decided.command : noWork ? 'no_work' : 'refused';
  const body = decided.authorized ? { authorized: true, command: decided.command, job } : { authorized: false, job };
  const needed = noWork || mode === 'cp';

  try {
    await ask({ ...asking, path: noWork ? '/run/no-work' : '/run/authorization', body, ...(needed && !unreached ? {} : { delays: [] }) });
  } catch (unreported) {
    const why = messageOf(unreported);
    if (noWork) {
      throw new Refused(`the control plane did not acknowledge this run's no-work outcome, so its Task could not be completed: ${why}`, { cause: unreported });
    }
    if (needed) {
      throw new Refused(`the control plane was not told this run decided ${said}, so it would serve this run no write token: ${why}`, { cause: unreported });
    }
    warn(`ksai could not tell the control plane this run decided ${said}, which it needs before this repository is served run_tokens: cp: ${why}`);
    return said;
  }
  notice(`ksai told the control plane this run decided ${said}`);
  return said;
}
