import { input, command, secret } from '../run-token/runner.mjs';
import { probeModelToken } from './probe.mjs';

try {
  const checked = await probeModelToken({ endpoint: input('endpoint'), audience: input('audience'), recordId: input('record_id'), mask: secret });
  command('notice', `CP model token probe passed for ${checked.repository} run ${checked.runId}: signed token, requester, proof binding and one-use admission`);
} catch (error) {
  command('error', `CP model token probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
