import { messageOf, runToken, UNREACHED, unreachedBy } from './token.mjs';
import { command, exported, input, output, secret, state } from './runner.mjs';

try {
  const answer = await runToken({
    unreached: process.env[UNREACHED] === 'true',
    grant: input('grant'),
    owner: input('owner'),
    job: input('job'),
    endpoint: input('endpoint'),
    audience: input('audience') || 'ksai-cp',
    secret,
    note: (why, wait) => command('notice', `ksai could not get its token yet, trying again in ${Math.round(wait / 1000)}s: ${why}`),
    notice: (said) => command('notice', said),
  });
  secret(answer.token);
  output('token', answer.token);
  output('app-slug', answer.appSlug);
  state('token', answer.token);
} catch (refused) {
  if (unreachedBy(refused)) exported(UNREACHED, 'true');
  command('error', messageOf(refused));
  process.exitCode = 1;
}
