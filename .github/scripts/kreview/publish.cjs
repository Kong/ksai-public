const { react } = require('../lib/react.cjs');
const { updateOrCreate } = require('../lib/comment.cjs');
const { BLANK_CELL, historyLines, ksaiHeading, reportTable, runHeading, spendSaid } = require('../lib/run-progress.cjs');
const { runStateMarker } = require('../lib/run-record.cjs');
const { MODEL_TIERS, armLabel } = require('../lib/select-arm.cjs');
const { renderClassifierFooter } = require('../ksai/classify.cjs');
const { href: markerHref } = require('../ksai/marker.cjs');
const { scrub } = require('../ksai/plan.cjs');
const { watchdogDetail } = require('../lib/watchdog.cjs');
const { collectSecrets, scrub: scrubSecrets } = require('./secrets.cjs');
const { counted } = require('../lib/text.cjs');

const MISSING_COST = 'Claude execution output omitted total_cost_usd; defaulting total cost to 0.0000.';

function billedTotals(result) {
  const rows = Object.values(result?.modelUsage ?? {}).filter((row) => row !== null && typeof row === 'object');
  if (rows.length === 0) return null;
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  return {
    input_tokens: sum('inputTokens'),
    cache_read_tokens: sum('cacheReadInputTokens'),
    cache_write_tokens: sum('cacheCreationInputTokens'),
    output_tokens: sum('outputTokens'),
    cost_usd: rows.reduce((total, row) => total + (Number(row.costUSD) || 0), 0),
  };
}

const DENIAL_HEAD_CHARS = 120;
const DENIALS_KEPT = 40;

function oneLineHead(value) {
  const said = String(value ?? '')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const kept = [...said];
  return kept.length > DENIAL_HEAD_CHARS ? `${kept.slice(0, DENIAL_HEAD_CHARS - 1).join('')}\u2026` : said;
}

function deniedCall(entry, secrets) {
  const tool = String(entry?.tool_name ?? '').trim() || 'unknown';
  const input = entry?.tool_input;
  const command = typeof input?.command === 'string' ? input.command : null;
  const fallback = Object.values(input ?? {}).find((value) => typeof value === 'string') ?? null;
  const said = command ?? fallback;
  const head = said === null ? null : oneLineHead(scrubSecrets(said, secrets));
  return { tool, head, program: command === null ? null : (head ?? '').split(' ')[0] || null };
}

function deniedCalls(result, env = process.env) {
  const entries = result?.permission_denials;
  if (!Array.isArray(entries)) return null;
  const secrets = collectSecrets(env ?? {});
  return entries.slice(0, DENIALS_KEPT).map((entry) => deniedCall(entry, secrets));
}

function runSpend(raw, env = process.env) {
  let log = [];
  try {
    log = JSON.parse(raw);
  } catch {
    log = [];
  }
  if (!Array.isArray(log)) log = [];

  const result = log.findLast?.((entry) => entry?.type === 'result') ?? {};
  const usage = result.usage ?? {};

  const inputTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const ttl = usage.cache_creation !== null && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const billed = billedTotals(result);

  const totalCost = result.total_cost_usd === null ? Number.NaN : Number(result.total_cost_usd);
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials.length
    : Number(result.permission_denials_count);

  const refused = deniedCalls(result, env);

  const outputs = {
    review_protocol: result.review_protocol ? JSON.stringify(result.review_protocol) : '',
    total_cost: Number.isFinite(totalCost) ? totalCost.toFixed(4) : '0.0000',
    run_result: result.result ?? '',
    conclusion: result.subtype ?? '',
    has_output: String(result.result ?? '').trim() !== '' ? 'true' : 'false',
    has_result: Object.keys(result).length > 0 ? 'true' : 'false',
    stop_reason: result.subtype ?? 'no-result',
    input_tokens: String(inputTokens),
    output_tokens: String(usage.output_tokens ?? 0),
    uncached_input_tokens: String(usage.input_tokens ?? 0),
    cache_read_tokens: String(usage.cache_read_input_tokens ?? 0),
    cache_write_tokens: String(usage.cache_creation_input_tokens ?? 0),
    cache_write_5m_tokens: ttl === null ? '' : String(ttl.ephemeral_5m_input_tokens ?? 0),
    cache_write_1h_tokens: ttl === null ? '' : String(ttl.ephemeral_1h_input_tokens ?? 0),
    billed: billed === null ? '' : JSON.stringify(billed),
    num_turns: String(result.num_turns ?? 0),
    duration: `${Math.round((result.duration_ms ?? 0) / 1000)}s`,
    permission_denials: String(Number.isFinite(denials) ? denials : 0),
    denied: refused === null ? '' : JSON.stringify(refused),
  };
  return { warning: Number.isFinite(totalCost) ? null : MISSING_COST, ...outputs };
}

function loadSuppressionRules({ bundlePath, core, fs }) {
  if (!bundlePath || !fs.existsSync(bundlePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(bundlePath, 'utf8')).rules ?? [];
  } catch (error) {
    core?.warning?.(`Unreadable suppression bundle: ${error.message}. Posting every finding.`);
    return [];
  }
}

function asJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function splitPublished(published) {
  const { fires = [], records = [], ...summary } = published ?? {};
  return { fires, records, summary };
}

function alt(value) {
  return value === undefined || value === null || value === false ? null : value;
}

function num(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function stagesOf(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function billedOf(value) {
  const parsed = stagesOf(value);
  if (parsed === null) return null;
  return {
    input_tokens: num(parsed.input_tokens),
    cache_read_tokens: num(parsed.cache_read_tokens),
    cache_write_tokens: num(parsed.cache_write_tokens),
    output_tokens: num(parsed.output_tokens),
    cost_usd: num(parsed.cost_usd),
  };
}

function deniedOf(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        tool: typeof entry.tool === 'string' ? entry.tool : null,
        head: typeof entry.head === 'string' ? entry.head : null,
        program: typeof entry.program === 'string' ? entry.program : null,
      }));
  } catch {
    return null;
  }
}

function evalRunRecord(env, { now = new Date() } = {}) {
  const published = (() => {
    try {
      const parsed = JSON.parse(env.PUBLISHED || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  })();

  const triaged = env.TRIAGE_MODE === 'auto';
  const unmeasured = env.TRIAGE_FILES === '' && env.TRIAGE_LINES === '';
  const status = statusOf(env);

  return {
    schema_version: 1,
    run_id: `gh:${env.GITHUB_REPOSITORY}:actions:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GITHUB_JOB}:${env.JOB_INDEX}`,
    captured_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'emitter',
    repo: env.GITHUB_REPOSITORY,
    pr_number: num(env.PR_NUMBER),
    head_sha: env.COMMIT_ID,
    base_ref: env.BASE_REF,
    arm: {
      model: env.MODEL,
      effort: env.EFFORT,
      plugin_ref: env.PLUGIN_REF,
      harness: 'kreview-full',
      engine: env.ENGINE || 'claude',
      shadow: env.SHADOW === 'true',
      source: 'observed',
      trial_index: stagesOf(env.REVIEW_PROTOCOL)?.trial_index ?? 0,
      review_protocol: stagesOf(env.REVIEW_PROTOCOL),
      selected_by: armRecord(env),
      repo_rules: rulesRecord(env),
      channel_notes: channelRecord(env),
      status_updates: status?.updates ?? null,
      status_model: status?.model || null,
      status_cost_usd: status?.cost_usd ?? null,
    },
    triage: !triaged
      ? null
      : {
          proposed_tier: env.TRIAGE_TIER === '' ? null : env.TRIAGE_TIER,
          skipped_by: env.TRIAGE_SKIP_BY === '' ? null : env.TRIAGE_SKIP_BY,
          skills: env.TRIAGE_SKILLS === '' ? [] : String(env.TRIAGE_SKILLS).split(','),
          reviewable_files: num(env.TRIAGE_FILES),
          reviewable_lines: num(env.TRIAGE_LINES),
          risk: unmeasured ? null : env.TRIAGE_RISK === 'true',
          api_surface: unmeasured ? null : env.TRIAGE_API_SURFACE === 'true',
        },
    outcome: {
      status: env.CONCLUSION,
      parse_ok: Object.hasOwn(published, 'parse_ok') ? published.parse_ok : null,
      parse_reason: alt(published.parse_reason),
      findings_total: alt(published.findings_total),
      suppressed: alt(published.suppressed),
      inline: alt(published.inline),
      folded: alt(published.folded),
      posted_as: alt(published.posted_as),
      conditioned: alt(published.conditioned),
      report_format: alt(published.report_format),
      stopped_by: env.STOPPED_BY === '' || env.STOPPED_BY === undefined ? null : env.STOPPED_BY,
    },
    posted: { review_id: alt(published.review_id), mode: alt(published.mode) ?? 'published' },
    usage: {
      measured: env.HAS_RESULT === '' || env.HAS_RESULT === undefined ? null : env.HAS_RESULT === 'true',
      cost_usd: num(env.COST),
      input_tokens: num(env.INPUT_TOKENS),
      output_tokens: num(env.OUTPUT_TOKENS),
      num_turns: num(env.NUM_TURNS),
      duration_s: num(String(env.DURATION ?? '').replace(/s$/, '')),
      permission_denials: num(env.DENIALS),
      uncached_input_tokens: num(env.UNCACHED_INPUT_TOKENS),
      cache_read_tokens: num(env.CACHE_READ_TOKENS),
      cache_write_tokens: num(env.CACHE_WRITE_TOKENS),
      cache_write_5m_tokens: num(env.CACHE_WRITE_5M_TOKENS),
      cache_write_1h_tokens: num(env.CACHE_WRITE_1H_TOKENS),
      billed: billedOf(env.BILLED),
      denied: deniedOf(env.DENIED),
    },
    stages: stagesOf(env.STAGES),
    classifier:
      env.CLASSIFIER_MODEL === ''
        ? null
        : {
            model: env.CLASSIFIER_MODEL,
            verdict: env.VERDICT === '' ? null : env.VERDICT,
            cost_usd: num(env.CLASSIFIER_COST),
            input_tokens: num(env.CLASSIFIER_INPUT),
            output_tokens: num(env.CLASSIFIER_OUTPUT),
          },
    routing:
      env.ROUTE_COMMAND === '' || env.ROUTE_SURFACE === '' || env.ROUTE_SOURCE === ''
        ? null
        : {
            command: env.ROUTE_COMMAND,
            surface: env.ROUTE_SURFACE,
            source: env.ROUTE_SOURCE,
          },
  };
}

function statusOf(env) {
  try {
    const held = JSON.parse(String(env.STATUS ?? ''));
    return held && typeof held === 'object' ? held : null;
  } catch {
    return null;
  }
}


const REVIEW_COLUMNS = Object.freeze(['#', 'Engine', 'Result', 'Model', 'Turns', 'Cost']);

const money = (value) => {
  const held = Number(String(value ?? '').replace(/[`,$\s]/g, ''));
  return String(value ?? '').trim() !== '' && Number.isFinite(held) ? held : null;
};

const rounded = (value) => (value === null ? null : Number(value.toFixed(4)));

const counting = (value) => {
  const held = money(value);
  return held === null || !Number.isInteger(held) ? null : held;
};

function reviewSpend(env) {
  const totals = env.HAS_RESULT === 'true';
  const work = totals ? money(env.COST) : null;
  const held = statusOf(env);
  const aside = [money(env.CLASSIFIER_COST), held ? money(held.cost_usd) : null].filter((one) => one !== null);
  return { work, decided: aside.length === 0 ? null : aside.reduce((sum, one) => sum + one, 0) };
}

function reviewRow(env) {
  const totals = env.HAS_RESULT === 'true';
  return [
    env.RUN_URL ? `[1](${env.RUN_URL})` : '1',
    `\`${env.ENGINE || 'claude'}\``,
    `\`${env.CONCLUSION}\``,
    `\`${armLabel(env.MODEL, env.EFFORT)}\``,
    totals ? `\`${env.NUM_TURNS}\`` : BLANK_CELL,
    totals ? `$${env.COST}` : BLANK_CELL,
  ];
}

function reviewSpendLine(env) {
  const spend = reviewSpend(env);
  const said = [];
  if (spend.work !== null) said.push(`Reviewing cost $${spend.work.toFixed(4)}`);
  if (spend.decided !== null) said.push(`deciding how to run it cost $${spend.decided.toFixed(4)}`);
  return spendSaid(said);
}

function reviewRecord(env) {
  const totals = env.HAS_RESULT === 'true';
  const held = statusOf(env);
  return {
    conclusion: env.CONCLUSION || null,
    reviewed_commit: env.COMMIT_ID || null,
    model: env.MODEL || null,
    effort: env.EFFORT || null,
    selected_by: armRecord(env),
    triage: env.TRIAGE_MODE === 'auto' ? triageRecord(env) : null,
    engine: env.ENGINE || 'claude',
    review_protocol: stagesOf(env.REVIEW_PROTOCOL),
    repo_rules: rulesRecord(env),
    channel_notes: channelRecord(env),
    status_updates: held ? counting(held.updates) : null,
    status_model: held?.model || null,
    status_cost_usd: held ? rounded(money(held.cost_usd)) : null,
    prompt: env.PROMPT_REPORT || null,
    duration_s: totals ? counting(String(env.DURATION ?? '').match(/(\d+)s/)?.[1]) : null,
    num_turns: totals ? counting(env.NUM_TURNS) : null,
    input_tokens: totals ? counting(env.INPUT_TOKENS) : null,
    output_tokens: totals ? counting(env.OUTPUT_TOKENS) : null,
    uncached_input_tokens: totals ? counting(env.UNCACHED_INPUT_TOKENS) : null,
    cache_read_tokens: totals ? counting(env.CACHE_READ_TOKENS) : null,
    cache_write_tokens: totals ? counting(env.CACHE_WRITE_TOKENS) : null,
    permission_denials: totals ? counting(env.DENIALS) : null,
    cost_usd: totals ? money(env.COST) : null,
    detail: {
      requester: env.REQUESTER || null,
      triage_why: env.TRIAGE_WHY || null,
      rules_path: env.REPO_RULES_PATH || null,
      rules_sha: /^[0-9a-f]{7,40}$/.test(String(env.REPO_RULES_SHA ?? '')) ? env.REPO_RULES_SHA : null,
      rules_bytes: counting(env.REPO_RULES_BYTES),
      rules_packs: packsRecord(env),
    },
  };
}

function rulesRecord(env) {
  const mode = String(env.REPO_RULES_MODE ?? '');
  if (mode === '') return null;
  return !(mode === 'off' || env.REPO_RULES_ENABLED !== 'true');
}

function packsRecord(env) {
  const raw = String(env.REPO_RULES_PACKS ?? '');
  if (raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((pack) => pack && typeof pack.name === 'string')
    .map((pack) => ({ name: pack.name, bytes: counting(pack.bytes), matched: pack.matched === true }));
}

function armRecord(env) {
  if (env.SELECTED_BY === 'comment') return 'comment';
  if (env.SELECTED_BY === 'triage') return 'triage';
  return 'input';
}

function channelRecord(env) {
  const said = String(env.CHANNEL_NOTES ?? '').trim();
  if (said === '' || said === 'off') return null;
  return counting(said);
}

function triageRecord(env) {
  const flag = (value) => (value === 'true' ? true : value === 'false' ? false : null);
  const skills = String(env.TRIAGE_SKILLS ?? '').trim();
  const tier = String(env.TRIAGE_TIER ?? '').trim();
  const files = counting(env.TRIAGE_FILES);
  const lines = counting(env.TRIAGE_LINES);
  if (files === null && lines === null) return null;
  return {
    source: 'report',
    proposed_tier: MODEL_TIERS.includes(tier) ? tier : null,
    skipped_by: null,
    skills: skills === '' || skills === 'none' ? [] : skills.split(','),
    reviewable_files: files,
    reviewable_lines: lines,
    risk: flag(env.TRIAGE_RISK),
    api_surface: flag(env.TRIAGE_API_SURFACE),
  };
}

function renderRunReport(env) {
  const spend = reviewSpend(env);
  const paid = spend.work === null ? 0 : 1;
  const total = [spend.work, spend.decided].filter((one) => one !== null).reduce((sum, one) => sum + one, 0);
  const cost = spend.work === null ? 'cost not recoverable from a partial log' : `$${total.toFixed(4)} total`;
  const status = statusOf(env);
  const kind = carriedKind(env);
  const carried = kind === null ? '' : renderReviewNotice(kind, env, { headed: false });
  return [
    reviewHeading(env, status, kind),
    ...historyLines(status?.history),
    ...(carried === '' ? [] : ['', scrub(carried, { triggerPhrase: env.TRIGGER })]),
    '',
    '---',
    '',
    '<details>',
    `<summary>Run report (federated) · ${counted(paid, 'paid run')} · ${cost}</summary>`,
    '',
    ...reportTable(REVIEW_COLUMNS, [reviewRow(env)]),
    ...reviewSpendLine(env),
    '',
    '</details>',
    '',
    runStateMarker(reviewRecord(env)),
    '',
  ].join('\n');
}

const CARRIED_NOTICE = Object.freeze(['failed']);

function carriedKind(env) {
  if (String(env.CANCELLED ?? '') === 'true') return null;
  const kind = decideReviewNotice(env);
  return CARRIED_NOTICE.includes(kind) ? kind : null;
}

function reviewPointer(env) {
  return markerHref({ kind: 'run-finished', flow: 'review', pr: env.PR_NUMBER, run: env.RUN_ID });
}

function reviewHeading(env, status, kind) {
  const pointer = reviewPointer(env);
  if (kind === null) return runHeading('review', status?.stage, true, env.COMMAND, env.TRIGGER, pointer);
  return ksaiHeading({
    command: env.COMMAND,
    flow: 'review',
    said: 'Failed',
    mark: 'failed',
    href: pointer,
    triggerPhrase: env.TRIGGER,
  });
}

function decideReviewNotice(env) {
  if (env.SELECT_ERROR !== '') return 'invalid';
  if (env.BUILD_ERROR) return 'unbuildable';
  if (env.STAND_DOWN !== '') return 'stood_down';
  if (env.RULES_NOTICE) return 'rules';
  const live = env.DRY_RUN === 'false';
  if (live && env.VALIDATE_OUTCOME === 'success' && env.TRIAGE_SKIP === 'true') return 'skipped';
  if (
    live &&
    env.AUTHORIZED === 'true' &&
    env.PARSE_OUTCOME === 'success' &&
    env.TRIAGE_SKIP !== 'true' &&
    (env.SELECT_OUTCOME !== 'success' || env.SELECT_SKIPPED === 'false') &&
    env.RESULT_OUTCOME !== 'success'
  ) {
    return 'failed';
  }
  return null;
}

function renderReviewNotice(kind, env, { headed = true } = {}) {
  const opened = (said, mark) =>
    headed
      ? [
        ksaiHeading({
          command: env.COMMAND,
          flow: 'review',
          said,
          mark,
          href: reviewPointer(env),
          triggerPhrase: env.TRIGGER,
        }),
        '',
      ]
      : [];
  if (kind === 'invalid') return env.SELECT_ERROR_NOTICE;
  if (kind === 'unbuildable') {
    return [
      ...opened('Nothing ran', 'failed'),
      `The review prompt could not be assembled: ${env.BUILD_ERROR}. This is a configuration fault rather ` +
        'than a failed review, so re-running will not change it',
    ].join('\n');
  }
  if (kind === 'stood_down') return env.STAND_DOWN;
  if (kind === 'rules') return env.RULES_NOTICE;
  if (kind === 'skipped') {
    return [
      ...opened('Skipped', 'stopped'),
      `Triage found nothing to review: ${env.TRIAGE_SKIP_REASON}. Push a change to reviewable code and ask ` +
        'again to run a full review',
    ].join('\n');
  }
  const halted =
    env.WATCHDOG_CAUSE === 'progress'
      ? `The review watchdog stopped it because it had stopped making progress.${watchdogDetail(env)}`
      : `The review watchdog stopped it about 1 minute short of the job's ${env.CEILING}-minute ceiling.`;
  const stopped =
    env.WATCHDOG_FIRED === 'true'
      ? halted
      : `The review did not complete (\`${env.STOP_REASON || 'no result'}\`).`;
  const salvage =
    env.RESULT_OUTCOME === 'failure'
      ? 'Findings were salvaged and the review comment itself failed to post.'
      : 'Nothing was salvaged to post as a review.';
  return [
    ...opened('Failed', 'failed'),
    `${stopped} ${salvage} What it spent is below; see the [workflow run](${env.RUN_URL}) for details`,
  ].join('\n');
}

async function publishReviewNotice({ github, owner, repo, env }) {
  const kind = decideReviewNotice(env);
  if (kind === null) return { notices: ['this run posted a review, so it published no notice'] };
  if (String(env.REPORT_PUBLISHED ?? '') === 'true' && CARRIED_NOTICE.includes(kind)) {
    return { notices: [`the run report carried the \`${kind}\` notice, so nothing was published beside it`] };
  }

  const said = scrub(renderReviewNotice(kind, env), { triggerPhrase: env.TRIGGER });
  const footer = renderClassifierFooter(env.ROUTE_SOURCE, { triggerPhrase: env.TRIGGER });
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: Number(env.PR_NUMBER),
    body: footer ? `${said}\n\n${footer}` : said,
  });
  return { notices: [`published the \`${kind}\` notice`] };
}

async function publishRunReport({ github, core, owner, repo, env }) {
  const outputs = {
    replaced: 'false',
    published: 'false',
  };
  const out = await updateOrCreate({
    github,
    core,
    owner,
    repo,
    issueNumber: env.PR_NUMBER,
    body: renderRunReport(env),
    commentId: env.START_COMMENT_ID,
  });
  outputs.replaced = out.mode === 'updated' ? 'true' : 'false';
  outputs.published = 'true';
  const carried = carriedKind(env) === null ? '' : ', carrying the notice for what went wrong';
  return { outputs, notices: [`${out.mode} the run report${carried}`] };
}

async function reactOnResult({ github, core, owner, repo, env }) {
  const out = await react({ github, core, owner, repo, commentId: env.COMMENT_ID, threadRootId: env.THREAD_ROOT_ID });
  return { outputs: { reacted: out.reacted ? 'true' : 'false' }, notices: [] };
}

module.exports = {
  runSpend,
  loadSuppressionRules,
  asJsonl,
  splitPublished,
  evalRunRecord,
  renderRunReport,
  decideReviewNotice,
  renderReviewNotice,
  publishReviewNotice,
  publishRunReport,
  reactOnResult,
  MISSING_COST,
};
