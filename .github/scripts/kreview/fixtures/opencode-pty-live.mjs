import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const server = createServer((_request, response) => response.end('healthy'));
if (process.argv[2] === 'stubborn-tree') {
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
  console.log(`CHILD ${child.pid}`);
}
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no TCP address');
  console.log(`READY http://127.0.0.1:${address.port}`);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'ping') console.log('PONG');
  if (line !== 'fail') return;
  console.error('FINAL_FAILURE');
  server.close(() => process.exit(7));
});
