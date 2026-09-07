import { quote, run, tail } from '../exec.mjs';

export const kind = 'docker-compose';
export const alsoImplements = [];

const compose = (entry, context, ...rest) => [
  'compose',
  '--project-name',
  context.projectName,
  '--file',
  entry.file,
  ...rest,
];

export async function setup(entry, context) {
  const args = compose(entry, context, 'up', '--build', '--detach');
  if (entry.services?.length) args.push(...entry.services);

  const result = await run('docker', args, { cwd: context.repoRoot, stream: true });

  return {
    started_by: quote('docker', args),
    ok: result.code === 0,
    detail: result.code === 0 ? 'stack up' : tail(result.stderr || result.stdout),
  };
}

export async function describe(entry, context) {
  const args = compose(entry, context, 'ps', '--format', 'json');
  const result = await run('docker', args, { cwd: context.repoRoot, timeoutMs: 60_000, maxOutputChars: Infinity });

  const services = result.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return [{ service: parsed.Service, state: parsed.State, ports: parsed.Publishers ?? [] }];
      } catch {
        return [];
      }
    });

  return { services, command: quote('docker', args) };
}

export async function teardown(entry, context) {
  const args = compose(entry, context, 'down', '--volumes', '--remove-orphans');
  const result = await run('docker', args, { cwd: context.repoRoot, stream: true });
  return { ok: result.code === 0, command: quote('docker', args) };
}
