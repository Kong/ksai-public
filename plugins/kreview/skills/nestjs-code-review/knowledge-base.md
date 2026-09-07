# NestJS / TypeScript Mistakes - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: <https://docs.nestjs.com/>, <https://docs.nestjs.com/security/helmet>,
<https://typeorm.io/>, <https://github.com/typestack/class-validator>,
<https://jestjs.io/>, <https://docs.nestjs.com/fundamentals/testing>

Scope: NestJS 9-10 (Kong's deployed range) on the Express adapter, PostgreSQL + TypeORM
as the primary data layer, Jest + supertest for tests. Prisma/Mongoose items are marked
and apply only when `orm_detected` says so. Do not flag idioms based on NestJS 11-only
behavior (e.g. Express 5 routing semantics).

**How to use this catalog:** every item is a *candidate* failure, not an automatic
finding. Flag an item only when you can point to a concrete failure (wrong response,
cross-request leak, unrolled-back write, masked error, failing request sequence) or the
project's own config/conventions prove it. Idiomatic NestJS that works is not a finding.
The catalog favors items with a demonstrable cost — pure style/taste belongs to the
linter. When in doubt, require the concrete failure.

**Numbering is append-only.** Item numbers are cross-referenced by the reviewer/auditor
agents and `real-world-patterns.md`. New items are appended after the current max;
retired items leave their number as a permanent gap. Never renumber surviving items.

## Dependency Injection & Providers (1-12)

| # | Issue | Check For |
| --- | ------- | --------- |
| 1 | **Circular Dependency Without `forwardRef`** | Two providers/modules importing each other resolve to `undefined` at construction ("Nest can't resolve dependencies…" or a silently `undefined` service) → break the cycle, or use `forwardRef(() => X)` on BOTH sides. Prefer restructuring: a cycle usually means a third service wants extracting |
| 2 | **Request-Scoped Provider Bubbles Up** | Injecting a `Scope.REQUEST` provider makes every injector in the chain request-scoped too — controller included — so the whole subtree is re-instantiated per request. Flag when a hot-path singleton silently became request-scoped by injecting one scoped dependency; consider durable providers or passing data explicitly |
| 3 | **Singleton Injecting `REQUEST`** | A default-scoped provider injecting `@Inject(REQUEST)` gets one frozen request (or fails) — the provider must itself be request-scoped, or read per-request data from ALS/arguments instead |
| 4 | **Provider Not Registered / Wrong Token** | A class listed in `providers` of no imported module, or a custom token (`@Inject('FOO')`) that doesn't match the `provide:` value, fails at bootstrap — or worse, resolves a stale duplicate registered elsewhere |
| 5 | **`useFactory` Async Mistakes** | An async factory that isn't awaited by its consumer contract, or a factory missing `inject: [...]` for its parameters, yields `undefined` deps at runtime |
| 6 | **Constructor Doing Real Work** | I/O, subscriptions, or async calls in a provider constructor run at container build time, can't be awaited, and swallow rejections → move to `onModuleInit`/`onApplicationBootstrap` |
| 7 | **`ModuleRef.get` for Scoped Providers** | `moduleRef.get()` throws for request-scoped providers — use `moduleRef.resolve()` (and note each `resolve()` returns a distinct instance from its own context unless a shared `ContextIdFactory` id is passed) |
| 8 | **Injecting the Concrete Class Past an Interface Token** | Registering `{ provide: TOKEN, useClass: Impl }` but injecting `Impl` directly bypasses the abstraction and gets a *second* instance — state diverges between the two |
| 9 | **Property Injection / `@Optional` Masking** | `@Optional()` on a dependency that the code then dereferences unconditionally turns a clear bootstrap error into a runtime `undefined` crash |
| 10 | **Provider State Assumed Fresh** | Default scope is singleton: instance fields live for the process lifetime. Any per-call mutable field is shared across all requests (see #60 for the leak case, #90 for the growth case) |
| 11 | **Custom Provider `useValue` Shared Mutable Object** | A `useValue: {…}` object is one shared reference — handlers mutating it affect every consumer |
| 12 | **Lazy `ModuleRef`/`LazyModuleLoader` in Hot Paths** | Resolving providers dynamically per request adds container lookups and defeats static analysis — justify or hoist to construction time |

## Modules & Architecture (13-19)

| # | Issue | Check For |
| --- | ------- | --------- |
| 13 | **Provider Used but Not Exported** | Module A's provider injected in module B works only if A `exports` it and B `imports` A — a missing export fails at bootstrap; a copy-registration in B's `providers` "fixes" it with a second instance (state diverges) |
| 14 | **Duplicate Provider Registration** | The same class in two modules' `providers` arrays creates two instances — caches, connection pools, and event subscriptions silently split |
| 15 | **`@Global()` Abuse** | Marking feature modules global hides the dependency graph and enables import-order bugs; reserve it for genuine cross-cutting infrastructure (config, logging) |
| 16 | **Dynamic Module `forRoot`/`forRootAsync` Mistakes** | `forRoot` evaluated at import time can't read async config; `forRootAsync` factories missing `inject`/`imports` get `undefined`; registering `forRoot` twice creates two module instances with divergent config |
| 17 | **Feature Module Boundary Leak** | Reaching into another feature's internals (repositories, private services) instead of its exported surface couples modules and bypasses that feature's invariants |
| 18 | **Barrel-File Import Cycles** | `index.ts` barrels that re-export across feature boundaries create import cycles TypeScript won't flag but that surface as #1 at runtime |
| 19 | **Entity Not Registered With the ORM Module** | A new entity missing from `TypeOrmModule.forFeature([...])` (or the datasource `entities` list) fails only when the repository is first injected |

## Request Pipeline & Binding Order (20-26)

| # | Issue | Check For |
| --- | ------- | --------- |
| 20 | **Pipeline Order Misconception** | Order is: middleware → guards → interceptors (pre) → pipes → handler → interceptors (post) → exception filters. Code that assumes a pipe ran before a guard (e.g. guard reading a transformed DTO) reads raw input |
| 21 | **`useGlobal*` Loses DI** | `app.useGlobalPipes/Guards/Filters/Interceptors(new X(...))` instances get no dependency injection — a global that needs deps must be registered via `APP_PIPE`/`APP_GUARD`/`APP_FILTER`/`APP_INTERCEPTOR` providers |
| 22 | **Middleware Not Applied Where Assumed** | `configure(consumer)` route strings/wildcards that don't match the mounted prefix (global prefix, versioning) silently skip the middleware — verify the effective path |
| 23 | **Multiple Guards/Interceptors Order Assumptions** | Global bindings run before controller-level, which run before route-level; within a level, registration order applies. An authz guard depending on an authn guard's `request.user` must be ordered after it |
| 24 | **Bare `@Res()` Disables the Pipeline** | Injecting `@Res()` without `{ passthrough: true }` switches the handler to library-specific mode: interceptors' response mapping and serialization are skipped, and forgetting `res.send()` hangs the request |
| 25 | **Exception Filter Scope Confusion** | A `@Catch(SpecificError)` filter doesn't catch subclass-less plain throws; multiple matching filters — only the first (most specific binding, route → controller → global) runs. Verify the error type actually reaches the filter claimed |
| 26 | **Versioning/Prefix Drift** | Routes added without the app's `enableVersioning`/global-prefix conventions ship at an unversioned path — clients on the versioned path get 404s |

## Guards & Auth (27-33)

| # | Issue | Check For |
| --- | ------- | --------- |
| 27 | **Unguarded Route** | A new controller/route with no auth guard at any level (route, class, `APP_GUARD`) — verify ALL levels before flagging, then treat as Critical: the endpoint is publicly reachable |
| 28 | **`@Public()` Metadata Mistakes** | A public-route decorator whose guard doesn't check both handler AND class metadata (`getAllAndOverride`) either locks out intended-public routes or — worse — a class-level `@Public()` unintentionally opens every route in the controller |
| 29 | **Authn ≠ Authz** | A guard that only verifies the JWT but not the resource's owner/org lets any authenticated user read others' data — look for handlers loading by `:id` with no ownership/tenant check |
| 30 | **JWT Verification Gaps** | `ignoreExpiration: true`, missing audience/issuer validation, tokens verified with `decode()` instead of `verify()`, or secrets read from a default fallback value |
| 31 | **Guard Returning Instead of Throwing Context** | Returning `false` yields a bare 403 with no problem+json detail; throwing the proper `UnauthorizedException`/`ForbiddenException` keeps the error contract (401 vs 403 confusion is itself a finding) |
| 32 | **Sensitive Data on `request` Trusted Downstream** | Handlers trusting `request.user` fields that the guard never sets (or that body/query can spoof, e.g. reading org id from the DTO instead of the token) — an authz bypass by input |
| 33 | **Rate Limiting Absent on Auth/Costly Routes** | Login, token, export, and fan-out endpoints with no `@nestjs/throttler` (or upstream limit) — brute-force and cost amplification. Behind a proxy, the limiter needs a real client IP (trust proxy) or it throttles the LB |

## Pipes & Validation (34-41)

| # | Issue | Check For |
| --- | ------- | --------- |
| 34 | **`ValidationPipe` Without `whitelist`** | Without `whitelist: true` (and ideally `forbidNonWhitelisted: true`), unknown body fields pass through — mass assignment when the DTO is saved/spread into an entity (`isAdmin: true`). Verify the global pipe's actual options before flagging |
| 35 | **Nested DTO Not Validated** | A nested object property without `@ValidateNested()` + `@Type(() => Child)` is NOT validated — class-transformer leaves it a plain object and class-validator skips it silently |
| 36 | **Query/Param DTOs Skipped** | Validation applied only to bodies; `@Query()`/`@Param()` taken as raw strings — numeric params become `NaN`, enum filters go unchecked. Use DTOs/`ParseIntPipe` etc. on those too |
| 37 | **`enableImplicitConversion` Surprises** | With implicit conversion, `?flag=false` becomes the *string* `"false"` coerced to boolean `true`, and `?id=abc` becomes `NaN` passing `@IsNumber()==false` paths oddly → use explicit `@Transform`/`@Type` per field for booleans and numbers |
| 38 | **Validating Interfaces / Types Instead of Classes** | Interfaces are erased at runtime — a handler typed `@Body() body: SomeInterface` gets NO validation; only class DTOs with decorators validate |
| 39 | **Missing `@IsOptional` vs Missing Field Confusion** | A field without `@IsOptional()` rejects absent values in PATCH DTOs; conversely `@IsOptional()` on required create fields lets empty objects through — check create vs update DTO split (`PartialType`) |
| 40 | **Manual Validation Duplicating the Pipe** | Hand-rolled `if (!body.x) throw` alongside a ValidationPipe drifts from the DTO and produces a second error shape |
| 41 | **`ParseUUIDPipe`/Custom Pipe Errors Swallowed** | Custom pipes catching and returning `null` instead of throwing `BadRequestException` push invalid input downstream |

## Interceptors, Serialization & RxJS (42-47)

| # | Issue | Check For |
| --- | ------- | --------- |
| 42 | **Interceptor Not Returning the Stream** | `intercept()` must return `next.handle()` (or a piped version) — calling `next.handle()` without returning/subscribing means the handler never runs or the response never maps |
| 43 | **Side Effects Outside the Stream** | `next.handle()` is lazy — statements in `intercept()` sequenced after the call but before the observable is returned/subscribed still run *before* the handler — post-response work belongs in `tap()`/`finalize()` on the returned stream |
| 44 | **Sensitive Fields Not Excluded From Responses** | Returning entities directly leaks `password_hash`, tokens, internal flags. `ClassSerializerInterceptor` + `@Exclude()` only works on **class instances** — a repository returning plain objects (raw queries, `getRawMany`) skips serialization entirely. Map to a response DTO |
| 45 | **`@Exclude`/`@Expose` Strategy Confusion** | `excludeAll` strategy without `@Expose()` on wanted fields returns `{}`; groups/versions applied inconsistently between endpoints leak on one path what another hides |
| 46 | **RxJS Error Mapping Dropped** | A `catchError` that returns `of(fallback)` converts hard failures into 200s with stale/empty data; rethrow as the proper `HttpException` unless a fallback is the contract |
| 47 | **Timeout/Retry Interceptors Masking Writes** | Retrying non-idempotent handlers (POST) on timeout duplicates writes; `timeout()` without `catchError` yields an unmapped 500 |

## Exception Handling (48-53)

| # | Issue | Check For |
| --- | ------- | --------- |
| 48 | **Non-`HttpException` Throws Become Opaque 500s** | Plain `throw new Error(...)` in handlers returns a generic 500 with no problem+json detail; domain errors need mapping to typed exceptions (or a filter that maps them) |
| 49 | **Swallowed Rejections in Fire-and-Forget Paths** | `void doAsync()` / unawaited promises in handlers, cron jobs, and event listeners: the rejection escapes filters entirely — in Node it's an unhandledRejection (process-fatal by default). Every floating promise needs a `.catch` with logging |
| 50 | **Filter Losing Error Context** | A catch-all filter returning a fixed message drops the original error, stack, and field-level validation detail — log the cause, keep the problem+json fields |
| 51 | **`try/catch` Around `return promise` Without `await`** | `try { return service.do() } catch` never catches — the promise escapes the block. Must be `return await` for the catch/finally to apply |
| 52 | **HTTP Exceptions Thrown in Non-HTTP Contexts** | `HttpException` thrown in cron jobs, Kafka consumers, or microservice handlers has no filter to render it — it surfaces as an unhandled rejection; use domain errors + context-appropriate handling |
| 53 | **Errors Logged and Rethrown and Logged Again** | Double/triple logging the same failure at each layer buries the real signal; log where handled, propagate otherwise |

## Async Correctness (54-59)

| # | Issue | Check For |
| --- | ------- | --------- |
| 54 | **Floating Promise** | Any promise not awaited, returned, or `.catch`ed — lost errors, out-of-order writes, responses sent before work completes. Prime hunting grounds: event handlers, loops (`forEach(async …)` never awaits), lifecycle hooks |
| 55 | **`Promise.all` Failure Semantics** | One rejection rejects the whole batch while the other promises keep running (side effects continue, results lost); partial-failure flows need `allSettled` + per-item handling |
| 56 | **Sequential Awaits That Should Be Parallel / vice versa** | Independent I/O awaited serially multiplies latency; dependent writes fired in parallel race. Check which one the data flow actually requires |
| 57 | **Async Work in `forEach`/`map` Without `await Promise.all`** | `items.forEach(async …)` returns immediately — the handler responds before any iteration completes |
| 58 | **Unbounded Concurrency Fan-Out** | `Promise.all(ids.map(fetch))` over user-controlled arrays opens N parallel connections — cap with batching/limits on user-sized inputs |
| 59 | **Response Sent Before Side Effects Commit** | Returning success before the transaction/queue publish resolves reports success for work that may still fail |

## State & Concurrency (60-64)

| # | Issue | Check For |
| --- | ------- | --------- |
| 60 | **Per-Request State on a Singleton** | An instance field on a default-scoped provider written per request (current user, request id, accumulating array) is shared across ALL concurrent requests → cross-request data leak, the NestJS cardinal sin. See `real-world-patterns.md` for the hunting checklist |
| 61 | **Read-Modify-Write Race** | Check-then-act on shared state (in-memory or DB: SELECT then UPDATE without a transaction/lock/atomic operator) double-spends under concurrency — uniqueness and counters need DB-level enforcement |
| 62 | **In-Memory Cache Behind a Load Balancer** | A `Map`-based cache/session/dedup store is per-instance: N replicas give N divergent copies, and deploys wipe it. Needs Redis/DB or explicit single-instance justification, plus a size bound (see #90) |
| 63 | **Event Ordering Assumptions** | Handlers assuming event A's side effects are visible when event B fires (or that `EventEmitter2` handlers complete before the emitter continues — sync emit doesn't await async listeners) |
| 64 | **Module-Scope Mutable State** | `let`/mutable objects at file scope shared by every importer, surviving across requests and tests — same failure class as #60 with worse discoverability |

## Lifecycle & Shutdown (65-68)

| # | Issue | Check For |
| --- | ------- | --------- |
| 65 | **No Graceful Shutdown** | Without `app.enableShutdownHooks()`, `OnModuleDestroy`/`OnApplicationShutdown` never run on SIGTERM — in-flight requests drop and pools/consumers leak on every deploy |
| 66 | **Resources Opened but Never Closed** | Intervals, Kafka/Redis clients, watchers, DB pools created in `onModuleInit` (or constructors) with no matching cleanup in `onModuleDestroy` — leaks in tests (open handles) and rolling deploys |
| 67 | **Init-Order Assumptions** | `onModuleInit` runs per module in dependency order, but cross-module readiness (consumer starts before producer's topic exists) isn't guaranteed — sequence explicitly with `OnApplicationBootstrap` or readiness checks |
| 68 | **Async Lifecycle Hook Errors Swallowed** | A rejected `onModuleInit` aborts bootstrap with an opaque error — wrap with context; a `.catch(() => {})` there hides a service that never became ready |

## Database - TypeORM (69-80); Prisma/Mongoose items marked

| # | Issue | Check For |
| --- | ------- | --------- |
| 69 | **Multi-Write Without a Transaction** | Two+ dependent writes (entity + join rows, debit + credit) outside a transaction leave partial state on failure — wrap in `dataSource.transaction()` or the repo's transaction decorator |
| 70 | **Transaction Manager Not Propagated** | Inside `transaction(async (em) => …)`, queries via the injected repository (not `em`) run OUTSIDE the transaction — they commit even when it rolls back. Every query in the block must go through the transactional manager (see `real-world-patterns.md`) |
| 71 | **Caught Error Defeats Auto-Rollback** | `transaction(cb)` rolls back on throw — but a `try/catch` inside the callback that swallows the error lets the transaction COMMIT the partial state. Rethrow or explicitly rollback |
| 72 | **`QueryRunner` Not Released** | Manual `createQueryRunner()` without `finally { queryRunner.release() }` leaks a pool connection per call — the pool exhausts under load |
| 73 | **Raw Query String Interpolation** | `.query(\`… ${input}\`)` or query-builder `.where(\`col = '${x}'\`)` is SQL injection — use parameter placeholders/named parameters everywhere user input touches SQL. NOT ORM-scoped: applies equally to raw drivers (pg pool.query, knex raw) when no ORM is detected |
| 74 | **`undefined` in `where` Drops the Filter** | `findOne({ where: { id: maybeUndefined } })`: older TypeORM (and any version with `invalidWhereValuesBehavior.undefined: 'ignore'`) silently drops the condition — returning an arbitrary row; newer defaults throw at runtime instead. Either way the query is broken; combined with #29 the ignore case is a cross-tenant read. Guard inputs before querying — check the repo's TypeORM version/datasource options before sizing |
| 75 | **`save()` vs `update()` Semantics** | `save()` on a partial entity UPSERTs and only touches provided columns but runs cascades/listeners; `update()` skips hooks, validation, and cascades and won't error on zero matched rows — using either where the other's semantics are assumed corrupts data silently |
| 76 | **N+1 Relation Loading** | Loading a list then accessing lazy relations (or querying per item in a loop) issues N+1 queries — use `relations`, join in the query builder, or batch |
| 77 | **`synchronize: true` / Schema Drift in Prod Paths** | Auto-sync in anything but a throwaway dev DB can drop/alter columns on boot; entity changes need generated, reviewed migrations |
| 78 | **Cascade Options Misused** | `cascade: true`/`onDelete: 'CASCADE'` added for convenience deletes/persists related rows the caller never intended — verify the delete path with real parent/child data |
| 79 | **Pagination Missing on Unbounded Queries** | `find()` on a growing table with no `take`/pagination serializes the whole table into one response — memory and latency blow up with data growth |
| 80 | **(Prisma) `$transaction` Misuse** | The array form `$transaction([a, b])` can't express reads that feed later writes (no interactive context); the callback form must use the provided `tx` client for every query — mixing in the global `prisma` client escapes the transaction (same failure as #70) |

## Configuration (81-83)

| # | Issue | Check For |
| --- | ------- | --------- |
| 81 | **No Schema Validation on Config** | `ConfigModule` without a validation schema (Joi/zod) lets a typo'd or missing env var surface as `undefined` deep in a request path instead of failing bootstrap |
| 82 | **`process.env` Read at Import Time** | Module-scope env reads run before `ConfigModule` loads `.env` files and bypass validation/typing — inject `ConfigService` (or the typed config object) instead |
| 83 | **Secrets Hardcoded or Defaulted** | Credentials/keys in code, or `configService.get('SECRET') ?? 'dev-secret'` fallbacks that ship a known secret to prod. Also flag secrets committed in the diff itself |

## Security (84-89)

| # | Issue | Check For |
| --- | ------- | --------- |
| 84 | **CORS Misconfiguration** | `origin: true`/`'*'` with `credentials: true` lets any site make authenticated calls; origin regexes that match substrings (`example.com.evil.io`) — validate against an allowlist |
| 85 | **Missing Helmet / Security Headers** | New HTTP surface without helmet (or equivalent headers at the edge) — confirm it's absent at both app and infra level before flagging |
| 86 | **SSRF via User-Controlled URLs** | Outbound requests built from user input (webhooks, imports, avatar URLs) without allowlist/protocol/IP-range validation can reach internal metadata endpoints and services |
| 87 | **PII/Secrets in Logs** | Logging full request bodies, headers (Authorization, cookies), tokens, or user PII — especially in error paths that dump the whole context object |
| 88 | **Sensitive Data in Error Responses** | Stack traces, SQL fragments, or internal identifiers returned to clients in error bodies — map internal errors before they cross the boundary |
| 89 | **File Upload Hazards** | Multer/file endpoints without size limits, MIME/extension validation, or storage-path sanitization — disk exhaustion and path traversal |

## Performance & Memory (90-93)

| # | Issue | Check For |
| --- | ------- | --------- |
| 90 | **Unbounded In-Memory Growth** | Caches/maps/arrays on singletons with no eviction (TTL/LRU/max size) grow for the process lifetime — a slow OOM under production traffic |
| 91 | **Event Listener / Interval Leaks** | `on()`/`setInterval` registered per request or per retry without removal accumulates listeners (MaxListenersExceededWarning) and duplicate work |
| 92 | **Buffering Instead of Streaming** | Reading whole files/exports/uploads into memory (`readFile`, accumulating rows into an array) where a stream/cursor exists — memory scales with payload size |
| 93 | **Hot-Path Work Per Request That Belongs at Startup** | Re-compiling schemas/regexes/clients per request (or via request-scoped providers, see #2) — hoist to construction time |

## Scheduling, Queues & Events (94-98)

| # | Issue | Check For |
| --- | ------- | --------- |
| 94 | **Overlapping `@Cron` Runs** | `@nestjs/schedule` does NOT prevent overlap: a job slower than its interval piles up concurrent runs — guard with a running flag/lock, and with a distributed lock when replicas > 1 (every replica fires the cron) |
| 95 | **Cron/Consumer Errors Unhandled** | A thrown error in a cron tick or consumer callback has no exception filter — one bad tick can kill the schedule or crash the process; wrap the body, log, and emit the failure metric |
| 96 | **Message Ack Semantics Wrong** | Acking before processing loses messages on crash; never acking (or auto-ack with async work) re-delivers forever — verify ack placement against the at-least/at-most-once intent, and make handlers idempotent under redelivery |
| 97 | **`@OnEvent` Async Errors Escape** | `EventEmitter2` doesn't await async listeners by default — a rejected async handler is an unhandled rejection, and `emit` returning doesn't mean the work happened. Handlers need their own try/catch; use `emitAsync`/`suppressErrors` deliberately |
| 98 | **Job Payloads Carrying Live Objects** | Queue payloads must be serializable — entities with circular refs/methods silently lose data through JSON round-trips; pass ids and reload |

## Testing (99-108)

| # | Issue | Check For |
| --- | ------- | --------- |
| 99 | **Over-Mocked Unit Tests** | Mocking every collaborator and asserting mock calls tests the mocks, not the logic — the test passes while the real wiring is broken. Mock at the boundary (repo/HTTP), assert on behavior/output |
| 100 | **Happy-Path-Only Coverage** | No tests for validation failures, authz denials (401 AND 403), not-found, conflict, or error mapping — the negative paths are where handlers actually break |
| 101 | **Assertions That Can't Fail** | `expect(result).toBeDefined()` after a call that always returns an object; asserting status but never the body/side effect; `expect` inside a `catch` that never runs (use `rejects.toThrow`) |
| 102 | **Async Test Escapes** | Unawaited supertest/async calls pass before the work runs; a missing `await` on `expect(...).rejects` always passes |
| 103 | **`app.close()` Missing** | e2e suites not closing the Nest app (and DB connections) in `afterAll` leak open handles — Jest hangs or `--forceExit` hides real leaks |
| 104 | **e2e App Missing Production Pipeline** | `Test.createTestingModule` does NOT apply `main.ts` bootstrap config — e2e apps must re-apply the global pipes/filters/interceptors/prefix, or they validate/serialize differently than prod (tests pass, prod 400s — or vice versa) |
| 105 | **Mocking the Layer Under Test** | Stubbing the repository method whose query logic the test claims to cover, or `overrideProvider` on the service being tested — nothing real is exercised |
| 106 | **Guard/Pipe Overrides Hiding Auth Coverage** | `overrideGuard(...).useValue({ canActivate: () => true })` in EVERY e2e means no test proves authz — at least one path must run the real guard against 401/403 cases |
| 107 | **Shared Mutable Fixtures / Test Interdependence** | Suites reusing one DB row/fixture that earlier tests mutate pass alone and fail in order-shuffled runs — isolate per test or reset state |
| 108 | **Jest Mock Hygiene** | Mocks not reset between tests (`clearMocks`/`resetAllMocks`) leak call counts; `jest.mock` factory referencing out-of-scope variables fails hoisting; module-level mock state shared across files |

## TypeScript (109-113)

| # | Issue | Check For |
| --- | ------- | --------- |
| 109 | **`any` Erasing the Contract** | `any` on DTOs, service boundaries, or caught errors turns compile-time breaks into runtime 500s — use `unknown` + narrowing for errors, typed DTOs at boundaries |
| 110 | **Non-Null Assertions on Nullable Paths** | `x!.y` on values that ARE null on a real path (optional relations, `findOne` results) converts a typed check into a crash |
| 111 | **YOLO Casts** | `as unknown as T` / double-casts to silence the checker hide real shape mismatches — the cast site is where the runtime error will point |
| 112 | **Entity/DTO/Domain Conflation** | Using the ORM entity as the request DTO (validation gaps + mass assignment, see #34) or as the response type (leaks, see #44) — the three shapes change for different reasons |
| 113 | **Enum/Union Drift Between Layers** | String unions in TS not enforced at runtime (DB check constraints, validation decorators) let invalid values in via raw queries and old rows |

## Dependency & Config Hygiene (114-116) - when `package.json`/config changed

| # | Issue | Check For |
| --- | ------- | --------- |
| 114 | **`@nestjs/*` Version Skew** | Mixing `@nestjs/*` majors (or a transitive `rxjs` mismatch) produces subtle DI/runtime failures — the versions move together |
| 115 | **Heavy/Duplicate Dependency** | A new dependency duplicating platform or existing-dep functionality (or a full lodash for one function) — name the existing alternative |
| 116 | **Loose Ranges / New `postinstall`** | `*`/`latest` ranges, or a new dependency carrying a `postinstall` script (supply-chain surface) — pin and justify |

## Maintainability & Complexity (117-121)

Flag these only with a concrete named signal (line/branch/param/duplication count, or a
demonstrated bug it caused). Default Low; escalate to Medium only when it demonstrably
causes bugs or blocks change. No signal named → not a finding.

| # | Issue | Check For |
| --- | ------- | --------- |
| 117 | **Fat Controller** | Business logic, queries, or multi-step orchestration inline in route handlers — belongs in services (signal: handler > ~30 lines or touching the DB directly) |
| 118 | **God Service** | One service owning unrelated concerns (signal: many unrelated public methods / injected deps in double digits) — split by responsibility |
| 119 | **Copy-Paste Divergence** | The same logic duplicated where one copy already drifted (name both sites) — extract to the owning service/util |
| 120 | **Dead Code / Speculative Flexibility** | Unused providers, endpoints, config flags nobody sets, abstractions with one implementation (`delete`/`yagni` tags) |
| 121 | **Missing "Why" on Non-Obvious Logic** | Workarounds, ordering constraints, or magic values with no comment explaining the constraint — the next editor breaks it |

## Common Patterns

Cross-cutting failure clusters worth checking as a unit:

- **The cross-request leak cluster**: #2, #3, #10, #60, #62, #64 — anything per-request
  stored anywhere that outlives the request.
- **The transaction integrity cluster**: #69, #70, #71, #72, #75, #80 — writes that
  don't commit/rollback together.
- **The validation bypass cluster**: #34, #35, #36, #38, #112 — input that reaches
  business logic unvalidated.
- **The invisible error cluster**: #49, #51, #52, #54, #95, #97 — rejections with no
  handler, filter, or log.
- **The tests-that-lie cluster**: #99, #101, #104, #105, #106 — green suites that prove
  nothing about production behavior.
