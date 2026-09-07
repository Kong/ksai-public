# TypeScript audit quirks

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command, compiler flag or lint rule named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Read by the `findings-auditor` agent as its `stack_quirks` field, and by nothing else. TypeScript has a large surface of code that looks unsafe and is not, and a larger one of code that looks safe and is not. Every item here is a reason to REMOVE or DOWNGRADE a finding that would otherwise read as sound.

## Scope

A finding about a framework belongs to that framework's reviewer. Where the diff routed Vue, Nuxt or NestJS files elsewhere, a TypeScript finding restating a framework convention is a duplicate — remove it rather than upholding it in two places.

A finding about a compiler option the repository already sets is noise. Before upholding anything in catalog items 1 to 14, check whether the diff or the tree carries a `tsconfig.json` whose `strict`, `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes` already blocks it on every commit.

## Evidence to check before upholding

A type finding must name what arrives at runtime, not what the annotation says. "This is typed `any`" is not a failure; "this reaches `user.id` and the endpoint returns `{ data: { id } }`, so it is `undefined`" is.

An async finding must name the interleaving or the rejection path. A floating promise whose call cannot reject is a style note, not a bug.

A wrong `file:line` includes the wrong half of a re-export: a barrel file that names the symbol against the file that defines it.

## Looks like a bug and is not

- **`as const`** is a narrowing, not an escape. It removes freedom rather than adding it, and it is the correct tool for a literal union. Catalog #1 says so directly.
- **A single assertion after a real check** is what narrowing looks like when the compiler cannot follow the proof. Read the preceding lines before upholding #1 or #3.
- **A non-null assertion on a value the code just created or just checked** is not #3. The item requires the absence to be *reachable*.
- **`any` in a `.d.ts` shim for an untyped dependency** is the documented way to describe an untyped module. #4 is about `any` on the repository's own signatures.
- **A loose comparison against `null`** is idiomatic and covers both `null` and `undefined`. Only other loose equality is #33.
- **A truthiness default on a value that is only ever an object or absent** is correct; #35 needs a number, a boolean or a string in the union.
- **`for…in` over a plain record** is fine. #37 is about arrays.
- **A promise deliberately detached with a handler attached, or with an explicit `void`** is the sanctioned form of #15, not an instance of it.
- **Sequential `await` in a loop whose iterations depend on each other** is required, not #21. So is a loop deliberately serialised to bound load — check for a comment or a concurrency limit before upholding.
- **`Promise.all` over operations that must fail together** is correct; #20 needs a caller that wants each outcome.
- **A spread used to copy a flat object** is not #42. The item needs nested state mutated through the copy.
- **A mock at a network, clock or filesystem boundary** is good testing, not #76.
- **A snapshot small enough to read in review** is not #79.

## Severity, right-sized

- A type escape with no reachable wrong value is Low, not High. The severity comes from what happens at runtime, never from the shape of the annotation.
- A floating promise in a request path where the rejection crashes the process is High. The same pattern in a script that ends immediately after is Low.
- A missing validation at a boundary is Medium unless the unvalidated value reaches a sink or a security decision, which makes it High or Critical.
- A dependency range widened is Low unless the finding names what breaks when the resolved version moves.
- Every item in the tests section is at most Medium on its own. A test that cannot fail is worth reporting; it is not a blocker unless it is the only cover for a change the diff makes.

## Catalog items whose own text already answers the finding

Most of this is spelled out in the catalog item the finding cites — re-read that item's own text before upholding:

- **#1**, **#3**, **#4** — each names the case that is *not* a finding in its own first clause.
- **#9** — the item exempts a repository that sets `noUncheckedIndexedAccess`.
- **#10** — the item is about code that *distinguishes* absent from undefined. Where nothing does, there is no finding.
- **#15** — a handler or an explicit `void` discharges it.
- **#21**, **#22** — both require the work to be independent and the path to matter.
- **#54** — the item requires the finding to say what breaks.
- **#57**, **#58** — a suppression carrying a reason is exempt by the item's own wording.
- **#80** — a refactor with unchanged behaviour is exempt.
