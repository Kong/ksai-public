# 100 Go Mistakes - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Source: <https://100go.co/>

**How to use this catalog:** every item is a *candidate* failure, not an automatic finding.
The "Check For" column is phrased as a negative constraint — the situation that must actually
hold before you flag, and what to leave alone — because a suppression boundary keeps reviewer
precision higher than a bare "do X" directive. Flag an item only when you can point to the
concrete failure it names; idiomatic Go that works is not a finding. A handful of entries are
plain definitions or tooling reminders (e.g. #20, #55) that don't express as a constraint —
they're left as reference and shouldn't be turned into findings on their own.

## Code Organization (1-16)

| # | Issue | Check For |
| --- | ------- | --------- |
| 1 | **Variable Shadowing** | Don't flag a name redeclared in an inner block unless the shadow causes a real wrong-value or hard-to-catch bug (inner value used where the outer was meant, or vice-versa); deliberate short-scope re-`:=` is idiomatic |
| 2 | **Nested Code** | Don't flag nesting on taste; flag only where an un-flipped condition, an `else` after a returning `if`, or a deeply-nested happy path measurably hurts readability → return early, align the happy path left |
| 3 | **Init Functions** | Don't flag a small side-effect-free `init()`; flag one doing error-prone work that limits error handling, complicates testing, or forces globals → move to a dedicated init func |
| 4 | **Getters/Setters** | Don't flag a plain exported field for lacking accessors (Go doesn't require them); flag getters/setters that wrap no real invariant or forward-compat need |
| 5 | **Interface Pollution** | Don't flag a concrete type for having no interface; flag an interface created upfront for a foreseen-not-real need → discover interfaces from usage, add when needed |
| 6 | **Producer-Side Interfaces** | Don't flag a consumer-side interface; flag one defined on the producer side that forces the abstraction onto consumers → implicit satisfaction enables consumer-driven design |
| 7 | **Returning Interfaces** | Don't flag a function returning a concrete type; flag one returning an interface that needlessly restricts the caller and creates a dependency → return concrete, accept interfaces |
| 8 | **`any` Overuse** | Don't flag `any` where genuinely needed (marshaling, truly heterogeneous data); flag it where a concrete type or generic would serve (overgeneralization) |
| 9 | **Premature Generics** | Don't flag a generic solving a real present problem; flag one added for an anticipated-not-actual need where duplication would read clearer |
| 10 | **Type Embedding** | Don't flag embedding used for a genuine promotion need; flag embedding for syntactic sugar, or that promotes private/unintended behavior |
| 11 | **No Functional Options** | Don't flag a small fixed config struct; flag a growing/optional config passed positionally where functional options (unexported struct + option funcs returning `func(*options) error`) fit |
| 12 | **Misorganization** | Don't flag package layout on taste; flag nano-packages, huge grab-bag packages, or a package named for what it contains rather than what it provides → organize by context/layer |
| 13 | **Utility Packages** | Don't flag a specifically-named helper package; flag `common`, `util`, `shared` grab-bag names → require a specific, meaningful name |
| 14 | **Package Collisions** | Don't flag distinct names; flag a var or import that collides with a package name with no distinct name or import alias |
| 15 | **Missing Docs** | Don't flag unexported or already-documented elements; flag an exported element with no doc comment, a comment not starting with the element name, or a package doc missing the `// Package` prefix |
| 16 | **No Linters** | Don't flag a repository whose CI already runs them; flag a change that adds a lint target, a config or a CI step which drops `go vet`, `errcheck`, `golangci-lint` or `gofmt`/`goimports` from the checks the tree had |

## Data Types (17-29)

| # | Issue | Check For |
| --- | ------- | --------- |
| 17 | **Octal Literals** | Don't flag hex/decimal/plain literals; flag a leading-`0` octal (use `0o`), and suggest `0b`/`0x`/underscore separators (`1_000_000`) only where readability suffers |
| 18 | **Integer Overflow** | Don't flag ordinary integer arithmetic; flag arithmetic that can silently overflow at runtime where the values plausibly reach the type's limit and no detection exists |
| 19 | **Floating-Point** | Don't flag ordinary float math; flag an exact `==` compare on floats (compare within a delta); flag add/sub performed before mult/div where precision is lost (reorder so mult/div runs first); flag a sum of very different magnitudes combined without grouping like magnitudes first |
| 20 | **Slice Length/Capacity** | Length = accessible elements; capacity = backing array room |
| 21 | **Slice Init** | Don't flag `make([]T, 0)`/literals in cold paths; flag a slice grown by append in a hot path where the final length/capacity is known up front → preallocate to cut allocations and GC pressure |
| 22 | **Nil vs Empty Slice** | Don't flag the nil-vs-empty choice (nil = unallocated, empty = zero-length allocated, interchangeable for most uses); flag an API that forces callers to distinguish them |
| 23 | **Empty Check** | Don't flag `len(s) == 0`; flag a nil-only check that misses the empty case (`len(s) == 0` covers both nil and empty) |
| 24 | **Slice Copy** | Don't flag a `copy` call unless the destination length is smaller than intended → `copy` moves only min(len(dst), len(src)), so copying into a zero-length (cap-only) slice silently copies nothing |
| 25 | **Slice Append Side Effects** | Don't flag append on a freshly-owned slice; flag append to a sub-slice sharing a backing array with data still used elsewhere → use `copy` or a full slice `s[low:high:max]` |
| 26 | **Slice Memory Leaks** | Don't flag ordinary sub-slicing; flag a small sub-slice retained from a large backing array (capacity leak → copy out), or a shrunk slice still pointing at removed pointer elements (nil them) |
| 27 | **Map Init** | Don't flag `make(map...)` without a size in cold paths; flag a map filled to a known size with no initial size hint in a hot path → avoids rebalancing |
| 28 | **Map Memory Leaks** | Don't flag ordinary map use; flag a long-lived map that grows then logically shrinks but never releases memory (maps grow, never shrink) → recreate or store pointers |
| 29 | **Value Comparison** | Don't flag `==` on comparables (bool, numeric, string, chan, ptr, comparable structs, arrays); flag `==` on slices/maps/funcs where `reflect.DeepEqual` or a custom compare is needed |

## Control Structures (30-35)

| # | Issue | Check For |
| --- | ------- | --------- |
| 30 | **Range Copies** | Don't flag ranging over small value elements; flag mutating or taking the address of the range value expecting it to affect the source → the range value is a copy; use index `slice[i].field` or pointer elements |
| 31 | **Range Evaluation** | Don't flag a stable range expression; flag code that mutates the ranged collection expecting the loop bound to change → the range expression is evaluated once at loop start |
| 32 | **Range Pointers** | Not relevant Go 1.22+ (loop var semantics changed) |
| 33 | **Map Iteration Order** | Don't flag map ranging in general; flag code relying on map iteration order/insertion order, or expecting additions mid-iteration to appear → order is unordered and non-deterministic |
| 34 | **Break Statement** | Don't flag a plain `break`; flag a `break` expected to exit an outer loop from inside a `switch`/`select` → it exits the innermost only; use a label |
| 35 | **Defer in Loop** | Don't flag `defer` in a function-scoped cleanup; flag `defer` inside a loop where resources accumulate until function return → extract the body to a helper so defer runs per iteration |

## Strings (36-41)

| # | Issue | Check For |
| --- | ------- | --------- |
| 36 | **Rune Concept** | Rune = Unicode code point; UTF-8 = 1-4 bytes; `len()` = bytes not runes |
| 37 | **String Iteration** | Don't flag ranging a string for runes; flag `s[i]` byte indexing or `len(s)` used where code points are meant → range gives rune indices/values, `[]rune(s)` to index runes |
| 38 | **Trim Functions** | Don't flag `TrimRight/Left` or `TrimSuffix/Prefix` used for their purpose; flag `TrimLeft/Right` used where exact prefix/suffix removal was meant → they strip a char set, not a substring |
| 39 | **String Concat** | Don't flag `+`/`+=` for a few concatenations; flag `+=` string building inside a loop → `strings.Builder` with `Grow()` (avoids repeated reallocation) |
| 40 | **String Conversions** | Don't flag necessary `[]byte`/`string` conversions; flag a needless round-trip where the `bytes` package mirrors the `strings` operation |
| 41 | **Substring Leaks** | Don't flag ordinary substrings; flag a small substring retained from a large string → shares the backing array; `strings.Clone` (Go 1.18+) |

## Functions/Methods (42-47)

| # | Issue | Check For |
| --- | ------- | --------- |
| 42 | **Receiver Type** | Don't flag a consistent, fitting receiver; flag a value receiver where mutation/sync-type/large-struct needs a pointer, a pointer where a small immutable value (maps/funcs/chans, small structs) would do, or mixed receiver types on one type |
| 43 | **Named Results** | Don't flag positional returns; flag missing named results only where multiple same-type returns are genuinely ambiguous, or a deferred cleanup needs to set the return |
| 44 | **Named Result Side Effects** | Don't flag named results in general; flag one left at its zero value on some code path (e.g. returning `nil` instead of the error) → assign it on every path |
| 45 | **Nil Receiver** | Don't flag returning an explicit `nil` interface; flag returning a typed nil pointer as an interface → yields a non-nil interface holding a nil pointer |
| 46 | **Filename Input** | Don't flag a function that legitimately needs a path; flag one taking a filename purely to read it where an `io.Reader` would improve reuse/testing |
| 47 | **Defer Evaluation** | Don't flag `defer` with stable args; flag a `defer` whose args/receiver are evaluated at the statement but expected to reflect later mutation → pass a pointer or wrap in a closure |

## Error Management (48-54)

| # | Issue | Check For |
| --- | ------- | --------- |
| 48 | **Panicking** | Don't flag `panic` for truly unrecoverable cases (programmer errors, missing mandatory dependency at startup); flag `panic` used for ordinary/expected errors that should return an `error` |
| 49 | **Error Wrapping** | Don't flag a deliberate `%w`/`%v` choice; flag `%w` that leaks an internal error into the public API as unwanted coupling, or `%v` where callers need to `errors.Is/As` the cause |
| 50 | **Error Type Comparison** | Don't flag `errors.As(err, &target)`; flag a type assertion or `==` on a possibly-wrapped error where `errors.As` is needed |
| 51 | **Error Value Comparison** | Don't flag `errors.Is(err, sentinel)`; flag `==` against a sentinel on a possibly-wrapped error where `errors.Is` is needed |
| 52 | **Handling Twice** | Don't flag handling an error once (log OR return); flag one both logged and returned (double handling) → wrap and return to propagate with context |
| 53 | **Not Handling** | Don't flag a documented intentional `_ =` discard; flag a silently ignored error return |
| 54 | **Defer Errors** | Don't flag a defer that can't fail; flag a deferred `Close()`/op whose returned error is dropped where it matters → capture and handle it (`defer func() { if err := ...}()`) |

## Concurrency: Foundations (55-60)

| # | Issue | Check For |
| --- | ------- | --------- |
| 55 | **Concurrency vs Parallelism** | Concurrency = task interleaving; parallelism = simultaneous execution |
| 56 | **Concurrency Speed** | Don't flag concurrency added to I/O-bound work; flag goroutines added to CPU-bound or trivial work where overhead likely makes it slower → benchmark |
| 57 | **Channels vs Mutexes** | Don't flag either primitive when it fits; flag a channel used merely to guard shared state (a mutex is simpler) or a mutex used to hand off/coordinate work (a channel fits) |
| 58 | **Race Problems** | Don't flag correctly-synchronized access; flag unsynchronized concurrent access to shared state (data race) or timing-dependent logic (race condition) → use `-race` |
| 59 | **Workload Type** | Don't flag concurrency on I/O-bound work (it benefits); flag it on CPU-bound work that typically doesn't |
| 60 | **Contexts** | Deadline (timeout); cancellation (signal); values (context data); detect via `ctx.Done()` |

## Concurrency: Practice (61-74)

| # | Issue | Check For |
| --- | ------- | --------- |
| 61 | **Context Propagation** | Don't flag a request-scoped context passed down; flag a request context propagated past the request boundary (e.g. into a background worker that outlives the request) |
| 62 | **Goroutine Lifecycle** | Don't flag a goroutine with a clear stop path; flag one started with no stop mechanism (context cancel, stop channel) that can leak |
| 63 | **Loop Variables** | Don't flag a goroutine reading a loop variable on Go 1.22+ (per-iteration semantics, see #32); flag it on pre-1.22 code capturing the shared loop var → pass it as a param `go func(idx int) { }(i)` |
| 64 | **Select Determinism** | Don't flag a `select` with multiple cases; flag logic assuming a deterministic branch when several are ready → selection is random, non-deterministic |
| 65 | **Notification Channels** | Don't flag a data-carrying channel; flag a `chan bool`/`chan int` used purely for signaling where `chan struct{}` states intent |
| 66 | **Nil Channels** | Don't flag an intentional nil channel disabling a `select` branch; flag an accidentally-nil channel whose send/receive blocks forever |
| 67 | **Channel Size** | Don't flag a deliberate buffer size; flag a buffered channel whose non-zero size is arbitrary/undocumented → default to unbuffered (0) for sync |
| 68 | **String Formatting Side Effects** | Don't flag ordinary `fmt` calls; flag `fmt` formatting of a shared/concurrently-mutated value that can race or deadlock → test with `-race` |
| 69 | **Append Races** | Don't flag append on a goroutine-local slice; flag concurrent append to a shared slice without synchronization → data race; use a mutex |
| 70 | **Mutex Scope** | Don't flag a lock covering the full check-and-modify; flag a lock released between reading and modifying shared state → protect the entire operation |
| 71 | **sync.WaitGroup** | Don't flag correct `Add`/`Done`/`Wait` ordering; flag `Add(n)` after goroutines start, a missing `Done()`, or `Wait()` before scheduling |
| 72 | **sync.Cond** | Don't flag a `sync.Cond`; flag a busy-poll loop waiting on a condition where `sync.Cond` waits efficiently |
| 73 | **errgroup** | Don't flag manual goroutine+error plumbing that works; flag hand-rolled goroutine groups with error handling + context cancel where `errgroup` simplifies |
| 74 | **Copying Sync Types** | Don't flag passing or copying a channel (a reference type, copied freely) or passing a `sync` type by pointer; flag copying a `sync.Mutex`/`WaitGroup`/`Once` (or a struct embedding one) by value → pass a pointer |

## Standard Library (75-81)

| # | Issue | Check For |
| --- | ------- | --------- |
| 75 | **Time Duration** | Don't flag typed durations (`time.Second`); flag a raw int used as a duration |
| 76 | **time.After Leaks** | Don't flag `time.After` used once; flag `time.After` in a select loop (its timer isn't GC'd until fire) → `time.NewTimer` + `defer timer.Stop()` |
| 77 | **JSON Mistakes** | Don't flag correct JSON handling; flag missing/incorrect struct tags, unhandled type conversions, or missing null handling |
| 78 | **SQL Mistakes** | Don't flag parameterized queries with closed resources; flag string-concatenated SQL (use prepared statements), a missing `rows.Err()` after iteration, or unclosed resources |
| 79 | **Resource Closing** | Don't flag a resource already closed via `defer`; flag a `resp.Body`/`rows`/`file` opened without a `defer Close()` |
| 80 | **HTTP Response Return** | Don't flag an `http.Error` followed by `return`; flag a missing `return` after `http.Error()` → handler keeps writing, header overwrite |
| 81 | **Default HTTP Client** | Don't flag a client with configured timeouts; flag `http.DefaultClient` or a server with no read/write/idle timeouts on production paths |

## Testing (82-91)

| # | Issue | Check For |
| --- | ------- | --------- |
| 82 | **Test Categories** | Don't flag tests without build tags in a simple package; flag long/integration tests not separated by `//go:build integration`, env vars, or `-short` mode |
| 83 | **Race Flag** | Don't flag a package with no concurrency; flag a change adding goroutines or shared state where the repository's test invocation carries no `-race`, read off the CI workflow or Makefile in the tree |
| 84 | **Test Modes** | `-parallel N` for concurrency; `-shuffle on` for randomization |
| 85 | **Table-Driven Tests** | Don't flag a focused single-case test; flag copy-pasted near-identical test funcs where a table of inputs/expected outputs fits |
| 86 | **Sleep in Tests** | Don't flag a test with no timing dependency; flag `time.Sleep` used to await async work → use channels/sync primitives |
| 87 | **Time API** | Don't flag tests that don't touch time; flag a test asserting on real wall-clock `time.Now()` with no injectable time → mock it, use `time.Time` fields |
| 88 | **Test Utilities** | Don't flag hand-rolled setup that's fine; flag reinvented test servers/readers where `httptest.NewServer()`/`iotest.TimeoutReader()` exist |
| 89 | **Benchmarks** | Don't flag a simple benchmark; flag one missing `b.ResetTimer()`/`b.ReportAllocs()` or letting the compiler optimize the measured work away |
| 90 | **Test Features** | Subtests `t.Run()`, helpers `t.Helper()`, benchmarks, examples, fuzzing |
| 91 | **Fuzzing** | Don't flag the absence of fuzzing generally; flag parser/edge-case-heavy code that would benefit from a fuzz target |

## Optimizations (92-101)

| # | Issue | Check For |
| --- | ------- | --------- |
| 92 | **CPU Caches** | Don't flag cache concerns in general; flag cache-line contention only in demonstrably hot concurrent code |
| 93 | **False Sharing** | Don't flag struct layout in general; flag false sharing (multiple goroutines hitting one cache line) only with evidence of hot contention → pad structs |
| 94 | **Instruction Parallelism** | Don't flag instruction-level parallelism unless a profile, or a demonstrably hot tight inner loop, shows a serialized dependency chain |
| 95 | **Data Alignment** | Don't flag field order in general; flag ordering only where alignment padding measurably wastes memory in a large/numerous struct → larger types first |
| 96 | **Stack vs Heap** | Don't flag allocations in general; flag heap escapes in a hot path shown by escape analysis/profiling → minimize allocations |
| 97 | **Reduce Allocations** | Don't flag allocations in general; flag repeated hot-path allocations (shown by a profile, or a structurally-obvious per-call/per-iteration allocation visible in the diff, as #21/#27 permit) where `sync.Pool`, API changes, or inlining apply |
| 98 | **Inlining** | Don't flag function size for inlining unless a profile, or a structurally-obvious hot path, shows an inlining-blocked call (speed vs binary size trade-off) |
| 99 | **Diagnostics** | pprof (CPU/memory/goroutine profiling), trace (execution) |
| 100 | **GC** | Understand triggers, tuning options, latency impact |
| 101 | **Container Limits** | Don't flag GOMAXPROCS on Go 1.25+ (cgroup-aware, respects Docker/K8s CPU limits); flag pre-1.25 code in a CPU-limited container with no explicit GOMAXPROCS or `automaxprocs` |

## Common Patterns

**Error Handling:**

```go
// Wrap with context
return fmt.Errorf("fetch user: %w", err)

// Check wrapped errors
errTarget := errors.AsType[targetType](err) // Go 1.26+ generic form
errors.Is(err, sentinelErr)
```

**Concurrency:**

```go
// Goroutine lifecycle
ctx, cancel := context.WithCancel(...)
defer cancel()

// Loop var capture
for i := range items {
  go func(idx int) { use(items[idx]) }(i)
}
```

**Resource cleanup:**

```go
defer resp.Body.Close()
defer rows.Close()
defer file.Close()
```

**Performance:**

```go
// Preallocate
s := make([]T, 0, knownSize)
m := make(map[K]V, knownSize)

// String building
var b strings.Builder
b.Grow(estimatedSize)
```
