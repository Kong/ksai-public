# Real-World Lua and OpenResty Patterns - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: <https://github.com/Kong/kong>, <https://github.com/openresty/lua-nginx-module>, <https://github.com/openresty/lua-resty-core>

Patterns drawn from review practice on gateway and OpenResty code. Each **Check For** is phrased
as a negative constraint — the condition that must actually hold before you flag, and what to
leave alone — so the pattern narrows a finding rather than inviting one on every diff. See
**When to Report / When to Skip** at the end.

## Request path cost

### Resolve configuration once, not per request (Kong/kong)

**Check For:** Don't flag a value that genuinely varies per request; flag a decision derived from plugin config, a header allowlist or a compiled pattern rebuilt on every request

**Pattern:**

- Config-derived booleans and masks resolved at load, at `configure()`, or on a reconfigure event
- Compiled patterns held as module upvalues
- The per-request path reads a resolved value rather than deriving one
- A cache keyed by the config's own identity where the value cannot be hoisted

**Why:** The work is identical on every request and the config changes rarely, so the cost is pure repetition on the busiest path in the process

### Guard the disabled path first (Kong/kong)

**Check For:** Don't flag a guard that already costs one comparison; flag instrumentation, tracing, debug headers or plugin iteration that assembles state before discovering the feature is off

**Pattern:**

- The cheapest possible test comes first: a boolean, a bitmask, a count
- No table, closure or string is built before that test
- Feature-off is the fast path, not the same path with a branch at the end

**Why:** Most deployments have most optional features off, so the disabled path is the one nearly every request takes

### Prefer a direct variable to a generic helper in hot code (Kong/kong)

**Check For:** Don't flag a helper used once or off the request path; flag a generic header or variable accessor called per request where a direct field exists

**Pattern:**

- `var.http_host` rather than a generic header-table lookup
- Names are constant, never concatenated at request time
- The accessor is localized as an upvalue when called in a loop

**Why:** A dynamic name forces a lookup by string; a constant field is resolved far more cheaply, and the difference is per request

### Reuse tables rather than reallocating them (Kong/kong)

**Check For:** Don't flag a small short-lived table; flag a per-request table on a hot path where the surrounding code already pools or clears

**Pattern:**

- A table fetched from a pool and released on every exit path, including error returns
- Cleared and reused where ownership is unambiguous
- Pre-sized when the count is known
- Direct indexed assignment rather than repeated `insert` in an inner loop

**Why:** Allocation is the dominant cost in per-request Lua, and the garbage it makes is paid for by every other request in that worker

## Concurrency and lifetime

### Single-flight an expensive miss (Kong/kong)

**Check For:** Don't flag a cache whose miss is cheap; flag an expensive loader with no lock, or a locked loader that never re-reads the cache after waiting

**Pattern:**

- Read the cache, take a lock only on a miss, then read the cache again before doing the work
- The lock is released on every path, including the error return
- No outbound call is made while the lock is held longer than it must be
- A timeout on the lock itself, so a stuck holder does not stall the worker

**Why:** Without the second read every waiter repeats the work the first one just finished, which is the stampede the lock was added to prevent

### Give every timer a `premature` branch and a bound (Kong/kong)

**Check For:** Don't flag a timer that checks `premature`; flag a callback whose first argument is unused, or a self-rescheduling chain with no stop condition

**Pattern:**

- The callback returns early when `premature` is set
- `ngx.timer.at` results are checked, because the running-timer pool is finite
- Recurring work uses a bounded interval and can be stopped
- The closure holds configuration, never `ngx.ctx` or a request-scoped socket

**Why:** A timer outlives the request that created it; anything request-scoped it captures is kept alive with it, and shutdown work runs against resources that are going away

### Set timeouts on every outbound call (Kong/kong)

**Check For:** Don't flag a call whose timeouts are set explicitly; flag one on the request path relying on inherited defaults

**Pattern:**

- Connect, send and read timeouts each set from configuration
- The socket is either kept alive after a clean exchange or closed
- A socket is never returned to the pool after a timeout or with a body left unread
- Failures answer `nil, err` and the caller decides, rather than raising

**Why:** An inherited default is often measured in minutes; a slow upstream then holds a worker's connection slot far past the point the request was useful

## Correctness on shared state

### Keep request state in `ngx.ctx`, never on the module (Kong/kong)

**Check For:** Don't flag a bounded cache on a module table; flag request-scoped data written to module-level state

**Pattern:**

- Per-request values live in `ngx.ctx`, taken into a local where read repeatedly
- Module tables hold configuration and caches, keyed so one request cannot read another's entry
- Anything set before an internal redirect is re-established afterwards

**Why:** A worker serves many requests concurrently, so module state written per request is a cross-request leak that looks correct under single-request testing

### Put every dimension in the cache key (Kong/kong)

**Check For:** Don't flag a key that already carries its dimensions; flag one omitting the consumer, credential, workspace, route or service the value depends on

**Pattern:**

- The key names every input the value varies by
- Request-controlled components are bounded or hashed, so a caller cannot fill the cache
- Negative results are cached with their own TTL
- Invalidation reaches every layer holding the value, not only the local one

**Why:** A missing dimension is a cross-tenant data leak that presents as a cache hit, and it will not reproduce until two tenants are warm at once

### Bound what a shared dictionary holds (Kong/kong)

**Check For:** Don't flag a bounded cache; flag per-request or per-consumer keys written with no TTL, or a `set` whose `forcible` return is ignored

**Pattern:**

- Every write carries a TTL
- `ok, err, forcible` is read, and `forcible` is treated as an undersized dictionary rather than success
- Counters use `incr` rather than read-modify-write
- Key cardinality is bounded by configuration, not by traffic

**Why:** A full shared dictionary evicts to make room, so unbounded writes quietly evict the entries the cache exists for and the failure shows up as a hit-rate collapse elsewhere

## Plugin surface

### Validate at the schema, not in the handler (Kong/kong)

**Check For:** Don't flag a field already typed by `typedefs`; flag a free-form field taking a host, port, URL, regex or timeout with no validator

**Pattern:**

- Schema types come from `typedefs` where one exists
- Credentials are marked so they are not returned or logged in plain text
- Defaults are the safe value, and a new field never defaults to verification off
- The handler assumes the schema held, rather than re-checking

**Why:** Schema validation runs once at configuration time and is reported to the operator; a handler check runs on every request and reports to nobody

### End a request through the PDK (Kong/kong)

**Check For:** Don't flag an error propagated to a caller that handles it; flag a plugin ending a request by raising

**Pattern:**

- `kong.response.exit` with the status the plugin means
- Errors carry enough context to be actionable in a log, and no secret
- Getters that may answer `nil` — consumer, route, service, credential — are checked
- Headers are set before the body has begun

**Why:** A raise becomes a 500 with a generic body, which is neither the status the plugin intended nor a signal an operator can act on

## Tests

### Wait on a condition, never on a clock (Kong/kong)

**Check For:** Don't flag a sleep with a stated reason; flag one standing in for config propagation, a restart or an upstream becoming ready

**Pattern:**

- A helper polls for the condition with a deadline
- The assertion is on the condition itself, not on having waited
- Setup that must happen once is not repeated per case
- Anything the test created is removed by the test that created it

**Why:** A fixed sleep is either slower than it needs to be or shorter than the slowest machine needs, and the second case is a flake nobody can reproduce locally

### Cover the phase the change touched (Kong/kong)

**Check For:** Don't flag broad coverage; flag a change scoped to one nginx phase with no case exercising that phase

**Pattern:**

- A change in `header_filter` has a case asserting on response headers
- A change in `body_filter` has a case with a chunked body, not only a short one
- A change in `log` has a case asserting the record, not the response
- A balancer or retry change has a case with a failing upstream

**Why:** Phase behaviour differs enough that a test in the wrong phase passes while the changed code is never reached

## When to Report / When to Skip

**Report** where you can name the request, the input or the sequence that makes the pattern
fail: the concurrent pair that reads each other's state, the key that collides, the upstream
that hangs, the config value that is absent.

**Skip** where the pattern is present but the surrounding code already answers it — a bound
enforced upstream of the diff, a timeout set by a shared helper, a cache key completed by a
caller — and where the code is off the request path and the cost the pattern names is not paid
per request. Say which, so the caller can tell a considered skip from an oversight.
