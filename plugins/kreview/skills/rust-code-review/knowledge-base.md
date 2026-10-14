# Rust Mistakes - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Every item is a candidate failure, not an automatic finding. The "Check For" column names the
situation that must actually hold before you flag, and what to leave alone. Flag an item only
when you can point to the concrete failure it names; idiomatic Rust that compiles and works is
not a finding. The compiler and Clippy already reject much of what other languages need a
reviewer for, so spend the review on what they let through: panics, overflow, logic, async and
the edges of `unsafe`.

`unsafe` code has its own checks in `unsafe_guide`, read only when the diff touches it.

## Errors and panics (1-9)

| # | Issue | Check For |
| --- | ------- | --------- |
| 1 | Reachable `unwrap`/`expect` | Don't flag one on a value the code just proved present, in tests, or in `main` setup that should abort; flag one on input, I/O, parsing or a lookup a caller controls → return the error |
| 2 | Panicking index | Don't flag an index the loop bound or a prior check proves in range; flag `v[i]`, `&s[a..b]` or `map[&k]` where the index or key comes from input → `get`, or check first |
| 3 | String slicing off a char boundary | Don't flag slicing at offsets from `find`, `char_indices` or ASCII-only data; flag byte offsets computed by arithmetic on UTF-8 text → panics on a multi-byte char |
| 4 | Swallowed `Result` | Don't flag a deliberate, commented ignore of an error that cannot matter; flag `let _ =`, `.ok()` or `.unwrap_or_default()` on a write, send, flush or close whose failure loses data |
| 5 | Context lost on `?` | Don't flag `?` inside a function whose error already names the operation; flag `?` that returns a bare I/O or parse error with no path, key or step the caller needs to act on |
| 6 | Error type for the wrong audience | Don't flag `anyhow`/`eyre` in a binary; flag a library's public API returning `anyhow::Error` or `Box<dyn Error>` where callers must match on the cause → a typed error enum |
| 7 | Panic in `Drop` | Don't flag a `Drop` that cannot fail; flag one that can panic, which aborts the process when it runs during another panic's unwinding |
| 8 | Panic across an FFI or thread boundary | Don't flag a panic that ends the process on purpose; flag a panic that can unwind out of an `extern "C"` function, or a `JoinHandle::join` result that is unwrapped and hides the thread's panic message |
| 9 | `todo!`/`unimplemented!` on a live path | Don't flag one behind an unused feature or in a test; flag one any caller can reach in shipped code |

## Integers and casts (10-15)

| # | Issue | Check For |
| --- | ------- | --------- |
| 10 | Overflow that wraps in release | Don't flag arithmetic on values bounded well below the type's limit; flag `+`, `-`, `*` or `<<` on sizes, counts, offsets or input that can reach the limit → `checked_*`, `saturating_*`, or a wider type. Debug builds panic, release builds wrap silently |
| 11 | Lossy `as` cast | Don't flag a widening cast or one on a value proven in range; flag `as` that truncates (`u64 as u32`), changes sign (`i64 as usize`) or saturates a float → `try_from` |
| 12 | Subtraction underflow on lengths | Don't flag `a - b` where `a >= b` is proven; flag `len - 1` on a possibly empty collection, or `end - start` from input → `checked_sub` or `saturating_sub` |
| 13 | Float compare and `NaN` | Don't flag ordered compares on values that cannot be `NaN`; flag `==` on computed floats, or `partial_cmp(...).unwrap()` in a sort on data that can hold `NaN` → `total_cmp` |
| 14 | Division by a zero from input | Don't flag a divisor proven non-zero; flag `/` or `%` on an integer from input or a count that can be zero |
| 15 | Time arithmetic that panics | Don't flag math on values the code produced in order; flag `Duration - Duration`, or `SystemTime::duration_since(...).unwrap()`, where the order is not guaranteed — the wall clock can step back → `checked_sub`, `saturating_sub` |

## Ownership, borrowing and lifetimes (16-22)

| # | Issue | Check For |
| --- | ------- | --------- |
| 16 | Double borrow of a `RefCell` | Don't flag short borrows that end before the next; flag a `borrow_mut` taken while a `borrow` or `borrow_mut` of the same cell is live, including through a callback → runtime panic |
| 17 | Reference cycle leak | Don't flag a tree with `Weak` parent links; flag `Rc`/`Arc` cycles (parent and child both strong, a closure capturing its own owner) that never free |
| 18 | Clone to silence the borrow checker | Don't flag a cheap clone or one off the hot path; flag a clone of a large value in a loop or request path where a borrow, `Rc`, or a restructure would do |
| 19 | Owned parameter where a borrow fits | Don't flag a parameter that is stored or consumed; flag `String`, `Vec<T>` or `PathBuf` taken by value only to be read → `&str`, `&[T]`, `&Path` |
| 20 | `'static` bound forcing leaks | Don't flag `'static` on spawned work that needs it; flag `Box::leak` or `'static` bounds added to dodge a lifetime error on a path that runs more than once |
| 21 | Drop order dependence | Don't flag code that does not depend on it; flag a guard, lock or temporary dropped earlier or later than the code assumes (`let _ = lock()` drops at once; `let _guard = lock()` holds to scope end) |
| 22 | `mem::take`/`replace` leaving a bad state | Don't flag a swap that restores the value; flag one that leaves a default the rest of the code treats as real data when an error returns early |

## Types and traits (23-29)

| # | Issue | Check For |
| --- | ------- | --------- |
| 23 | `Eq`/`Hash`/`Ord` that disagree | Don't flag derived impls; flag a manual `PartialEq` without a matching `Hash`, or an `Ord` inconsistent with `PartialEq` → corrupt `HashMap` or `BTreeMap` behaviour |
| 24 | `Deref` as inheritance | Don't flag smart pointers and newtypes over their inner value; flag `Deref` used to borrow another type's methods, which surprises callers and leaks the inner API |
| 25 | Public enum with no room to grow | Don't flag a private enum or one that is closed on purpose; flag a library's public error or option enum without `#[non_exhaustive]` where adding a variant would break callers |
| 26 | `Default` with a meaningless value | Don't flag a derived `Default` whose zero values are valid; flag one that yields an invalid state (port 0, empty required name) that code later trusts |
| 27 | Stringly typed state | Don't flag text that is free-form; flag a `String` or integer standing for a fixed set of states that an enum would make impossible to misspell |
| 28 | `Send`/`Sync` lost in generics | Don't flag bounds that hold; flag a generic future or type spawned on a multi-threaded runtime whose bound lets an `Rc` or `RefCell` through, or a missing bound that blocks a real caller |
| 29 | Serde defaults that hide errors | Don't flag `#[serde(default)]` on truly optional fields; flag it, or `deny_unknown_fields` missing, on config or input where a typo silently yields the default |

## Iterators and collections (30-35)

| # | Issue | Check For |
| --- | ------- | --------- |
| 30 | `collect` then iterate again | Don't flag a collect whose result is reused; flag an intermediate `Vec` built only to be iterated once in a hot path |
| 31 | Lazy iterator never consumed | Don't flag a consumed chain; flag `map` or `filter` with side effects whose result is dropped (`#[must_use]` warnings silenced), so the effect never runs |
| 32 | `zip` truncation | Don't flag a `zip` over sequences of proven equal length; flag one where a shorter side silently drops trailing items the code needs |
| 33 | `HashMap` order assumed | Don't flag order-free use; flag output, hashing, signatures or tests that depend on `HashMap`/`HashSet` iteration order → `BTreeMap` or sort |
| 34 | Unbounded growth | Don't flag collections bounded by input size the caller controls; flag caches, maps or queues that only ever insert on a long-lived path |
| 35 | `retain`/`drain` while indexing | Don't flag a single pass; flag indices kept across a `remove`, `swap_remove`, `retain` or `drain` that shifts elements |

## Concurrency (36-41)

| # | Issue | Check For |
| --- | ------- | --------- |
| 36 | Lock order deadlock | Don't flag a single lock; flag two locks taken in different orders on two paths, or a lock re-taken while held (`std::sync::Mutex` is not re-entrant) |
| 37 | Poisoned lock unwrapped | Don't flag `lock().unwrap()` where a panic while holding it should abort anyway; flag it where one panicking task should not take every later caller down |
| 38 | Guard held too long | Don't flag a guard scoped to the data it protects; flag one held across I/O, a blocking call, a callback or a send that can wait |
| 39 | Atomic ordering too weak | Don't flag `Relaxed` on a standalone counter; flag `Relaxed` on a flag or index that publishes other data → `Release`/`Acquire` pairs |
| 40 | Check-then-act race | Don't flag a check under the same lock as the act; flag `contains` then `insert`, or a load then a store, across separate lock or atomic operations → `entry`, `compare_exchange` |
| 41 | Thread with no join or stop | Don't flag a thread meant to live for the process; flag one spawned per request or test with no handle kept and no way to stop it |

## Async (42-49)

| # | Issue | Check For |
| --- | ------- | --------- |
| 42 | Blocking on the runtime | Don't flag blocking work in `spawn_blocking` or a dedicated thread; flag `std::fs`, `std::thread::sleep`, synchronous HTTP or heavy CPU work inside an `async fn` on a runtime worker |
| 43 | `std::sync` guard across `.await` | Don't flag a guard dropped before the await; flag a `std::sync::Mutex` or `RwLock` guard live across `.await`, which can deadlock the worker or make the future `!Send` |
| 44 | Cancellation mid-change | Don't flag futures that hold no partial state; flag a future in `select!`, `timeout` or a dropped `JoinHandle` path that can stop between two writes that must happen together |
| 45 | Detached task | Don't flag a task tied to a shutdown signal or a kept handle; flag `tokio::spawn` whose handle is dropped and whose errors and panics vanish |
| 46 | Unbounded channel | Don't flag a bounded channel or one whose producer is bounded; flag `unbounded_channel` fed by input or a fast producer with a slower consumer |
| 47 | Lost wakeup or busy loop | Don't flag a proper `Notify`/channel wait; flag a loop that polls with `sleep`, or a `Notify::notify_waiters` sent before anyone waits, which stores no permit and wakes nobody |
| 48 | Runtime nested in runtime | Don't flag a runtime built in `main`; flag `block_on` or `Runtime::new` inside async code, which panics or deadlocks |
| 49 | Missing timeout on remote calls | Don't flag calls the client already bounds; flag network or IPC awaits with no timeout on a request path |

## Resources and I/O (50-53)

| # | Issue | Check For |
| --- | ------- | --------- |
| 50 | `BufWriter` dropped without flush | Don't flag an explicit `flush()` whose result is checked; flag a `BufWriter` left to `Drop`, which flushes but discards the error |
| 51 | Partial read or write | Don't flag `read_exact`/`write_all`; flag `read` or `write` whose returned count is ignored |
| 52 | Temp files and paths | Don't flag `tempfile` crate use; flag hand-built temp paths with predictable names, or files never removed |
| 53 | `mem::forget`/`Box::leak` on a repeat path | Don't flag a one-time leak for a `'static` value at start-up; flag one on a path that runs per request or per item |

## Security (54-59)

| # | Issue | Check For |
| --- | ------- | --------- |
| 54 | Path traversal | Don't flag paths from trusted config; flag `Path::join` with input that can be absolute or hold `..`, which escapes the base directory |
| 55 | Unbounded deserialisation | Don't flag trusted input; flag `serde_json`, `bincode` or similar on untrusted bytes with no size, depth or length limit |
| 56 | Command injection | Don't flag `Command::new` with fixed arguments; flag input passed through `sh -c` or as a flag-like argument without a `--` separator |
| 57 | Secret in `Debug` or logs | Don't flag types with no secrets; flag `#[derive(Debug)]` or `Display` on a type holding a key, token or password that reaches a log → redact or a secrecy wrapper |
| 58 | Non-constant-time compare | Don't flag compares of public data; flag `==` on MACs, tokens or password hashes → constant-time compare |
| 59 | Weak randomness | Don't flag `rand` for non-security use; flag a non-cryptographic RNG for tokens, keys or nonces |

## Crates and manifests (60-63)

| # | Issue | Check For |
| --- | ------- | --------- |
| 60 | Feature unification surprise | Don't flag additive features; flag a feature that changes behaviour or removes API, which breaks when another crate in the graph turns it on |
| 61 | Default features pulled in | Don't flag defaults the crate needs; flag a dependency whose default features add a heavy or conflicting stack (a second TLS backend, a runtime) the code does not use → `default-features = false` |
| 62 | Public API break | Don't flag internal changes; flag a library change that removes or changes a public item, a trait bound or an enum variant without a major version bump |
| 63 | MSRV or edition drift | Don't flag code within the declared `rust-version`; flag syntax or std APIs newer than the `rust-version` or edition the manifest declares |

## Tests (64-67)

| # | Issue | Check For |
| --- | ------- | --------- |
| 64 | `should_panic` with no message | Don't flag one with `expected = "..."`; flag a bare `#[should_panic]` that passes on any panic, including the wrong one |
| 65 | Async test that never awaits | Don't flag awaited work; flag a test that spawns or builds a future and returns before it runs |
| 66 | Assertion that cannot fail | Don't flag real checks; flag `assert!(x.is_ok() \|\| x.is_err())`, comparisons of a value with itself, or results discarded with `let _ =` |
| 67 | Ignored or time-based test | Don't flag `#[ignore]` with a reason and a tracking issue; flag new `#[ignore]` hiding a failure, or `sleep` used to wait for another thread or task |
