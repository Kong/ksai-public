# TypeScript and JavaScript mistakes - code review reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command, compiler flag or lint rule named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: the typescript-eslint type-checked rule set, the TypeScript handbook's own compiler-option documentation, and the published accounts of TypeScript's unsoundness listed at the end.

**How to use this catalog:** every item is a *candidate* failure, not an automatic finding.
The "Check For" column is phrased as a negative constraint - the situation that must actually
hold before you flag, and what to leave alone - because a suppression boundary keeps reviewer
precision higher than a bare "do X" directive. Flag an item only when you can point to the
concrete failure it names; idiomatic TypeScript that works is not a finding.

**The compiler is not in the room.** Many items below are caught by `tsc`, or by a type-aware
lint rule where the repository has one on. Read the repository's `tsconfig.json` and lint
configuration where the diff carries them, and where it does not, prefer the items no
configuration catches - the ones about `as`, about validation at a boundary, about what a type
asserts versus what arrives at runtime. A finding a project's own gate already blocks is noise.

## Type system: assertions and escapes (1-14)

| # | Issue | Check For |
| --- | ------- | --------- |
| 1 | **`as` hiding a real mismatch** | Don't flag `as const`, a narrowing after a checked guard, or an assertion the surrounding code proves; flag an `as` that renames a value the code never verified - the compiler stops checking there and the wrong shape surfaces at runtime |
| 2 | **Double assertion** | Don't flag a single assertion between related types; flag `as unknown as T`, which exists only to defeat the compiler's own rejection of the direct assertion → that rejection was the finding |
| 3 | **Non-null assertion** | Don't flag a trailing `!` where the preceding lines prove non-null; flag one on a value whose absence is reachable - a map lookup, an optional field, an array index, a DOM query → the crash is a `TypeError`, not a type error |
| 4 | **`any` in a signature** | Don't flag `any` in a genuinely heterogeneous position or an untyped third-party shim; flag `any` on a parameter or a return, which spreads - everything derived from it is unchecked too |
| 5 | **`any` leaking from a boundary** | Don't flag a validated parse; flag a value from `JSON.parse`, a response body, a dynamic import, a `catch` binding or an untyped module used as though it had the declared type - none of them are checked at runtime |
| 6 | **`unknown` narrowed by assertion** | Don't flag `unknown` narrowed by `typeof`, `in`, `Array.isArray` or a real guard; flag `unknown` immediately asserted to a type, which is the escape in #1 with an extra step |
| 7 | **A type predicate that does not check** | Don't flag a guard whose body checks every field it claims; flag one returning `x is T` whose body checks fewer fields than `T` requires, or none - the compiler trusts the signature, never the body |
| 8 | **`satisfies` read as a cast** | Don't flag `satisfies` used to keep a literal's narrow type while checking it; flag one swapped in where the code needed the wider annotation, so a later assignment loses the constraint |
| 9 | **Index access assumed present** | Don't flag an access the code bounds-checks, or one in a repository whose `tsconfig.json` sets `noUncheckedIndexedAccess`; flag an array index, a record lookup or a `find` result used without a presence check where the miss is reachable |
| 10 | **Optional versus explicitly undefined** | Don't flag an optional property used consistently; flag code that distinguishes "absent" from "present and undefined" while the type does not - spreading a partial sets keys to `undefined`, which `in` and `Object.keys` still see |
| 11 | **Excess properties passed through a variable** | Don't flag an object literal checked at its annotation; flag an object built into a variable and then passed, where the extra property the author meant to remove survives - excess property checking applies to fresh literals only |
| 12 | **Enum comparison** | Don't flag a string enum compared to its own member; flag a numeric enum compared against a raw number, or two enums mixed, where a renumbering silently changes the branch taken |
| 13 | **Declaration merging or module augmentation** | Don't flag an augmentation the repository owns; flag one that widens a third-party type to make a call compile - the runtime behaviour is unchanged and the next upgrade removes the evidence |
| 14 | **A generic parameter the compiler defaulted** | Don't flag an explicit type argument; flag a call whose argument could not be inferred and fell back, so a downstream member access is unchecked rather than wrong |

## Promises and async (15-32)

| # | Issue | Check For |
| --- | ------- | --------- |
| 15 | **Floating promise** | Don't flag a promise deliberately detached with a handler attached or an explicit `void`; flag an async call whose result is neither awaited, returned nor handled - the rejection becomes an unhandled rejection, and Node has exited on one by default since v15 |
| 16 | **Missing `await` on a returned promise** | Don't flag `return somePromise()` in a plain function; flag it inside a `try` block, where the rejection escapes the `catch` because the frame is gone before it settles |
| 17 | **Async function in a void-return slot** | Don't flag an async callback the API awaits; flag one passed to `forEach`, an event listener, a timer or any callback typed to return nothing - nothing waits for it and nothing catches it |
| 18 | **Promise in a condition** | Don't flag an awaited value in a condition; flag a bare promise in an `if`, a `while` or a ternary - a promise is always truthy, so the branch is a constant |
| 19 | **`await` on a non-thenable** | Don't flag `await` on a value that may be a promise; flag it on a value that never is, which usually means the author believed a synchronous call was async |
| 20 | **`Promise.all` where one rejection loses the rest** | Don't flag it on operations that should fail together; flag it where the caller needs every result's outcome → `allSettled` reports each, `all` reports the first rejection and abandons the others |
| 21 | **Sequential `await` in a loop** | Don't flag a loop whose iterations depend on each other, or one bounded on purpose; flag independent work awaited one at a time in a hot or user-facing path |
| 22 | **Unbounded concurrency** | Don't flag a small fixed fan-out; flag a fan-out over a list whose length is caller-controlled - it opens that many sockets, file handles or queries at once |
| 23 | **Async executor in a promise constructor** | Don't flag a synchronous executor; flag an `async` one, where a throw before the reject callback is swallowed and the promise never settles |
| 24 | **Race between a check and a use** | Don't flag a check and use with no suspension between them; flag an `await` separating a guard from the action it guards, where a second entry can invalidate the guard in between |
| 25 | **Shared mutable state read across an `await`** | Don't flag a local; flag module-level or instance state read before an `await` and written after, where two overlapping calls interleave |
| 26 | **Missing cancellation** | Don't flag a short call; flag a long-running or user-cancellable request with no abort signal, timeout or disposal, where a superseded response can still land and overwrite a newer one |
| 27 | **A `catch` that cannot see the failure it names** | Don't flag defensive handling; flag a `try` whose throwing call is not awaited inside the block, so the `catch` never runs |
| 28 | **Rejection swallowed** | Don't flag a `catch` that logs, wraps and rethrows, or genuinely handles; flag an empty one, or one returning a default that hides a failure the caller must know about |
| 29 | **`finally` that returns or throws** | Don't flag cleanup in `finally`; flag a `return` or a `throw` there - it discards the pending value or the in-flight error |
| 30 | **Timer not cleared** | Don't flag a one-shot timer; flag a repeating one, a retained handle or a subscription with no clear on the error path or on teardown |
| 31 | **Listener not removed** | Don't flag a listener on an object that dies with the handler; flag one added to a long-lived emitter, socket or global with no removal - the max-listeners warning is the symptom, a leak is the cause |
| 32 | **Async work started in a constructor** | Don't flag a synchronous constructor; flag one starting async work, since the object is usable before the work settles and the failure has nowhere to go |

## Runtime semantics (33-48)

| # | Issue | Check For |
| --- | ------- | --------- |
| 33 | **Loose equality that coerces** | Don't flag a loose comparison against `null`, which is the idiomatic null-or-undefined check; flag any other loose equality across types |
| 34 | **Falsy check standing in for absence** | Don't flag a truthiness check on a value that is only ever an object; flag one where zero, an empty string, `NaN` or `false` are legal values → compare against `null` or use nullish coalescing |
| 35 | **Truthiness default where a nullish one was meant** | Don't flag a logical-OR default for a genuine truthiness case; flag one defaulting a number, a boolean or a string where zero, `false` or an empty string must survive → nullish coalescing keeps them |
| 36 | **Optional chaining that hides the wrong absence** | Don't flag it on a genuinely optional path; flag a chain that turns a real missing dependency into a silent `undefined` the caller then uses |
| 37 | **Enumerating an array by key** | Don't flag `for…of` or an index loop; flag `for…in` over an array, which yields string keys and walks inherited enumerable properties |
| 38 | **Object used as a lookup table without a null prototype** | Don't flag a `Map`, or a literal whose keys are fixed in the source; flag a plain object indexed by caller-supplied keys - `__proto__`, `constructor` and `toString` all answer |
| 39 | **Prototype pollution through a merge** | Don't flag a shallow assign of known keys; flag a recursive merge, or an assignment down a parsed key path, that does not reject `__proto__`, `constructor` and `prototype` |
| 40 | **`this` lost** | Don't flag an arrow function or a bound method; flag a method passed as a callback where its body uses `this` |
| 41 | **Mutation of a caller's argument** | Don't flag a documented in-place operation; flag an object or array argument mutated where the caller keeps using it - `sort`, `reverse`, `splice`, `push` and an assign onto a caller's target all mutate |
| 42 | **Shallow copy read as deep** | Don't flag a shallow copy of a flat structure; flag a spread used to isolate nested state that is then mutated through the copy |
| 43 | **Sort without a comparator** | Don't flag a string sort; flag a numeric one with no comparator - the default compares stringified values, so `10` sorts before `9` |
| 44 | **Number precision** | Don't flag ordinary arithmetic; flag money or identifiers held as a number, an exact comparison on computed floats, or an integer beyond the safe-integer limit arriving from JSON |
| 45 | **Date handling** | Don't flag a library call; flag a date built from a non-ISO string, arithmetic across a daylight-saving boundary, or two dates compared by identity |
| 46 | **Regular expression built from input** | Don't flag a literal pattern; flag one built by concatenating unescaped input, and flag catastrophic backtracking - nested quantifiers over an overlapping class on caller-controlled text |
| 47 | **A stateful regular expression reused** | Don't flag a global pattern used once to collect matches; flag a global or sticky one reused across `test` calls, where `lastIndex` makes it match every other time |
| 48 | **A thrown value that is not an `Error`** | Don't flag a typed error class; flag a thrown string or object literal, which arrives with no stack, and flag a `catch` that reads a message off the binding without checking what it caught |

## Modules, dependencies and configuration (49-58)

| # | Issue | Check For |
| --- | ------- | --------- |
| 49 | **Module systems mixed** | Don't flag a consistent module system; flag a `require` of an ESM-only package, a default import of a CommonJS module whose named exports Node cannot detect, or `__dirname` used in an ES module |
| 50 | **Dual package hazard** | Don't flag a single-format package; flag a singleton, registry, cache or `instanceof` check against a package the tree loads through both `import` and `require` - those are two module instances with two states |
| 51 | **Import kept only for a side effect** | Don't flag one the package declares as side-effecting; flag an import relied on for registration where the package claims to be side-effect free, since a bundler may drop it |
| 52 | **Circular import** | Don't flag a cycle between type-only imports; flag a value cycle, where one side sees `undefined` at module evaluation time depending on entry order |
| 53 | **A dependency moved between the two dependency blocks** | Don't flag a genuine dev tool; flag a package imported by shipped code that the diff moves to the dev block, or the reverse |
| 54 | **A version range widened** | Don't flag a patch bump; flag a pin loosened to a caret or a wildcard, or a major bump landing with no other change, and say what breaks if the resolved version moves |
| 55 | **An entry point or engine floor changed** | Don't flag a documented change; flag an export map that stops resolving a path consumers import, or an engine floor raised past what CI runs |
| 56 | **A compiler option relaxed** | Don't flag a tightening; flag strict mode, implicit-any checking, null checking, checked index access or exact optional properties turned off, or a library-check skip added to make a build pass |
| 57 | **A lint rule turned off** | Don't flag a justified inline suppression carrying a reason; flag a rule disabled repository-wide, or a bare inline suppression with no reason, especially on the type-aware rules that catch items 15 to 19 |
| 58 | **A compiler error suppressed** | Don't flag an expect-error suppression the comment explains and a test covers; flag an ignore suppression, which stays silent once the underlying error goes away, and flag either with no explanation |

## Data at a boundary (59-66)

| # | Issue | Check For |
| --- | ------- | --------- |
| 59 | **An interface asserted over a response** | Don't flag a validated parse; flag a response typed by annotation alone - the type is erased and the server's actual shape is whatever it sent |
| 60 | **An environment variable used unvalidated** | Don't flag a checked read; flag one used directly as a number, a boolean or a required string - every value is a string or `undefined` |
| 61 | **A validator's output discarded** | Don't flag a parse whose result is used; flag a schema defined and then bypassed, or a non-throwing parse whose success flag is never read |
| 62 | **A partial validation read as total** | Don't flag a deliberate subset schema; flag one validating the fields the code reads today, where a later field is read without validation |
| 63 | **Serialization loses a type** | Don't flag a documented shape; flag a date, map, set, big integer or `undefined` round-tripped through JSON and read back as though it survived |
| 64 | **An untrusted value reaching a sink** | Don't flag a parameterised query or an escaped interpolation; flag caller-controlled input reaching SQL, a shell command, a file path, a redirect, a dynamic evaluation or an HTML sink |
| 65 | **A path built from input** | Don't flag a path from a fixed set; flag one joined from caller input with no normalisation and containment check - a parent reference escapes the directory |
| 66 | **A secret in the diff** | Don't flag a placeholder or a fixture; flag a credential, token, key or connection string in source, in a test, in a snapshot or in a committed environment file, and flag one logged or returned in an error body. This is the only secrets pass - the orchestrator reports what you find here rather than re-scanning the diff itself |

## Errors, logging and control flow (67-72)

| # | Issue | Check For |
| --- | ------- | --------- |
| 67 | **An error that loses its cause** | Don't flag a wrapped error carrying the original as its cause or in its message; flag a rethrow that replaces the original with a generic string |
| 68 | **A catch that narrows by message text** | Don't flag a check on a typed error or a code property; flag branching on message text, which changes with a dependency upgrade or a locale |
| 69 | **An exhaustive switch that is not** | Don't flag a switch with a default that throws or a never-check; flag one over a union with neither, where adding a member silently falls through |
| 70 | **A returned failure nobody reads** | Don't flag a thrown error; flag a function returning a status the callers in the diff ignore |
| 71 | **A log carrying a whole object** | Don't flag a scoped log; flag one that logs a request, a configuration or a user record whole, where a token or personal data rides along |
| 72 | **A process exit in library code** | Don't flag one in a command-line entry point; flag it anywhere a caller could have handled the failure - it skips every pending write and every `finally` |

## Tests (73-80)

| # | Issue | Check For |
| --- | ------- | --------- |
| 73 | **An async test that does not await** | Don't flag a test awaiting its subject; flag one whose assertion runs before the promise settles, which passes whatever the code does |
| 74 | **A rejection assertion that cannot fail** | Don't flag an assertion on the rejected promise itself; flag a `try`/`catch` with the assertion inside the `catch` and nothing failing the test when no throw happens |
| 75 | **A mock asserted instead of behaviour** | Don't flag a mock at a genuine boundary; flag a test whose only assertions are that a mock was called, so the code under test could return anything |
| 76 | **Over-mocking** | Don't flag mocking network, time or the filesystem; flag mocking the module under test, or so much of its collaborators that the test no longer exercises the change |
| 77 | **A test that shares state** | Don't flag a fixture rebuilt per test; flag module-level mutable state, an unreset mock, or a fake clock left installed - the symptom is order-dependent failure |
| 78 | **A sleep standing in for synchronisation** | Don't flag a deliberate timing test; flag a fixed delay used to wait for work → wait on the condition or the promise |
| 79 | **A snapshot asserting nothing** | Don't flag a small reviewed snapshot; flag a large one written from current output, which pins the bug as firmly as the behaviour |
| 80 | **A behaviour changed with no test touched** | Don't flag a refactor with unchanged behaviour; flag a diff that changes a branch, a boundary or an error path while every test file stays untouched, and name the case that would have caught it |

## Sources

- typescript-eslint type-checked rules: <https://typescript-eslint.io/rules/>
- Floating promises: <https://typescript-eslint.io/rules/no-floating-promises/>
- Misused promises: <https://typescript-eslint.io/rules/no-misused-promises/>
- Checked index access: <https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html>
- Exact optional property types: <https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html>
- The seven sources of unsoundness in TypeScript: <https://effectivetypescript.com/2021/05/06/unsoundness/>
- Node.js ECMAScript modules and CommonJS interop: <https://nodejs.org/api/esm.html>
