# Lua, LuaJIT and OpenResty Mistakes - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: <https://www.lua.org/manual/5.1/>, <https://luajit.org/extensions.html>, <https://github.com/openresty/lua-nginx-module>, <https://developer.konghq.com/gateway/pdk/>

**How to use this catalog:** every item is a *candidate* failure, not an automatic finding.
The "Check For" column is phrased as a negative constraint — the situation that must actually
hold before you flag, and what to leave alone — because a suppression boundary keeps reviewer
precision higher than a bare "do X" directive. Flag an item only when you can point to the
concrete failure it names; idiomatic Lua that works is not a finding. Much of this catalog is
about request-path code in an event loop, so several items are worth flagging only where the
code actually sits on that path — the entry says so where it matters.

## Scope and declaration (1-12)

| # | Issue | Check For |
| --- | --- | --- |
| 1 | Accidental global | Don't flag a deliberate module export or a documented global; flag an assignment with no `local` that was clearly meant to be file-scoped, because in an nginx worker it is shared by every request that worker handles |
| 2 | Global read in a hot function | Don't flag a global read in `init_by_lua` or a one-off script; flag a repeated global or module-table read inside a per-request function where a local upvalue would do |
| 3 | `local` inside a loop body that could be hoisted | Don't flag a local whose value genuinely changes per iteration; flag a constant, a compiled pattern or a `require` result re-created on every pass |
| 4 | `require` at request time | Don't flag `require` at module load or in `init_by_lua`; flag one reached from a request phase, where the first call takes the module loader on a live request |
| 5 | Module state written per request | Don't flag a cache keyed and bounded on purpose; flag a module-level table mutated per request with no key isolating one request from another, since the worker outlives every request |
| 6 | Upvalue limit | Don't flag a normal closure; flag a function reaching past ~60 upvalues or ~200 locals in one scope, which LuaJIT refuses to compile |
| 7 | Shadowed name | Don't flag deliberate shadowing in a short block; flag a shadowed `err`, `ok` or `ctx` where the outer value is still needed after the block |
| 8 | Missing `local function` for recursion | Don't flag a mutual recursion written with a forward declaration; flag `local f = function() ... f() ... end`, where `f` inside the body resolves to a global |
| 9 | Module returns nothing | Don't flag a module loaded only for its side effects; flag one whose file ends with no `return`, so `require` answers `true` and every caller indexes a boolean |
| 10 | Circular `require` | Don't flag two modules that only reference each other lazily; flag a top-level `require` cycle, which raises `loop or previous error loading module` rather than resolving, and flag a module that publishes a half-built table into `package.loaded` to break one |
| 11 | Name collision with a Lua or ngx global | Don't flag a local named `type` in a two-line block; flag a module-level redefinition of `type`, `next`, `pairs`, `error`, `ngx` or `kong` |
| 12 | `setfenv`/`_ENV` on shared code | Don't flag a sandbox written on purpose with a documented boundary; flag an environment swap reaching code other requests also call |

## Tables, strings and numbers (13-30)

| # | Issue | Check For |
| --- | --- | --- |
| 13 | `#` on an array with holes | Don't flag `#t` on a densely built array; flag it where a `nil` can land in the middle, because the length operator may answer at either side of the hole |
| 14 | `table.remove` inside a forward loop | Don't flag removal from the end; flag removal by index while iterating upward, which skips the element that shifts down |
| 15 | `table.insert` with an explicit position in a loop | Don't flag an append; flag positional insert in a loop, which is O(n) per call and O(n²) over the loop |
| 16 | `ipairs` over a table with holes | Don't flag `ipairs` over a contiguous array; flag it where the array is built from optional fields, since iteration stops at the first `nil` |
| 17 | `pairs` where order matters | Don't flag `pairs` used for a set or a lookup; flag it where the result is written to a response, a signature, a cache key or a config file, because hash order is not stable |
| 18 | Off-by-one from 0-indexed thinking | Don't flag a deliberate 0 index used as a count slot; flag a loop starting at 0 or ending at `n - 1` over a 1-indexed array |
| 19 | Repeated string concatenation | Don't flag two or three concatenations; flag `s = s .. x` inside a loop, where every pass allocates a new interned string |
| 20 | `string.format` in a hot loop | Don't flag formatting in a log line behind a level check; flag it on every request where `table.concat` over fixed parts would do |
| 21 | Pattern where a plain find would do | Don't flag a pattern that needs pattern semantics; flag `string.find(s, sub)` with no `true` fourth argument where `sub` is literal and may contain magic characters |
| 22 | Lua pattern treated as a regex | Don't flag a correct Lua pattern; flag `%d+` style code carrying regex-only syntax such as `\d`, alternation, `+?` or a lookahead, which Lua patterns do not have |
| 23 | Unanchored pattern used as validation | Don't flag a search; flag a pattern used to accept input without `^` and `$`, which matches anywhere in the string |
| 24 | `tonumber` result unchecked | Don't flag a conversion of a value already validated; flag `tonumber(input)` fed straight into arithmetic or a comparison, since it answers `nil` on bad input |
| 25 | Integer assumed | Don't flag arithmetic on values known to be whole; flag an index, a count or a byte offset derived from division without `math.floor`, because Lua 5.1 numbers are doubles |
| 26 | Float equality | Don't flag comparison of small whole numbers; flag `==` between computed floats where an epsilon is needed |
| 27 | Table used as a key by value | Don't flag a table key used deliberately by identity; flag code expecting two equal-looking tables to be the same key |
| 28 | `table.concat` over non-strings | Don't flag concat over a table of strings; flag one whose elements may be numbers mixed with `nil`, or booleans, which raises at runtime |
| 29 | Missing `table.new`/`table.clear` where sizes are known | Don't flag a small short-lived table; flag a per-request array of known size rebuilt with repeated `insert` on a hot path |
| 30 | `os.date`/`os.time` for durations | Don't flag wall-clock formatting for a log; flag elapsed-time arithmetic taken from wall clock rather than a monotonic source, which jumps when the clock is stepped |

## Errors and control flow (31-46)

| # | Issue | Check For |
| --- | --- | --- |
| 31 | Ignored second return value | Don't flag a call whose error is genuinely impossible; flag `local v = f()` where `f` answers `value, err` and the error is dropped |
| 32 | `pcall` swallowing the error | Don't flag a `pcall` whose failure is handled; flag one whose second return is discarded, so the failure leaves no trace anywhere |
| 33 | Truthiness confused with success | Don't flag a boolean-returning API; flag `if f() then` where `f` answers `false` legitimately, or answers `nil, err` and `false` is a valid value |
| 34 | `error()` across an API boundary | Don't flag an assertion on a programmer error; flag a raise where the caller's contract is `nil, err`, since callers will not be wrapping it |
| 35 | `error()` with a table and a level | Don't flag a string error; flag a table error passed a level argument, which is ignored, or a string error whose level puts the position on the wrong frame |
| 36 | `assert` on a call with a message return | Don't flag `assert(cond, msg)`; flag `assert(f())` where `f` answers `nil, err`, which discards `err` when it is a table rather than a string |
| 37 | `pcall` around a yielding call | Don't flag `pcall` in plain Lua; flag it wrapping a cosocket or sleep call in a Lua version where `pcall` is not yield-safe, since the coroutine cannot resume through it |
| 38 | Error message without context | Don't flag a message a caller can act on; flag one propagated with no key, host or identifier, which is unactionable in a log |
| 39 | `goto continue` without a label in scope | Don't flag correct `goto` use; flag a jump into the scope of a local, which Lua rejects, or a label that is not reachable |
| 40 | Missing `else` on an exhaustive branch | Don't flag a branch with a sensible fallthrough; flag a dispatch on a string where an unknown value falls through silently |
| 41 | `return` in the middle of a block | Don't flag an early return; flag a `return` not at the end of a block, which is a syntax error in Lua 5.1 without a `do ... end` |
| 42 | Cleanup only on the success path | Don't flag code with no resource; flag a lock, a socket, a file or a pooled table released only where the function returns normally |
| 43 | `select('#', ...)` versus `#{...}` | Don't flag varargs with no `nil`; flag a count taken from a table built from varargs that may contain `nil` |
| 44 | Coroutine error not propagated | Don't flag a resumed coroutine whose result is checked; flag one whose `false, err` return is dropped |
| 45 | Retry with no bound | Don't flag a bounded retry; flag a `while true` retry with no attempt cap, no backoff, or no cancellation |
| 46 | Retry on a non-idempotent call | Don't flag a retried read; flag a retried write or POST with no idempotency key |

## LuaJIT and the hot path (47-62)

| # | Issue | Check For |
| --- | --- | --- |
| 47 | `#t` as a loop condition | Don't flag `#t` evaluated once; flag it in the loop condition or repeated in the body, where the length operator is re-evaluated per pass |
| 48 | Generic iteration on a hot array | Don't flag `pairs` on a map; flag `pairs` or `ipairs` on a hot request-path array whose count is already known, where a numeric `for` is cheaper and JIT-friendly |
| 49 | NYI construct in a hot loop | Don't flag NYI code in `init_worker`; flag varargs, `table.pack`, generic `unpack`, `string.gmatch`, `pcall` in older LuaJIT, or a tail call inside a per-request loop, which aborts the trace |
| 50 | Closure allocated per request | Don't flag a closure created once at module scope; flag one built per request or per iteration where a hoisted function taking arguments would do |
| 51 | Table allocated per request | Don't flag a small table whose lifetime is one call; flag a per-request table on a hot path where a reused, cleared table or a pooled one is the surrounding idiom |
| 52 | Unlocalized library function on a hot path | Don't flag a single call; flag repeated `ngx.var`, `string.sub`, `table.concat` or `type` lookups through their module tables inside a per-request loop |
| 53 | Dynamic `ngx.var` name | Don't flag a fixed `ngx.var.http_host`; flag `ngx.var[name]` built by concatenation on a hot path, which is far more expensive than a direct field |
| 54 | `ngx.re` without cached flags | Don't flag a one-off match; flag a repeated `ngx.re.match`/`find`/`gsub` without the `jo` options, which recompiles the pattern every call |
| 55 | User-controlled pattern compiled per request | Don't flag a pattern from static configuration; flag one built from request data, which is both a compile cost and a backtracking risk |
| 56 | JSON encode or decode on the common path | Don't flag encoding in a log or an admin handler; flag a decode of a whole request body, or an encode of a response, on a path taken by every proxied request |
| 57 | Expensive parsing where a cheap check would do | Don't flag parsing that the logic needs; flag URL, PEM, certificate or header-table materialisation performed before a guard that would have skipped it |
| 58 | Feature check re-evaluated per request | Don't flag a value that can change per request; flag a configuration-derived boolean recomputed on every request rather than resolved once at start or reconfigure |
| 59 | Disabled path that still costs | Don't flag an already-cheap guard; flag instrumentation, timing, debug headers or plugin iteration running when the feature is off |
| 60 | String buffer not used for a large build | Don't flag building a short string; flag an incremental build of a large body without `table.concat` or a string buffer |
| 61 | `string.rep` or a large allocation on a request | Don't flag a bounded allocation; flag one whose size comes from request input with no cap |
| 62 | Deep recursion on request data | Don't flag bounded recursion; flag recursion over a structure whose depth comes from the request, which has no stack guard |

## OpenResty phases and context (63-78)

| # | Issue | Check For |
| --- | --- | --- |
| 63 | Yielding call in a phase that cannot yield | Don't flag a socket call in `access` or `content`; flag a cosocket, `ngx.sleep`, `ngx.location.capture` or a yielding cache miss in `init_by_lua`, `init_worker_by_lua`, `set_by_lua`, `header_filter_by_lua`, `body_filter_by_lua` or `log_by_lua`, where the API is unavailable and the request fails |
| 64 | Blocking call anywhere in a worker | Don't flag a blocking call in a build script; flag `os.execute`, `io.open`, `io.read`, an LuaSocket call or a busy-wait in worker code, which stalls every connection that worker holds |
| 65 | `ngx.sleep` used as a wait | Don't flag a deliberate backoff; flag a sleep standing in for a condition that should be waited on, or any sleep on the request path |
| 66 | `ngx.ctx` read repeatedly | Don't flag one read; flag repeated `ngx.ctx` access in the same function where the table could be taken into a local, since each access goes through a metatable |
| 67 | `ngx.ctx` expected to survive an internal redirect | Don't flag context set and read in one phase; flag a value written before `ngx.exec`, `ngx.redirect` or an internal rewrite and read after, since the table is reset |
| 68 | Per-request state on the module table | Don't flag a bounded cache; flag request state written to a module-level variable rather than `ngx.ctx`, which leaks between concurrent requests on the same worker |
| 69 | Headers set after they were sent | Don't flag a header set in `access` or `header_filter`; flag one set after the body has started, which is silently dropped or raises |
| 70 | Response body read after a filter has run | Don't flag reading the body in `access`; flag an assumption that `body_filter` sees the whole body in one call, since it is called per chunk with `ngx.arg[2]` marking the last |
| 71 | Request body read without `read_body` | Don't flag a body read after an explicit read; flag `ngx.req.get_body_data()` with no preceding `ngx.req.read_body()`, which answers nil |
| 72 | Body assumed to be in memory | Don't flag a small body; flag `get_body_data` with no fallback to the temp-file path, which is where a large body lands |
| 73 | Subrequest used for an external call | Don't flag an internal capture; flag `ngx.location.capture` standing in for an HTTP client, which cannot be used from every phase and shares the request's lifetime |
| 74 | `ngx.exit` with the wrong status | Don't flag `ngx.exit(ngx.HTTP_OK)` in `content`; flag it in `access` or `rewrite`, where `ngx.OK` and an HTTP status mean different things |
| 75 | Work done after the response is finished | Don't flag logging in `log_by_lua`; flag work there that needs the request's resources, since they may already be released |
| 76 | Missing worker guard on start-up work | Don't flag work every worker must do; flag a leader-only task in `init_worker_by_lua` with no `ngx.worker.id() == 0` check, which runs once per worker |
| 77 | `init_by_lua` state assumed to be shared | Don't flag data deliberately shared by fork; flag a table populated in `init_by_lua` and then mutated per worker, since each worker has its own copy after fork |
| 78 | Phase-specific API called from a library | Don't flag a helper called from one phase; flag a shared helper reaching a phase-restricted API with no check for where it is running |

## Timers, locks and connections (79-92)

| # | Issue | Check For |
| --- | --- | --- |
| 79 | Timer callback ignoring `premature` | Don't flag a callback that checks it; flag one whose first argument is unused, so the callback does its work while the worker is shutting down |
| 80 | Timer created per request | Don't flag a bounded background task; flag `ngx.timer.at` on the request path, which is capped by `lua_max_running_timers` and drops silently once exhausted |
| 81 | Timer creation result unchecked | Don't flag a checked call; flag `ngx.timer.at` whose `ok, err` is dropped, so an exhausted pool looks like a scheduled task |
| 82 | Recurring timer with no cancellation | Don't flag `ngx.timer.every`; flag a self-rescheduling `ngx.timer.at` chain with no stop condition and no `premature` handling |
| 83 | Timer closure capturing request state | Don't flag captured configuration; flag a timer closure holding `ngx.ctx`, a request table or a socket, which outlives the request that made it |
| 84 | Socket without a timeout | Don't flag a socket whose timeouts are set; flag one created with no `settimeout`/`settimeouts`, which inherits an nginx default that may be far too long |
| 85 | Connection not kept alive or not closed | Don't flag a deliberately closed connection; flag a cosocket left neither `setkeepalive`'d nor closed on an error path, which drains the pool |
| 86 | Keepalive after a failed or partial exchange | Don't flag keepalive after a clean response; flag a socket returned to the pool after a timeout or an unread body, which poisons the next user of that connection |
| 87 | DNS or HTTP call with no timeout | Don't flag a call with explicit timeouts; flag an outbound call on the request path whose connect, send and read timeouts are all left at defaults |
| 88 | Lock acquired without a release on every path | Don't flag a lock released in all branches; flag `resty.lock` whose `unlock` is missed on an error return |
| 89 | Lock held across a yielding call | Don't flag a short critical section; flag a lock held across an outbound request, which serialises every worker on the slowest call |
| 90 | Missed second cache read after the lock | Don't flag a documented single-flight; flag a lock-acquire path that does not re-read the cache after waiting, so every waiter repeats the work |
| 91 | Unbounded concurrency fan-out | Don't flag a small fixed set of parallel calls; flag `ngx.thread.spawn` in a loop over request-sized input |
| 92 | Spawned thread never awaited | Don't flag a deliberately detached task; flag a spawned light thread whose `ngx.thread.wait` is missing, so its error is lost and the request may end first |

## Shared dictionaries and caching (93-104)

| # | Issue | Check For |
| --- | --- | --- |
| 93 | `shdict:set` return values dropped | Don't flag a checked write; flag one ignoring `ok, err, forcible`, since `forcible` means the write evicted another key and the dictionary is undersized |
| 94 | Shared dictionary as unbounded storage | Don't flag a bounded cache; flag per-request or per-consumer keys written with no TTL and no bound, which turns the dictionary into an eviction machine |
| 95 | No TTL on a cached value | Don't flag a value invalidated by an event; flag a cache entry with neither TTL nor invalidation path |
| 96 | Negative result not cached | Don't flag a cheap miss; flag an expensive lookup whose "not found" is not cached, so every request for a missing key does the work |
| 97 | Cache key missing a dimension | Don't flag a complete key; flag one omitting the consumer, workspace, tenant, route or credential the value actually depends on, which serves one caller's data to another |
| 98 | Cache key built from unbounded input | Don't flag a bounded key; flag one concatenating a header or path from the request, which lets a caller fill the cache |
| 99 | Expensive work outside the cache callback | Don't flag work that must happen per request; flag an outbound call or a parse performed before the cache lookup rather than inside the loader |
| 100 | Cache used to hide unbounded work | Don't flag a cache in front of bounded work; flag one whose miss path has no timeout or no bound, since a miss is still production traffic |
| 101 | Stale value never resurrected | Don't flag a strict cache; flag a loader whose failure evicts the last good value, leaving the path with nothing during an outage |
| 102 | Invalidation on one node only | Don't flag a worker-local cache; flag an invalidation that clears the local layer and never propagates to the other nodes holding the same value |
| 103 | LRU cache shared across workers by assumption | Don't flag a documented per-worker cache; flag `resty.lrucache` treated as cluster or worker-shared state, since it is per worker |
| 104 | Incrementing a counter without `incr` | Don't flag a single-writer counter; flag a read-modify-write on a shared dictionary where `incr` exists, which loses updates under concurrency |

## Kong plugin surface (105-118)

| # | Issue | Check For |
| --- | --- | --- |
| 105 | Schema field without validation | Don't flag a field with a `typedefs` type; flag a free-form string or number taking a host, port, URL, regex or timeout with no validator |
| 106 | Secret field not marked | Don't flag a public setting; flag a credential, token or key field with no `encrypted`/`referenceable` marking, which puts it in plain text in the admin API and the logs |
| 107 | Insecure default | Don't flag a default that is safe; flag a new field defaulting to verification off, TLS verification skipped, or an allow-all value |
| 108 | Missing or wrong `PRIORITY` | Don't flag a priority consistent with the plugin's role; flag an auth plugin ordered after a plugin that depends on the identity it sets |
| 109 | `VERSION` not moved with a behaviour change | Don't flag an unchanged version on a docs-only change; flag a handler or schema behaviour change with no version move |
| 110 | Handler doing configuration work per request | Don't flag per-request logic that needs the request; flag parsing or building from `conf` on every request where `configure()` or a keyed cache would do it once |
| 111 | Database access from a request phase | Don't flag an admin-API handler; flag a `kong.db` query on the proxy path with no cache in front, which puts the datastore on every request |
| 112 | PDK call in the wrong phase | Don't flag correct phase use; flag `kong.response.set_header` after the body has begun, `kong.request` in `init_worker`, or a service call after the balancer has run |
| 113 | Error returned without `kong.response.exit` | Don't flag a propagated error; flag a plugin ending a request by raising, which yields a 500 in place of the status the plugin meant |
| 114 | Sensitive value logged | Don't flag a redacted log; flag a token, key, authorization header or full request body written to `kong.log` |
| 115 | Log at the wrong level or without a check | Don't flag a warn on a real problem; flag debug logging built unconditionally, where the string is assembled even when the level is off |
| 116 | Missing `nil` handling on a PDK getter | Don't flag a getter whose value is guaranteed; flag consumer, route, service or credential reads used without a `nil` check, since any of them may be absent |
| 117 | Trusting a client-supplied header | Don't flag a header validated or stripped; flag an identity, IP or tenant taken from a request header with no trusted-proxy check and no clearing of the inbound value |
| 118 | Workspace or tenancy not carried through | Don't flag single-tenant code; flag a lookup, a cache key or an event that drops the workspace the request belongs to |

## Tests (119-128)

| # | Issue | Check For |
| --- | --- | --- |
| 119 | Fixed sleep standing in for a condition | Don't flag a sleep with a documented reason; flag a `sleep(n)` waiting for propagation, a restart or a config push, which is the most common source of a flaky suite |
| 120 | Assertion that cannot fail | Don't flag a broad assertion with a narrow one beside it; flag a test asserting only that a call returned, or comparing a value to itself |
| 121 | Happy path only | Don't flag a suite with negative cases elsewhere; flag a new behaviour whose failure, timeout and permission-denied paths have no case |
| 122 | Shared state not cleaned up | Don't flag a test that truncates what it created; flag one leaving a route, consumer, plugin or shared-dictionary key behind for the next test to find |
| 123 | Order dependence | Don't flag a suite with explicit setup per case; flag a test that only passes after another has run |
| 124 | `busted` lifecycle in the wrong block | Don't flag correct placement; flag setup in `it` that belongs in `before_each`, or expensive setup in `before_each` that belongs in `setup` |
| 125 | Error asserted by message text | Don't flag an assertion on a stable, documented message; flag one matching an incidental string that a refactor will move |
| 126 | Missing case for the phase that changed | Don't flag broad coverage; flag a change to a specific nginx phase with no test exercising that phase |
| 127 | Test asserting on hash iteration order | Don't flag an order-insensitive assertion; flag one comparing a serialized table or a header list built with `pairs` |
| 128 | Config assertions missing the negative | Don't flag a schema test covering valid input; flag one with no case proving an invalid value is rejected |
