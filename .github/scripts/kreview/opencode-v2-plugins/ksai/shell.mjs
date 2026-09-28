export function bounded(options) {
  const limit = options?.timeout_ms;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('the ksai plugin was handed no shell timeout, so one shell call could hold the run until the job is cancelled');
  return (event) => {
    event.timeout = event.timeout > 0 ? Math.min(event.timeout, limit) : limit;
  };
}
