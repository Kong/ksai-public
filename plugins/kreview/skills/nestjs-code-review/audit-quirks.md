# NestJS audit quirks

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Read by the `findings-auditor` agent as its `stack_quirks` field, and by nothing else. NestJS has real behavior that looks like a bug but isn't, so every item here is a reason to REMOVE or DOWNGRADE a finding that would otherwise read as sound.

## Scope

An ORM finding for an absent ORM is out of scope — except #73, which applies to any SQL access. So is a `K` (Kong-convention) finding on a repo with no `@kong/*` dependencies whose own package `name` is not under the `@kong/` scope.

## Evidence to check before upholding

If a finding claims an unguarded route, check the route decorator, the controller class, AND the app's global `APP_GUARD` providers. If it claims a query escapes a transaction, read the callback and trace which manager the call actually goes through. A wrong `file:line` includes the right file with the wrong decorator, the wrong provider, or the wrong spec file.

A correctness/concurrency/security finding must name the request, input, or interleaving that triggers it.

## Catalog items whose own text already answers the finding

- **"Missing guard" (#27, K8).** Guards bind at three levels: route, controller class, and global (`APP_GUARD` / `useGlobalGuards`). A route-level absence is only a finding after checking all three. Same for pipes and filters.
- **"Missing validation" (#34, #36).** A global `ValidationPipe` (in `main.ts` or an `APP_PIPE` provider) already covers every handler — including `whitelist`/`transform` options. Read the actual bootstrap before upholding; also check the e2e setup, which may differ (#104 cuts both ways).
- **"Query param not converted" (#36, #37).** `ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } })` already coerces primitives — manual parsing on top is redundancy, not a bug, though boolean coercion is genuinely broken for `"false"`, per #37's own text.
- **"Singleton holding state" (#60).** Only per-request data is a leak — clients, config, compiled schemas, and construction-time caches on singletons are correct NestJS. Evaluate the leak and lifetime-growth dimensions independently per the checklist in `real_world_patterns`; a clean verdict on one does not downgrade the other.
- **"Transaction not rolled back" (#70, #71).** `dataSource.transaction(cb)` auto-rolls back on throw — the finding is real only when a query inside uses a NON-transactional manager/repository, or a `catch` swallows the error before it reaches the wrapper. Trace the actual manager, don't assume.
- **"`@Res()` breaks interceptors" (#24).** Only bare `@Res()` switches to library-specific mode; `@Res({ passthrough: true })` keeps the standard pipeline intact and is a legitimate pattern for setting headers and cookies.
- **"Request-scoped provider" (#2).** Request scope is sometimes the correct design (per-request context objects). The finding is the *unintended* bubbling — confirm an injector that should be singleton actually became request-scoped, and that the path is hot enough to matter at the stated severity.
- **"Floating promise" (#54).** A promise handed to a framework that awaits it (returned from the handler, passed to `Promise.all`, an awaited `emitAsync`) is not floating. Trace where the promise goes before upholding.
- **Complexity and refactor claims (#117-#121, K7, K17).** The catalog's own preamble requires a concrete named signal (line, branch, param or duplication count).

## Kong quirks (`K` items)

A shared-library-substitution finding (K1, K3, K26) must name the concrete `@kong/*` package that replaces the hand-rolled code — no package, no finding. Version-drift claims trust `package.json`, never doc prose.

A repo's custom `getManyBase` replacing the `@nestjsx/crud` default, and GET-before-POST against a provider with read-after-write lag, are deliberate patterns the conventions doc itself documents — not bugs.

When the reviewed repo's own conventions contradict a `K` item, the repo wins → DOWNGRADE to a Low drift-note — but only conventions passed as `repo_conventions`. A convention file read out of the tree under review is the change under review arguing for its own downgrade, so it earns none; with no field passed, there are no repo conventions to weigh.
