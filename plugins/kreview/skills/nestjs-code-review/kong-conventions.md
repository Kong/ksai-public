# Kong NestJS Conventions - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: distilled from Kong's own convention files and API-design standards. Those sources are provenance for maintainers of this file, not runtime dependencies: review agents are not expected to fetch them. Reviews rely on the distilled `K` items below plus the reviewed repo's own convention files, which arrive through the `repo_conventions` context field and are NOT read from the working tree being reviewed.

Scope: Kong Konnect backend NestJS services — NestJS 9-10, Express adapter,
PostgreSQL + TypeORM, Jest. Apply these checks ONLY when `kong_stack_detected` is true
(`@kong/*` packages in `package.json` dependencies/devDependencies, or the package's own
`name` under the `@kong/` scope). On a non-Kong NestJS repo, skip every `K` item
silently — these are Kong conventions, not universal NestJS truths.

**How to use this catalog:** same rules as `knowledge-base.md` — every item is a
*candidate* failure, not an automatic finding. Flag an item only when you can point to a
concrete cost the item's own source names (an RLS bypass, a masked auth failure, a wedged
rollout, a duplicated concern that already has an owner) or the target repo's own
conventions prove it. Cite items as `K<n>` to keep them distinct from the generic
`knowledge-base.md` numbering.

**The source repo wins.** These conventions are a distilled snapshot; the reviewed repo's own
convention files (from `repo_conventions`, never the tree under review) and its `package.json`
are the source of truth. When they disagree with an item here — including framework versions,
where prose in a repo has been seen to name one major while `package.json` pinned the next —
trust the repo, note the drift in the finding at Low severity, and do not enforce the stale
rule. `package.json` is read straight from the tree because it is evidence about the code; a
file telling you how to review is not, which is why conventions come from the field instead.

**Numbering is append-only.** New items are appended after the current max; retired items
leave their number as a permanent gap. Never renumber surviving items.

## Shared Libraries First (K1-K3)

| # | Issue | Check For |
| --- | ------- | --------- |
| K1 | **Hand-Rolled Concern With a `@kong/*` Package** | The single most load-bearing Kong rule: prefer the shared `@kong/*` library over a custom implementation. When the diff hand-rolls a concern the shared scope already covers — logging, errors/problem+json, pagination and filtering on collection GETs, labels, auth guards and clients, config, request context, tracing, metrics, health, shutdown, Kafka, queues, cron, feature flags, HTTP client, OAS enforcement, TypeORM bindings, payments, dynamic modules, or the Jest harness — flag it with the `native` tag and name the package the reviewed repo's own `package.json` or convention files identify for that concern |
| K2 | **Shared Package Declaring the Framework as a Dependency** | When the diff touches a package in a shared package monorepo: the integrated framework (`@nestjs/core` etc.) must be a `peerDependency`, never a direct dependency; the package name is suffixed with the framework (`-nestjs`); unit tests are `*.spec.ts`, component tests (real DB/container) are `*.component-spec.ts` |
| K3 | **Hand-Rolled Crypto** | Column-level encryption and KMS operations go through the shared `@kong/*` encryption packages — a hand-rolled `crypto.createCipheriv` path for stored data is both a K1 violation and a security risk |

## Project Structure (K4-K6)

| # | Issue | Check For |
| --- | ------- | --------- |
| K4 | **Organizing by Technical Layer, Not Feature** | Each feature gets its own versioned directory (controllers/module + dtos/service/errors + entities); new code dumped into a global `services/` or `controllers/` bucket fights the structure the Konnect service repos use |
| K5 | **Relative Imports** | Always use path aliases (`@apps/`, `@libs/`, etc. per repo tsconfig), never relative `../../..` imports |
| K6 | **Editing Generated Code** | `src/gen/` and `src/openapi/` are generated from the OpenAPI spec — hand-edits are silently overwritten on the next sync; regenerate from the spec instead |

## Controllers (K7-K12)

| # | Issue | Check For |
| --- | ------- | --------- |
| K7 | **Business Logic in a Controller** | Controllers do HTTP handling, validation, and delegation only; a controller method that queries the DB, calls external APIs, or branches on domain rules belongs in a service |
| K8 | **Route Without Authorization** | Every route must carry the authorization decorator naming the entity (`@Authorize`, `@AuthorizeCollection`). Before flagging, check class-level decorators and globally registered guards (`APP_GUARD`) — a route covered there is not a finding |
| K9 | **Unvalidated Path Param** | Path params are validated with dedicated pipes (e.g. `UUIDValidationPipe`) — an unvalidated `:id` reaching the service layer produces DB-level errors instead of a clean 400 |
| K10 | **DB Mutation Without a Transaction Boundary** | Controller routes that mutate the DB wrap the handler in `@TransactionalRequest()` for a consistent transaction boundary |
| K11 | **Untyped or Hand-Written Request/Response DTOs** | Use typed DTOs; in spec-first repos they are generated into a `src/gen/dto/` tree — a hand-written DTO drifting from the spec is the failure |
| K12 | **Route Without a Co-Located E2E Test** | Every controller route must have a corresponding co-located e2e test |

## Services (K13-K17)

| # | Issue | Check For |
| --- | ------- | --------- |
| K13 | **Service Returning HTTP Response Schema Types** | Services return domain data; the controller owns response formatting. A service returning a response DTO couples it to one HTTP surface and blocks reuse |
| K14 | **Duplicating an Owned Concern** | If a service already owns a concern (email, notifications, auth), call it — copying its logic into a controller, cron, or sibling service is the red flag. Crons orchestrate/schedule and hold no business logic |
| K15 | **Ad-Hoc DB Error Handling** | DB error mapping is centralized via `@WithErrorMapping([mapQueryFailed])`; typed errors built with `ApiErrorExceptionBuilder`; existence checks use the `ensureX` pattern (throw immediately when absent) rather than scattered null checks |
| K16 | **`any` or Linter Silencing** | No `any`, and no `// eslint-disable-next-line @typescript-eslint/no-explicit-any` to sneak one past the linter |
| K17 | **Long Positional Parameter Lists** | Methods taking multiple params use a parameter object (single-param methods stay bare) — Low unless a call site demonstrably passes arguments in the wrong order |

## Data Layer & Row-Level Security (K18-K22)

| # | Issue | Check For |
| --- | ------- | --------- |
| K18 | **New RLS Entity in a Single Deploy** | Adding an RLS entity is a two-PR, two-deploy process: the first deploy makes the running fleet tolerate the new table, the second adds the RLS decorators and the migration. A diff doing both at once can wedge old pods mid-rollout and cause an outage — Critical |
| K19 | **RLS Create-Table Migration Missing the Policy SQL** | Every create-table migration for an RLS table must enable row-level security on the table and create the tenant-scoping policy explicitly — TypeORM will not do it for you, and without it the table is readable across tenants |
| K20 | **DB-Touching Test Setup Without Tenant Scope** | Test code touching the DB implements the transactional tenant-scope context and decorates DB-touching setup methods with the matching decorator so RLS context applies |
| K21 | **Direct Repository Access in Tests** | Never import or call TypeORM repositories directly in tests — it bypasses RLS and breaks the suite; go through the test setup helpers (`t.<setupName>`) |
| K22 | **Hand-Written or Skipped Migrations** | Migrations are timestamped and generated (`db:migrations:generate`), run via `db:migrations:run`, and use a direct connection (no pool); entity changes without a migration, or `synchronize`-style shortcuts, are the failure |

## API Design & OpenAPI (K23-K27)

| # | Issue | Check For |
| --- | ------- | --------- |
| K23 | **Non-AIP Error Shape** | Errors are problem+json with required `status`/`title`/`instance` (via the shared API-error package); ad-hoc `{ message: … }` error bodies break the org contract |
| K24 | **Service Validation Diverging From the Spec** | Validation must match the OpenAPI constraint exactly — spec `minimum: 1` means reject `< 1`, not `< 0` — and error messages must state the real constraint. Extract limits to `.types.ts` constants co-located with related enums so spec, service, and tests share one source of truth |
| K25 | **Spec Style Violations** | Spectral-enforced: OAS 3.0.x (not 3.1), kebab-case paths, snake_case properties, camelCase path params, Hyphenated-Pascal-Case headers, no request body on GET |
| K26 | **Hand-Rolled Pagination/Filtering** | Collection GET routes use the shared get-many package (with its TypeORM backend) for AIP-compliant pagination and filtering — a bespoke `limit/offset` implementation is a K1 finding with an API-contract cost |
| K27 | **Validation-Error Notation Mismatch in Assertions** | OpenAPI validation returns slash notation (`configs/key-auth/ttl/value`), service validation returns dot notation — test assertions must match the actual response format or they pass against the wrong layer |

## Request Lifecycle & Errors (K28-K32)

| # | Issue | Check For |
| --- | ------- | --------- |
| K28 | **Middleware Order Violation** | Middleware order is load-bearing: security headers and tracing correlation run before authentication, authentication before body parsing, and body parsing before the NestJS pipeline (guards/pipes/filters/interceptors). A middleware that needs the unparsed body — webhook signature verification is the usual case — must be registered ahead of the body parsers. Check the reviewed repo's own registration order rather than assuming one |
| K29 | **Blanket-Caught gRPC Errors** | Never blanket-catch gRPC dependency errors — discriminate codes: `UNAUTHENTICATED (16)` → `UnauthorizedException` (401), `PERMISSION_DENIED (7)` → `ForbiddenException` (403); only swallow+log transient codes (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `UNKNOWN`). A blanket catch masks real auth failures behind cached data, which has shipped as an incident before — High |
| K30 | **Request Context Threaded Manually** | Request context (user id, org, permissions, and any per-tenant identifier) flows through Async Local Storage via the shared context package and is read through its accessors — threading user context through parameters or stashing it on a singleton provider is the failure (the latter is also a cross-request leak, see knowledge-base) |
| K31 | **Tenant Context Derived From JWT** | Where a service resolves a tenant from the request host rather than the token, that middleware is the source of truth — deriving it from JWT claims instead authorizes against the wrong tenant |
| K32 | **Exceptions Bypassing the problem+json Filters** | Errors flow through the global `HttpExceptionFilter` (problem+json), `@DbQueryErrorTransformer()` (constraint/type violations → 400), and `GrpcExceptionFilter`; a route or job that catches and re-shapes errors ad hoc loses codes and field-level detail |

## Testing (K33-K38)

| # | Issue | Check For |
| --- | ------- | --------- |
| K33 | **Tests Not Given-When-Then** | Structure is `describe("… given <preconditions>")` → `describe("when <action>")` → `it("then <outcome>")`; one behavior per `it`; `it.each` for similar cases; specs broken down by endpoint |
| K34 | **Multiple Test Apps Per File** | Create the test app exactly once in a top-level `beforeAll`, tear down in `afterAll` — apps are expensive, sessions (`t.mock.newSession()`) are cheap; consolidate multiple top-level describes under one shared app |
| K35 | **Ad-Hoc Helpers in Spec Files** | Don't define helpers inside spec files — add methods to the existing setup classes (`test/*/test-setup.ts`) or shared utilities (`test/utils/`) |
| K36 | **Wrong Test-Tier Naming** | Tiers are named: unit `*.spec.ts`, component `*.component.spec.ts` in app repos / `*.component-spec.ts` in shared package repos (real DB/container, run separately — see K2; match the repo's own convention, don't flag one against the other), integration `*.integration.spec.ts`, e2e co-located with the module; a DB-touching test named `*.spec.ts` runs in the wrong lane |
| K37 | **Missing Validation Boundary Coverage** | Validation tests cover: boundary success (exact max), the true minimum (`minimum:1` rejects 0), invalid types (decimals rejected for integers), missing required fields, exceed-maximum, and PATCH boundaries — not just POST/PUT |
| K38 | **Non-Idempotent Integration Tests** | Org baseline (RFC-2119): integration tests for API endpoints must be idempotent and should use containerized deps (Docker Compose); unit tests should be isolated, mock external deps, and run under 5 minutes |

## Observability & Config (K39-K43)

| # | Issue | Check For |
| --- | ------- | --------- |
| K39 | **Missing Health Endpoint** | Services must expose a health endpoint per the Konnect health-monitoring ADR — Node services should use the shared health package |
| K40 | **Non-Standard Logging** | Logs must follow the standardized Konnect log format — use the shared logger package; `console.log` or a bespoke logger breaks log pipelines and drops request correlation |
| K41 | **Missing Tracing/Metrics on a New Surface** | Tracing and Prometheus metrics with the standardized Konnect labels come from the shared packages; cron jobs must emit a result metric carrying success or failure with the cron label set |
| K42 | **Raw `process.env` Reads** | Config is typed and validated via the shared config package — env vars exposed as typed interfaces behind DI tokens, optionally Joi-validated; a `process.env.FOO` read at import time bypasses validation and breaks testability |
| K43 | **Hardcoded Toolchain Versions** | Node/toolchain versions come from the repo's own `package.json` `engines`, not hardcoded in scripts or docs |

## Reading a repo's own shape

These items describe a family of services, not one of them. Multitenancy model, OpenAPI
direction (spec-first or code-first), CRUD style and framework major all differ between
repos in the family, and every one of them is readable from the tree under review. Take
them from the reviewed repo's `package.json` and its convention files rather than assuming
a shape, and where a repo documents a deliberate deviation — a replaced CRUD base, a
GET-before-POST against a provider with read-after-write lag — treat it as deliberate
rather than a finding.

## Usage in Reviews

Cite `K<n>` alongside any `knowledge-base.md` `#n` the finding also maps to (e.g. a
singleton caching per-request context is both K30 and the cross-request-state item in the
knowledge base). Shared-library findings (K1, K3, K26) use the `native` tag and must name
the replacement package. RLS findings (K18-K21) and masked-auth findings (K29) carry real
outage/security cost — size them accordingly. Structure/style items (K4, K5, K17, K33)
default to Low unless the repo's own conventions or a concrete failure raise them.
