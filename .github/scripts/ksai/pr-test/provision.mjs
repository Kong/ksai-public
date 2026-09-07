import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveHost, selectEnvironments } from './contract.mjs';
import { moduleFor } from './kinds/index.mjs';
import { tail, waitForHttp } from './exec.mjs';

export async function provision({
  contract,
  requested,
  context,
  onRecord = null,
  resolveModule = moduleFor,
}) {
  const selected = selectEnvironments(contract, requested);
  const records = [];

  for (const entry of selected) {
    const module = resolveModule(entry.kind);
    let record = {
      name: entry.name,
      kind: entry.kind,
      started_by: `${entry.kind} setup`,
      ok: false,
      detail: 'setup did not return a result',
      health: null,
      description: null,
      pid: null,
    };
    try {
      const started = await module.setup(entry, context);
      record = {
        name: entry.name,
        kind: entry.kind,
        started_by: started.started_by,
        ok: started.ok,
        detail: started.detail,
        health: null,
        description: null,
        pid: started.pid ?? null,
      };

      await onRecord?.(record);

      if (started.ok) {
        record.description = await module.describe(entry, context);
        record.health = await probe(entry, context);
        if (record.health && !record.health.ready) record.ok = false;
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      record.ok = false;
      record.detail = tail([record.detail, failure].filter(Boolean).join('\n'), 4, 297);
    }

    records.push(record);
    if (!record.ok) break;
  }

  return records;
}

async function probe(entry, context) {
  if (!entry.health) return null;

  const url = resolveHost(entry.health, context.host);
  const outcome = await waitForHttp(url, { timeoutMs: context.readyTimeoutMs ?? 180_000 });
  return { url, ...outcome };
}

export async function teardownAll({ contract, requested, context }) {
  const selected = selectEnvironments(contract, requested).toReversed();
  const results = [];

  for (const entry of selected) {
    try {
      results.push({ name: entry.name, ...(await moduleFor(entry.kind).teardown(entry, context)) });
    } catch (error) {
      results.push({ name: entry.name, ok: false, error: error.message });
    }
  }

  return results;
}

export async function writeEnvironmentFile({ records, context, runDir }) {
  const lines = [
    '# ENVIRONMENT.md',
    '',
    'What is running, and how to reach it. Nothing else needs discovering.',
    '',
    `Host for every published port: \`${context.host}\`.`,
    '',
  ];

  for (const record of records) {
    lines.push(
      `## ${record.name} (${record.kind})`,
      '',
      `- state: ${record.ok ? 'ready' : 'FAILED'}`,
      `- brought up by: \`${record.started_by}\``,
    );

    if (record.health) {
      const state = record.health.ready
        ? `ready, HTTP ${record.health.status}`
        : `never became ready (${record.health.error})`;
      lines.push(`- readiness probe: \`${record.health.url}\` - ${state}`);
    } else {
      lines.push('- readiness probe: none declared');
    }

    for (const service of record.description?.services ?? []) {
      const ports = service.ports
        .filter((publisher) => publisher.PublishedPort)
        .map((publisher) => `${context.host}:${publisher.PublishedPort} -> ${publisher.TargetPort}`)
        .join(', ');
      lines.push(`  - ${service.service}: ${service.state}${ports ? ` (${ports})` : ''}`);
    }

    if (record.description?.task) lines.push(`- task: \`${record.description.command}\``);
    if (!record.ok && record.detail) lines.push('', '```', record.detail, '```');
    lines.push('');
  }

  const path = join(runDir, 'ENVIRONMENT.md');
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}
