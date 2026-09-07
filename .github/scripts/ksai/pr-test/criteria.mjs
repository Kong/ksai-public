import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runGitHub } from './exec.mjs';

const PR_FIELDS =
  'number,title,body,baseRefName,baseRefOid,headRefName,headRefOid,closingIssuesReferences';
const SHA = /^[0-9a-f]{40}$/i;

export async function collectCriteria({
  prNumber,
  repo,
  runDir,
  headSha = null,
  baseRef = null,
  baseSha = null,
}) {
  const pr = await ghJson(['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_FIELDS]);

  if (!SHA.test(pr.headRefOid ?? '')) {
    throw new Error('GitHub returned no usable pull request head SHA');
  }
  if (typeof pr.baseRefName !== 'string' || pr.baseRefName.trim() === '') {
    throw new Error('GitHub returned no usable pull request base ref');
  }
  if (!SHA.test(pr.baseRefOid ?? '')) {
    throw new Error('GitHub returned no usable pull request base SHA');
  }
  if (headSha !== null && !SHA.test(headSha)) {
    throw new Error(`the checked-out head is not a 40-character commit SHA: ${headSha}`);
  }
  if (headSha !== null && pr.headRefOid.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error(`the pull request moved from ${headSha} to ${pr.headRefOid} before testing started`);
  }
  if (baseRef !== null && (typeof baseRef !== 'string' || baseRef.trim() === '')) {
    throw new Error('the resolved base ref is empty');
  }
  if (baseRef !== null && pr.baseRefName !== baseRef) {
    throw new Error(`the pull request base moved from ${baseRef} to ${pr.baseRefName} before testing started`);
  }
  if (baseSha !== null && !SHA.test(baseSha)) {
    throw new Error(`the resolved base is not a 40-character commit SHA: ${baseSha}`);
  }
  if (baseSha !== null && pr.baseRefOid.toLowerCase() !== baseSha.toLowerCase()) {
    throw new Error(`the pull request base moved from ${baseSha} to ${pr.baseRefOid} before testing started`);
  }

  const issues = [];
  for (const reference of pr.closingIssuesReferences ?? []) {
    issues.push(await readIssue(reference, repo));
  }

  const record = {
    pull_request: {
      number: pr.number,
      title: pr.title,
      body: stripHtmlComments(pr.body ?? ''),
      base: pr.baseRefName,
      base_sha: pr.baseRefOid,
      head_sha: pr.headRefOid,
    },
    issues,
    source: issues.some((issue) => issue.readable) ? 'closing_issue' : 'pull_request',
  };

  const path = join(runDir, 'CRITERIA.md');
  await writeFile(path, render(record), 'utf8');
  return { record, path };
}

async function readIssue(reference, fallbackRepo) {
  const repo = reference.repository?.nameWithOwner ?? fallbackRepo;

  if (!sameOwner(repo, fallbackRepo)) {
    return {
      repo,
      number: reference.number,
      readable: false,
      error: `outside ${fallbackRepo.split('/')[0]}, so it was not read as criteria`,
    };
  }

  try {
    const issue = await ghJson([
      'issue',
      'view',
      String(reference.number),
      '--repo',
      repo,
      '--json',
      'number,title,body,state',
    ]);
    return {
      repo,
      number: issue.number,
      title: issue.title,
      body: stripHtmlComments(issue.body ?? ''),
      state: issue.state,
      readable: true,
    };
  } catch (error) {
    return { repo, number: reference.number, readable: false, error: error.message };
  }
}

async function ghJson(args) {
  const result = await runGitHub(args, { timeoutMs: 60_000, maxOutputChars: Infinity });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `gh ${args[0]} failed`);
  return JSON.parse(result.stdout);
}

export const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

export const sameOwner = (repo, other) =>
  repo.split('/')[0].toLowerCase() === other.split('/')[0].toLowerCase();

function render(record) {
  const lines = [
    '# Acceptance criteria',
    '',
    'This file is the only source of what the change was supposed to do. A readable',
    'closing issue outranks the pull request title and description; where they conflict,',
    'the outcome is `ambiguous_requirement` rather than a pass or a failure. With no',
    'readable closing issue, the pull request title and description are the criteria.',
    'Pull request comments are never criteria.',
    '',
    `## Pull request #${record.pull_request.number}`,
    '',
    `Title: ${record.pull_request.title}`,
    '',
    `Base: ${record.pull_request.base} at ${record.pull_request.base_sha}`,
    '',
    `Head: ${record.pull_request.head_sha}`,
    '',
    record.pull_request.body || '_The description is empty._',
    '',
  ];

  if (record.issues.length === 0) {
    lines.push(
      '## Closing issues',
      '',
      'None. The pull request title and description above are the criteria.',
      '',
    );
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Closing issues', '');
  for (const issue of record.issues) {
    if (!issue.readable) {
      lines.push(`### ${issue.repo}#${issue.number} - UNREADABLE`, '', issue.error, '');
      continue;
    }
    lines.push(
      `### ${issue.repo}#${issue.number} - ${issue.title} (${issue.state})`,
      '',
      issue.body || '_The issue body is empty._',
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}
