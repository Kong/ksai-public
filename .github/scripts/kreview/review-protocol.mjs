export function reviewProtocol({ env, read, events, staged, runtime, measured, unmeasured, clean, complete, spent, gatewayFailures, lsp }) {
  const attempts = events.filter((event) => event.type === 'ksai_review_attempt');
  const held = env.REVIEW_PIPELINE_FILE ? JSON.parse(read(env.REVIEW_PIPELINE_FILE, 'utf8')) : null;
  const completedCalls = held?.stages?.length > 0 && held.stages.every((stage) => stage.invocations?.length > 0 && stage.invocations.every((call) => call.exit_code === 0 && call.usage));
  const measuredExit = Number(env.OPENCODE_EXIT) === 0 || (staged && Number(env.OPENCODE_EXIT) === 1 && completedCalls);
  const { candidates = [], decisions = [], scope_plan: scopePlan, ...protocol } = held ?? {};
  const coverage = scopePlan ? { scope_plan: {
    version: scopePlan.version,
    digest: scopePlan.digest,
    total_files: scopePlan.total_files,
    total_units: scopePlan.total_units,
    omitted_units: scopePlan.omitted.length,
    scopes: scopePlan.scopes.map((scope) => ({
      id: scope.id, files: scope.files.length, units: scope.units.length,
      bytes: scope.bytes, lines: scope.lines, coverage: scope.coverage,
      completed_focuses: scope.completed_focuses,
    })),
  } } : {};
  const metadata = env.PROMPT_FILE ? JSON.parse(read(`${env.PROMPT_FILE}.pipeline.json`, 'utf8')) : {};
  return {
    ...metadata.identity,
    strategy: env.REVIEW_STRATEGY || 'baseline',
    submission_status: env.OPENCODE_REVIEW_SUBMISSION_STATUS || null,
    ...(env.OPENCODE_REVIEW_SUBMISSION_AS_TEXT === 'true' ? { submission_as_text: true } : {}),
    correction_calls: Number(env.OPENCODE_REVIEW_CORRECTIONS || 0),
    ...protocol,
    ...coverage,
    candidates_count: held ? candidates.length : null,
    rejected_count: held ? decisions.filter((decision) => decision.verdict !== 'keep').length : null,
    measured_children: measured,
    unmeasured_children: unmeasured,
    cost_complete: complete && measuredExit && spent && clean && !attempts.some((event) => event.exit_code !== 0) && unmeasured === 0 && (held?.missing_usage ?? 0) === 0,
    stream_attempts: attempts.map(({ exit_code, session_id, failure }) => ({ exit_code, session_id, failure })),
    gateway_failures: gatewayFailures,
    configured_effort: env.VARIANT || null,
    thinking_wire_verified: false,
    runtime,
    lsp,
  };
}
