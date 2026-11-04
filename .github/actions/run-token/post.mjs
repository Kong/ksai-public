import { messageOf, revoke } from './token.mjs';
import { command } from './runner.mjs';

const token = String(process.env.STATE_token ?? '');

if (token !== '') {
  try {
    await revoke({ token });
    command('notice', 'ksai revoked the token the control plane served this step');
  } catch (unrevoked) {
    command('warning', `ksai could not revoke the token the control plane served this step, so it lapses on its own: ${messageOf(unrevoked)}`);
  }
}
