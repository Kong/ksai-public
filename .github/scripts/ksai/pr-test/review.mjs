import { ksaiHeading } from '../../lib/run-progress.cjs';
import { runStateMarker } from '../../lib/run-record.cjs';

const whole = (value) => {
  const held = Number(value);
  return Number.isFinite(held) && held >= 0 ? Math.round(held) : null;
};

const money = (value) => {
  const held = Number(value);
  return Number.isFinite(held) && held >= 0 ? Number(held.toFixed(4)) : null;
};

export function testerRecord({ spend = null, verdict = null, criteria = null, problems = [] } = {}) {
  const seconds = String(spend?.duration ?? '').match(/^(\d+)s$/)?.[1];
  return runStateMarker({
    flow: 'test',
    conclusion: problems.length > 0 ? 'rejected' : (verdict?.outcome ?? null),
    reviewed_commit: criteria?.pull_request?.head_sha ?? null,
    model: spend?.model ?? null,
    effort: spend?.effort ?? null,
    prompt: 'the tester prompt',
    duration_s: whole(seconds),
    num_turns: whole(spend?.num_turns),
    input_tokens: whole(spend?.input_tokens),
    output_tokens: whole(spend?.output_tokens),
    permission_denials: whole(spend?.permission_denials),
    cost_usd: money(spend?.total_cost),
  });
}
const heading = (said, mark, triggerPhrase) =>
  ksaiHeading({ flow: 'tester', said, mark, triggerPhrase });

const lead = (outcome) => OUTCOME_LEAD[outcome] ?? OUTCOME_LEAD.insufficient_evidence;

const OUTCOME_SAID = Object.assign(Object.create(null), {
  pass: 'Passed',
  defect: 'Defect found',
  ambiguous_requirement: 'No verdict',
  infra_failure: 'Environment failed',
  insufficient_evidence: 'No verdict',
});

const OUTCOME_MARK = Object.assign(Object.create(null), {
  pass: 'done',
  defect: 'failed',
  ambiguous_requirement: 'waiting',
  infra_failure: 'failed',
  insufficient_evidence: 'waiting',
});

const OUTCOME_LEAD = Object.assign(Object.create(null), {
  pass: 'The change did what its criteria say, under the probes below.',
  defect: 'The change does not do what its criteria say. Findings below.',
  ambiguous_requirement: 'The issue and the description disagree, so no verdict was earned.',
  infra_failure: 'This says nothing about the change. The environment never came up.',
  insufficient_evidence: 'The run could not exercise enough of the change to answer.',
});

export function scrub(text, triggerPhrase = '') {
  return redact(String(text ?? ''), triggerPhrase)
    .replaceAll('`', "'")
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([[\]])/g, '\\$1')
    .replace(DANGEROUS, (match) => `\`${match}\``);
}

const DANGEROUS = /https?:\/\/\S+|@[A-Za-z0-9][A-Za-z0-9-]{0,38}|#\d+/g;

function redact(text, phrase) {
  if (!phrase) return text;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), (match) => `${match[0]}\u200B${match.slice(1)}`);
}

export const flatten = (text, triggerPhrase = '') =>
  scrub(text, triggerPhrase).replace(/\s*\r?\n\s*/g, ' ');

export function renderReview({
  verdict,
  criteria,
  environments,
  problems = [],
  verification = null,
  triggerPhrase = '',
}) {
  const oneLine = (text) => flatten(text, triggerPhrase);
  const cell = (text) => oneLine(text).replaceAll('|', '\\|');
  const lines = [];

  if (problems.length > 0) {
    lines.push(
      heading('Verdict rejected', 'failed', triggerPhrase),
      '',
      'The tester wrote a verdict this publisher will not publish:',
      '',
      ...problems.map((problem) => `- ${oneLine(problem)}`),
      '',
      '### Tested against',
      '',
      ...criteriaLines(criteria, oneLine),
      '',
      'No pass and no failure is being claimed for this pull request.',
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    heading(OUTCOME_SAID[verdict.outcome] ?? OUTCOME_SAID.insufficient_evidence, OUTCOME_MARK[verdict.outcome] ?? OUTCOME_MARK.insufficient_evidence, triggerPhrase),
    '',
    lead(verdict.outcome),
    '',
    oneLine(verdict.summary),
    '',
    '### Tested against',
    '',
    ...criteriaLines(criteria, oneLine),
    '',
    '### Criteria the tester derived',
    '',
    ...(verdict.criteria ?? []).map((item) => `- ${oneLine(item)}`),
    '',
    '### Environments reported by the test job',
    '',
    ...environmentLines(environments, oneLine),
    '',
    '### Probes',
    '',
    ...probeLines(verdict.probes ?? [], cell),
    '',
  );

  if ((verdict.findings ?? []).length > 0) {
    lines.push('### Findings', '');
    for (const finding of verdict.findings) lines.push(...findingLines(finding, oneLine));
  }

  if (verification) {
    lines.push('### Review hypothesis checks', '', 'These are tester-reported probe results on the head and base above.', '', '| Candidate | Result | Probes | Evidence |', '| --- | --- | --- | --- |');
    for (const result of verification.results) lines.push(`| ${cell(result.id)} | ${cell(result.outcome)} | ${cell(result.probe_names.join(', '))} | ${cell(result.reason)} |`);
    lines.push('');
  }

  lines.push(
    '<sub>A pass is worth no more than the evidence under it. Artifacts expire; the words above do not.</sub>',
  );
  return lines.join('\n');
}

function criteriaLines(criteria, oneLine) {
  const lines = [
    `- commit: \`${oneLine(criteria?.pull_request?.head_sha ?? 'unknown')}\``,
    `- base: \`${oneLine(criteria?.pull_request?.base ?? 'unknown')}\` at \`${oneLine(criteria?.pull_request?.base_sha ?? 'unknown')}\``,
  ];
  if (!criteria || !Array.isArray(criteria.issues)) {
    lines.push('- criteria were not collected for this run');
    return lines;
  }

  const readable = criteria.issues.filter((issue) => issue?.readable);
  const unreadable = criteria.issues.filter((issue) => !issue?.readable);

  if (readable.length === 0) {
    lines.push(
      '- no readable closing issue. The pull request title and description are the criteria, so discount a pass accordingly.',
    );
  }
  for (const issue of readable)
    lines.push(`- ${oneLine(issue?.repo)}#${oneLine(issue?.number)}: ${oneLine(issue?.title)}`);
  for (const issue of unreadable) {
    lines.push(`- ${oneLine(issue?.repo)}#${oneLine(issue?.number)}: **unreadable**, so it was not tested against`);
  }
  return lines;
}

function environmentLines(environments, oneLine) {
  return (Array.isArray(environments) ? environments : []).map((environment) => {
    const health = environment.health
      ? `${environment.health.ready ? 'ready' : 'never ready'} via ${oneLine(environment.health.url)}`
      : 'no readiness probe declared';
    return `- \`${oneLine(environment.name)}\` (${oneLine(environment.kind)}), started by \`${oneLine(environment.started_by)}\`, ${health}`;
  });
}

function probeLines(probes, cell) {
  const lines = ['| Probe | Kind | Passed | Observed |', '| --- | --- | :-: | --- |'];
  for (const probe of probes) {
    lines.push(
      `| ${cell(probe.name)} | ${cell(probe.kind)} | ${probe.passed ? '✅' : '❌'} | ${cell(probe.observed)} |`,
    );
  }
  return lines;
}

function findingLines(finding, oneLine) {
  const where = finding.file
    ? scrub(`${finding.file}${finding.line ? `:${finding.line}` : ''}`)
    : '';
  return [
    `#### ${oneLine(finding.title)} ${where}`.trim(),
    '',
    `**Reproduction:** ${oneLine(finding.reproduction)}`,
    '',
    `**Observed:** ${oneLine(finding.evidence)}`,
    '',
  ];
}
