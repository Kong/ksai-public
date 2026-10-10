import { reportDecision } from './authorization.mjs';
import { messageOf, UNREACHED, unreachedBy } from '../run-token/token.mjs';
import { command, exported, input, secret } from '../run-token/runner.mjs';

try {
  await reportDecision({
    gate: {
      authorized: input('authorized'),
      review: input('review'),
      implement: input('implement'),
      test: input('test'),
      help: input('help'),
      continuation: input('continuation'),
      recordCommand: input('record_command'),
      recordBoundCommand: input('record_bound_command'),
      commentKind: input('comment_kind'),
      noWork: input('no_work'),
      nativePending: input('native_pending'),
      outcome: input('gate_outcome'),
    },
    job: input('job'),
    mode: input('mode'),
    unreached: process.env[UNREACHED] === 'true',
    endpoint: input('endpoint'),
    audience: input('audience') || 'ksai-cp',
    secret,
    note: (why, wait) => command('notice', `ksai could not report its decision yet, trying again in ${Math.round(wait / 1000)}s: ${why}`),
    notice: (said) => command('notice', said),
    warn: (said) => command('warning', said),
  });
} catch (refused) {
  if (unreachedBy(refused)) exported(UNREACHED, 'true');
  command('error', messageOf(refused));
  process.exitCode = 1;
}
