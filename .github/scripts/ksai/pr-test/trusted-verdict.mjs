import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tail } from './exec.mjs';

export async function writeDryVerdict(runDir, sweptNames = null) {
  const records = await readRecords(runDir);
  if (sweptNames) return writeSweepVerdict(runDir, records, sweptNames);
  if (records.some((record) => !record.ok)) {
    return writeInfrastructureVerdictFromRecords(runDir, records);
  }
  return writeVerdict(runDir, {
    outcome: 'insufficient_evidence',
    summary: 'Dry run: no tester ran. Nothing here says anything about the change.',
    criteria: ['none derived, because no tester read them'],
    probes: readinessProbes(records),
    findings: [],
  });
}

const writeSweepVerdict = (runDir, records, sweptNames) => {
  const attempted = new Set(records.map((record) => record.selected_as));
  const failed = records.filter((record) => !record.ok).map((record) => record.name);
  const missing = sweptNames.filter((name) => !attempted.has(name));

  if (failed.length > 0 || missing.length > 0) {
    const details = [
      failed.length > 0 ? `failed setup or readiness checks: ${failed.join(', ')}` : '',
      missing.length > 0 ? `produced no environment record: ${missing.join(', ')}` : '',
    ].filter(Boolean);
    return writeVerdict(runDir, {
      outcome: 'infra_failure',
      summary: `The environment sweep ${details.join('; ')}. No tester ran, and this says nothing about the change.`,
      criteria: ['none derived, because the tester did not start'],
      probes: readinessProbes(records),
      findings: [],
    });
  }

  return writeVerdict(runDir, {
    outcome: 'insufficient_evidence',
    summary: `Environment sweep: every selected environment passed setup and readiness checks on its own: ${sweptNames.join(', ')}. Teardown was attempted after each. No tester ran, so this says nothing about the change.`,
    criteria: ['none derived, because no tester read them'],
    probes: readinessProbes(records),
    findings: [],
  });
};

export async function writeInfrastructureVerdict(runDir) {
  const records = await readRecords(runDir);
  return writeInfrastructureVerdictFromRecords(runDir, records);
}

const writeInfrastructureVerdictFromRecords = (runDir, records) => {
  const failed = records.filter((record) => !record.ok).map((record) => record.name);
  const named = failed.length > 0 ? failed.join(', ') : 'the selected environment';
  return writeVerdict(runDir, {
    outcome: 'infra_failure',
    summary: `The tester did not run because ${named} failed during setup or readiness checks.`,
    criteria: ['none derived, because the tester did not start'],
    probes: readinessProbes(records),
    findings: [],
  });
};

const readRecords = async (runDir) => {
  try {
    const value = JSON.parse(await readFile(join(runDir, 'environments.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const readinessProbes = (records) => {
  const probes = records.map((record) => ({
    name: probeName(record),
    kind: 'readiness',
    command: record.health ? `GET ${record.health.url}` : record.started_by,
    observed: describeState(record),
    passed: Boolean(record.ok),
  }));
  return probes.length > 0
    ? probes
    : [
        {
          name: 'no environment record was produced',
          kind: 'readiness',
          command: 'none',
          observed: 'nothing to probe',
          passed: false,
        },
      ];
};

const probeName = (record) => {
  if (!record.ok) {
    return record.health
      ? `${record.name} did not pass its readiness probe`
      : `${record.name} did not start`;
  }
  return record.health
    ? `${record.name} passed its readiness probe`
    : `${record.name} started without a declared readiness probe`;
};

const describeState = (record) => {
  if (!record.ok) return `did not come up: ${tail(record.detail ?? 'no detail', 4, 300)}`;
  if (record.health) return `HTTP ${record.health.status}`;
  return record.detail ?? 'started';
};

async function writeVerdict(runDir, verdict) {
  const path = join(runDir, '.pr-test-verdict.json');
  await writeFile(path, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  return path;
}
