export const OUTCOMES = [
  'pass',
  'defect',
  'ambiguous_requirement',
  'infra_failure',
  'insufficient_evidence',
];

const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_CHARS = 2_000;
const FIX_KEYS = new Set(['fix', 'suggested_fix', 'patch', 'diff', 'suggestion']);
const PATH_SEGMENT = /^(?!\.{1,2}$)[\w.+-]+$/;
const VERDICT_KEYS = new Set(['outcome', 'summary', 'criteria', 'probes', 'findings', 'hypothesis_results']);
const PROBE_KEYS = new Set(['name', 'kind', 'command', 'observed', 'passed']);
const FINDING_KEYS = new Set(['title', 'file', 'line', 'reproduction', 'evidence']);

export function validateVerdict(verdict, hypotheses = null) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (!isObject(verdict)) return ['the verdict is not an object'];
  checkKeys(verdict, VERDICT_KEYS, 'verdict', fail);

  if (!checkString(verdict.outcome, 'outcome', fail)) {
    fail(`outcome is not one of ${OUTCOMES.join(', ')}`);
  } else if (!OUTCOMES.includes(verdict.outcome)) {
    fail(`outcome is not one of ${OUTCOMES.join(', ')}`);
  }

  checkString(verdict.summary, 'summary', fail);

  const criteria = checkArray(verdict.criteria, 'criteria', { nonempty: true }, fail);
  criteria.forEach((criterion, index) => checkString(criterion, `criteria[${index}]`, fail));

  const probes = checkArray(verdict.probes, 'probes', { nonempty: true }, fail);
  probes.forEach((probe, index) => checkProbe(probe, index, fail));

  const productProbes = probes.filter((probe) => probe?.kind === 'product' && probe.passed);
  if (verdict.outcome === 'pass' && productProbes.length === 0) {
    fail('a pass needs at least one product-level probe that passed; readiness alone is not one');
  }

  const findings = checkArray(verdict.findings, 'findings', { nonempty: false }, fail);
  if (verdict.outcome === 'defect' && findings.length === 0) {
    fail('outcome is defect and there are no findings');
  }
  if (verdict.outcome === 'pass' && findings.length > 0) {
    fail('outcome is pass and there are findings; one of the two is wrong');
  }
  findings.forEach((finding, index) => checkFinding(finding, index, fail));
  checkHypothesisResults(verdict, hypotheses, fail);

  return problems;
}

const HYPOTHESIS_KEYS = new Set(['id', 'outcome', 'reason', 'probe_names', 'finding_index']);
const HYPOTHESIS_OUTCOMES = new Set(['confirmed', 'refuted', 'insufficient_evidence']);

function checkHypothesisResults(verdict, hypotheses, fail) {
  const candidates = hypotheses?.candidates ?? [];
  const results = verdict.hypothesis_results;
  if (results === undefined && (!candidates.length || !['pass', 'defect'].includes(verdict.outcome))) return;
  if (!Array.isArray(results) || results.length > 12) return fail('hypothesis_results must be an array of at most 12 results');
  const expected = new Set(candidates.map((candidate) => candidate.id));
  const seen = new Set();
  for (const [index, result] of results.entries()) {
    const where = `hypothesis_results[${index}]`;
    if (!isObject(result)) { fail(`${where} is not an object`); continue; }
    checkKeys(result, HYPOTHESIS_KEYS, where, fail);
    if (!expected.has(result.id) || seen.has(result.id)) fail(`${where}.id is unknown or duplicated`);
    seen.add(result.id);
    if (!HYPOTHESIS_OUTCOMES.has(result.outcome)) fail(`${where}.outcome is not a hypothesis outcome`);
    checkString(result.reason, `${where}.reason`, fail);
    const probes = checkArray(result.probe_names, `${where}.probe_names`, { nonempty: result.outcome !== 'insufficient_evidence' }, fail);
    if (new Set(probes).size !== probes.length) fail(`${where}.probe_names repeats a probe`);
    for (const name of probes) {
      checkString(name, `${where}.probe_names entry`, fail);
      const matches = (Array.isArray(verdict.probes) ? verdict.probes : []).filter((probe) => probe?.name === name);
      if (matches.length !== 1 || matches[0].kind !== 'product') fail(`${where} must reference unique product probes; readiness is not reproduction`);
    }
    if (result.outcome !== 'insufficient_evidence' && !['pass', 'defect'].includes(verdict.outcome)) fail(`${where} cannot claim verification when the run has no product verdict`);
    if (result.outcome === 'confirmed') {
      if (verdict.outcome !== 'defect' || !Number.isInteger(result.finding_index) || result.finding_index < 0 || result.finding_index >= (verdict.findings?.length ?? 0)) fail(`${where} needs a defect verdict and an existing finding_index`);
    } else if (result.finding_index !== undefined) fail(`${where}.finding_index belongs only to a confirmed defect`);
  }
  if (candidates.some((candidate) => !seen.has(candidate.id))) fail('hypothesis_results must decide every trusted candidate exactly once');
}

export function verificationRecord(verdict, hypotheses, problems = []) {
  if (!hypotheses) return null;
  const rejected = problems.length > 0 || validateVerdict(verdict, hypotheses).length > 0;
  const decisions = rejected ? [] : verdict?.hypothesis_results ?? [];
  return { version: 1, head_sha: hypotheses.head_sha, base_sha: hypotheses.base_sha, source: 'tester-verdict', verdict_valid: !rejected,
    results: hypotheses.candidates.map((candidate) => decisions.find((result) => result.id === candidate.id) ?? {
      id: candidate.id, outcome: 'insufficient_evidence', probe_names: [], reason: rejected ? 'The tester verdict was rejected; no hypothesis result is accepted.' : 'No product probe decided this hypothesis.',
    }),
  };
}

function checkProbe(probe, index, fail) {
  const where = `probes[${index}]`;
  if (!isObject(probe)) return fail(`${where} is not an object`);
  checkKeys(probe, PROBE_KEYS, where, fail);
  if (!checkString(probe.kind, `${where}.kind`, fail) || !['readiness', 'product'].includes(probe.kind)) {
    fail(`${where}.kind must be readiness or product`);
  }
  for (const key of ['name', 'command', 'observed']) {
    checkString(probe[key], `${where}.${key}`, fail);
  }
  if (typeof probe.passed !== 'boolean') fail(`${where}.passed must be a boolean`);
}

function checkFinding(finding, index, fail) {
  const where = `findings[${index}]`;
  if (!isObject(finding)) return fail(`${where} is not an object`);

  for (const key of Object.keys(finding)) {
    if (FIX_KEYS.has(key)) {
      fail(`${where}.${key} is a proposed fix, and a tester proposes none`);
    } else if (!FINDING_KEYS.has(key)) {
      fail(`${where} has unknown key ${key}`);
    }
  }

  for (const key of ['title', 'reproduction', 'evidence']) {
    checkString(finding[key], `${where}.${key}`, fail);
  }
  if (finding.line !== undefined && !Number.isInteger(finding.line)) {
    fail(`${where}.line must be an integer line number`);
  }
  if (
    finding.file !== undefined &&
    (!checkString(finding.file, `${where}.file`, fail) || !isRepositoryRelativePath(finding.file))
  ) {
    fail(`${where}.file is not a repository-relative path`);
  }
}

function checkArray(value, where, { nonempty }, fail) {
  if (!Array.isArray(value)) {
    fail(`${where} must be an array`);
    return [];
  }
  if (nonempty && value.length === 0) fail(`${where} is empty`);
  if (value.length > MAX_ARRAY_ITEMS) {
    fail(`${where} contains more than ${MAX_ARRAY_ITEMS} items`);
    return value.slice(0, MAX_ARRAY_ITEMS);
  }
  return value;
}

function checkString(value, where, fail) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} must be a nonempty string`);
    return false;
  }
  if (value.length > MAX_STRING_CHARS) {
    fail(`${where} contains more than ${MAX_STRING_CHARS} characters`);
    return false;
  }
  return true;
}

function checkKeys(value, allowed, where, fail) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${where} has unknown key ${key}`);
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function isRepositoryRelativePath(value) {
  return value.split('/').every((segment) => PATH_SEGMENT.test(segment));
}

export const isPullRequestVerdict = (outcome) =>
  outcome === 'pass' || outcome === 'defect' || outcome === 'ambiguous_requirement';
