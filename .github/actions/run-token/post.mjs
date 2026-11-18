import { messageOf, revoke } from './token.mjs';
import { command } from './runner.mjs';

const token = String(process.env.STATE_token ?? '');

if (token !== '') {
  try {
    await revoke({ token });
    command('notice', 'token revoked');
  } catch (unrevoked) {
    command('warning', `revoking the token failed, it expires on its own: ${messageOf(unrevoked)}`);
  }
}
