export const REVIEW_POLICY_VERSION = 'core-review/v1';

const REVIEW_BUDGET_MS = 295_000;
const MINUTE = 60_000;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const JOB = /^job_[0-9a-f]{32}$/;
const INSTANCE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\[(?:0|[1-9][0-9]*)\])?$/;
const LEASE = /^[\w.-]{1,128}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PACKAGES = new Set(['core-review', 'core-review-comparison']);
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const refused = () => new Error('the bounded review admission does not bind a valid package stage and original request clock');

function instant(value) {
  if (typeof value !== 'string' || !UTC.test(value)) throw refused();
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) throw refused();
  return at;
}

function validate(admission) {
  if (!plain(admission) || admission.policy !== REVIEW_POLICY_VERSION
    || !['reviewer', 'auditor'].includes(admission.stage) || !matches(admission.request, ID)
    || !matches(admission.record, ID) || !matches(admission.job, JOB) || !matches(admission.instance, INSTANCE)
    || !Number.isSafeInteger(admission.attempt) || admission.attempt < 1 || !matches(admission.lease, LEASE)
    || !matches(admission.head, COMMIT) || !PACKAGES.has(admission.package)
    || !matches(admission.version, VERSION) || admission.version.length > 128 || !matches(admission.digest, DIGEST)
    || !matches(admission.manifest, DIGEST)) throw refused();
  const requested = instant(admission.requestedAt);
  const deadline = instant(admission.deadlineAt);
  const stageDeadline = instant(admission.stageDeadlineAt);
  if (deadline - requested !== REVIEW_BUDGET_MS) throw refused();
  return Math.min(deadline, stageDeadline);
}

export function admitReviewDeadline(served, record, envelope, now) {
  const policy = served.review_policy_version;
  const stage = served.review_stage;
  if ((policy === undefined || policy === '') && (stage === undefined || stage === '')) return null;
  if (!plain(record?.workflow) || !plain(record?.job) || !plain(record?.stage)
    || !plain(record.job.subject) || !matches(record.job.subject.repository, REPOSITORY)
    || !plain(envelope?.record) || !plain(envelope?.stage)) throw refused();
  const admission = {
    policy, stage, request: served.review_request_id, requestedAt: served.review_requested_at,
    deadlineAt: served.review_deadline_at, stageDeadlineAt: served.workflow_deadline,
    record: served.record_id, job: served.workflow_job, instance: served.workflow_instance,
    attempt: Number(served.workflow_attempt), lease: served.workflow_lease, head: record.job.sourceRevision,
    package: record.workflow.name, version: record.workflow.version,
    digest: record.workflow.digest, manifest: record.workflow.manifestDigest,
  };
  if (record.apiVersion !== 'ksai.konghq.com/stage-record/v1alpha1'
    || record.job.id !== admission.job || record.stage.id !== stage || record.stage.attempt !== admission.attempt
    || admission.instance !== stage || served.workflow_stage !== stage
    || served.workflow !== admission.package || served.workflow_version !== admission.version
    || served.workflow_digest !== admission.digest || served.workflow_manifest_digest !== admission.manifest
    || envelope.apiVersion !== 'ksai.konghq.com/run-steering/v1alpha1'
    || envelope.record.id !== admission.record || envelope.record.sourceRevision !== admission.head
    || envelope.record.repository !== record.job.subject.repository
    || envelope.stage.job !== admission.job || envelope.stage.instance !== admission.instance
    || envelope.stage.attempt !== admission.attempt || envelope.stage.lease !== admission.lease
    || instant(envelope.stage.deadline) !== instant(admission.stageDeadlineAt)) throw refused();
  const due = validate(admission);
  if (instant(admission.requestedAt) > now) throw refused();
  if (due <= now) throw new Error('the original bounded review deadline expired, so this stage starts nothing');
  return admission;
}

export function reviewDeadlineAt(env = {}) {
  const raw = env.KSAI_REVIEW_ADMISSION;
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let admission;
  try {
    admission = JSON.parse(raw);
  } catch {
    throw refused();
  }
  return validate(admission);
}

export function reviewTimeLeft(env = {}, now = Date.now()) {
  const due = reviewDeadlineAt(env);
  if (due === null) return null;
  const left = due - now;
  if (left <= 0) throw new Error('the original bounded review deadline expired, so this stage starts nothing');
  return left;
}

export function reviewMinuteBudget(admission, now) {
  const left = reviewTimeLeft({ KSAI_REVIEW_ADMISSION: JSON.stringify(admission) }, now);
  const minutes = Math.max(1, Math.ceil(left / MINUTE));
  return { stageMinutes: String(minutes), stageJobMinutes: String(minutes + 2) };
}
