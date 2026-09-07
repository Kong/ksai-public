# Vue / Nuxt / TypeScript Mistakes - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: <https://vuejs.org/style-guide/>, <https://vuejs.org/guide/>,
<https://nuxt.com/docs>, <https://pinia.vuejs.org/>, <https://vueuse.org/>,
<https://vitest.dev/>, <https://testing-library.com/>, <https://playwright.dev/docs/best-practices>

Scope: Vue + `<script setup>` + Composition API, Nuxt 3/4. Options API / Vue 2 are covered
only by the short "Options API & Migration" section for mixed/legacy repos.

**How to use this catalog:** every item is a *candidate* failure, not an automatic finding. Flag
an item only when you can point to a concrete failure (wrong render, stale value, leak, broken
contract, failing interaction) or the project's own config/conventions prove it. Idiomatic Vue
that works is not a finding. Each **Check For** is written as a negative constraint — the
condition that must actually hold before you flag, not a bare "do X" directive — because a
suppression boundary keeps reviewer precision higher; most entries name the concrete failure
that has to be present. The catalog currently favors items with a concrete, demonstrable
cost — pure style/taste items were pruned in favor of a linter/formatter — but that's a bias, not
an absolute rule; a future item may lean more stylistic if it earns its place. When in doubt,
require the concrete failure.

**Numbering is append-only.** Item numbers are cross-referenced by the reviewer/auditor agents
and `real-world-patterns.md`. New items are appended after the current max; retired items leave
their number as a permanent gap (e.g. #2, #16, #20, #32, #38, #60, #85, #87 were removed as
pure-preference/linter-owned). Never renumber surviving items.

## Reactivity Fundamentals (1-15)

| # | Issue | Check For |
| --- | ------- | --------- |
| 1 | **`reactive()` Destructuring Loses Reactivity** | Destructuring a `reactive()` object snapshots values and breaks tracking → use `toRefs()`/`toRef()` or read `state.x`. NOTE: destructuring **props** at the `defineProps` call site IS reactive in Vue 3.5+ (Reactive Props Destructure, compiler-rewritten) — `const { size = 'sm' } = defineProps<…>()` is correct and the recommended way to set defaults; do not flag it |
| 3 | **`.value` Omitted/Misused in Script** | Refs need `.value` in `<script>` (templates auto-unwrap) → forgetting it compares/assigns the ref object itself; `if (count)` is always truthy |
| 4 | **`watch` vs `watchEffect`** | `watchEffect` runs immediately and auto-tracks every dep read (easy to over-track / re-run); `watch` is lazy, explicit, gives old+new value → use `watch` when you need the previous value or precise sources |
| 5 | **Watching a Non-Reactive Source** | `watch(props.id, ...)` passes a value, not a source → watch a getter `() => props.id` or a ref; otherwise the watcher never fires |
| 6 | **`watch` Flush Timing** | Default `flush: 'pre'` runs the callback *before* the DOM updates → a watcher that reads/writes the DOM (template-ref size, scroll, focus) needs `{ flush: 'post' }`/`watchPostEffect` or it sees stale DOM. `{ immediate: true }` fires before mount — guard DOM access on first run |
| 7 | **`computed` Side Effects / Mutation** | Don't flag a pure computed; flag a getter doing async, state mutation, or DOM work → it re-runs unpredictably; move effects to `watch` |
| 8 | **Writable `computed` Misuse** | Mutating a read-only computed throws; needing to write means a `get`/`set` computed or a plain `ref` |
| 9 | **Reactivity Lost Across `await`** | In plain Options API `async setup()` and in async callbacks (event handlers, watchers, `setTimeout`), `getCurrentInstance()` and the active effect scope are no longer set after the first `await` → register lifecycle hooks (`onMounted`) and scope-bound effects *before* the first `await` in those contexts. **Exception: `<script setup>`** — the compiler wraps every top-level `await` with `withAsyncContext()`, restoring context after each suspension; `onMounted()`/composables called after a top-level `await` in `<script setup>` (e.g. `await useFetch(...)` then `onMounted(...)`) are valid idiomatic patterns and must NOT be flagged |
| 10 | **`toRef`/`toRefs`/`toValue` Misuse** | Returning raw values from a composable breaks caller reactivity → return refs (or `toRefs(reactive(...))`); don't unwrap before returning. Same failure on the input side: a composable that accepts a ref-or-value argument and reads it once instead of via `toValue()` silently drops the caller's later updates |
| 11 | **`reactive` Reassignment** | `state = reactive({...})` or `state = newObj` drops the proxy → mutate properties, or use a `ref` and replace `.value` |
| 12 | **Ref Auto-Unwrap Surprises** | A ref assigned as a *property* of a reactive/ref object auto-unwraps; a ref that is an *element of a reactive array* or a *value in a reactive Map/Set* does NOT → access `.value`. Same for refs in plain arrays |
| 13 | **`nextTick` Before DOM Reads** | Reading the DOM right after mutating reactive state (measuring a just-rendered node, focusing a new input) sees the pre-update DOM → `await nextTick()` first |
| 14 | **`effectScope` for Standalone Reactivity** | Composables that create watchers/computeds outside a component scope (shared singletons, VueUse-style utils) leak without `effectScope()` + `onScopeDispose()` |
| 15 | **Defaults for Optional Props** | Set defaults via reactive props destructure in 3.5+ (`const { items = [] } = defineProps<…>()` — plain literals are fine, evaluated per instance) or `withDefaults`. The factory rule (`default: () => ({})`) applies only to object/array defaults in `withDefaults`/runtime props, where a bare literal is shared across instances |

## Composition API & `<script setup>` (16-28)

| # | Issue | Check For |
| --- | ------- | --------- |
| 17 | **Typed `defineProps`/`defineEmits`** | Prefer the type-only generic form `defineProps<Props>()` / `defineEmits<{ change: [id: number] }>()`; mixing runtime + type declarations, or untyped emits, loses checking |
| 18 | **`defineModel` Over Manual `v-model`** | In 3.4+ use `defineModel()` instead of hand-wiring `modelValue` + `update:modelValue`. `defineModel` also supports options/`required`/`default`, `get`/`set` transformers, and modifiers (`const [m, mods] = defineModel({ set })`) — hand-rolling modifier parsing is the anti-pattern |
| 19 | **Composable Naming & Contract** | Composables must be named `useX` and return refs (not unwrapped values). Two separate rules: (1) calling **conditionally** (`if (x) useX()`) silently no-ops lifecycle/effect binding in all contexts — always wrong; (2) calling **after `await` in plain Options API `async setup()` or in async callbacks** breaks binding — but in `<script setup>`, top-level `await`s are safe because the compiler restores context (see #9). Flag a composable called after `await` only when you can confirm the code is NOT in `<script setup>` |
| 21 | **`provide`/`inject` Typing & Defaults** | Use `InjectionKey<T>` for type-safe inject; supply a default or assert presence to avoid `undefined` at the injection site |
| 22 | **`provide`/`inject` Reactivity Loss** | Providing a snapshot/destructured primitive means injectors never update → provide a ref/reactive/computed (or getter); wrap in `readonly()` to keep flow one-way and provide an explicit mutator for changes |
| 23 | **Template Refs Accessed Too Early** | A `ref(null)` template ref is only populated after mount → reading `.value` in setup (before `onMounted`) yields `null` |
| 24 | **Template Ref Inside `v-for`** | Collecting `v-for` elements via a static `ref` name is fragile (behavior tightened in 3.5) and the collected array's order is not guaranteed to match the source → prefer a function ref (`:ref="el => ..."`) or `useTemplateRef`; don't rely on positional ordering |
| 25 | **`useTemplateRef` / Ref Naming (3.5+)** | Don't flag a resolving template ref; flag a `useTemplateRef`/ref-name attribute mismatch that leaves the binding unresolved → names must match; prefer `useTemplateRef('name')` in 3.5+ |
| 26 | **`defineExpose` Discipline** | `<script setup>` is closed by default; a parent calling `child.value.method()` gets `undefined` unless `defineExpose`'d. Expose deliberately and minimally, not as a workaround for poor prop/emit design |
| 27 | **Lifecycle Hook Registration** | `onMounted`/`onUnmounted`/`watch` must be registered at the top level of `setup()` or `<script setup>` — not inside async callbacks (event handlers, watchers, `setTimeout`/`setInterval`), or conditionals, where they silently no-op. Exception: in `<script setup>`, calls after a top-level `await` are valid — the compiler restores context (see #9). Flag this only when you can confirm the registration is inside an async callback or conditional, not a top-level await |
| 28 | **Props Are Readonly** | Props must not be mutated; deriving local mutable state requires a `ref`/`computed` copy (see #29) |

## Component Design (29-41)

| # | Issue | Check For |
| --- | ------- | --------- |
| 29 | **Mutating Props** | Never assign to a prop → clone into a local `ref`/`computed` or emit an event; one-way data flow. (Mutating a `reactive` object the parent intentionally shares, or a `defineModel` value, is not always a contract break — judge intent) |
| 30 | **Object/Array Prop Default Factory** | Object/array defaults in `withDefaults`/runtime props must be a factory `default: () => ({})`, not a shared literal → shared reference leaks across instances (does not apply to reactive-props-destructure literals, see #15) |
| 31 | **`v-model` Contract** | A custom `v-model` must pair the `modelValue` prop (or named model) with the matching `update:modelValue` emit; prefer `defineModel()` in 3.4+ |
| 33 | **Stable, Unique `v-for` `key`** | Use a stable unique key; never the array index when the list reorders/inserts/deletes → state bleed and wrong DOM patches. Index keys on a static/append-only list are fine |
| 34 | **`v-for` + `v-if` Same Element** | In Vue 3 `v-if` evaluates before `v-for` on the same element, so `v-if` can't read the loop variable → move `v-if` to a wrapper `<template>` or pre-filter with a `computed` |
| 35 | **Prop Drilling** | The same prop threaded through 3+ intermediate components that don't use it themselves, only forward it → `provide`/`inject` (typed with `InjectionKey`, #21) or a store. A frequent, concrete maintainability problem — flag it when you can name the chain of forwarding components |
| 36 | **Fallthrough Attributes / `inheritAttrs`** | Multi-root components or wrappers may drop `$attrs` (class, listeners) → bind `v-bind="$attrs"` explicitly and set `inheritAttrs: false` where needed. `useAttrs()` is not reactive to `watch()` — a `watch(() => attrs.foo, ...)` never fires (silent stale value); use `onUpdated()` for attr-driven side effects, or promote the attr to a real prop |
| 37 | **Slot Contract & Scoped Slots** | Missing fallback content, undocumented scoped-slot props, or `v-slot` shape mismatches break consumers |
| 39 | **Component Single-Responsibility** | A component that takes on too many unrelated jobs at once — e.g. data fetching, data transformation, complex local state, and intricate rendering all in one SFC → split into focused child components and extract pure logic into utils/composables. Too-many-responsibilities alone is the trigger — no duplication required (see #146 for the util-vs-composable-vs-component decision, not its 3+-site bar). Name the distinct responsibilities the component is juggling |
| 40 | **Dynamic `<component :is>` Safety** | Resolve the component reference (don't pass an arbitrary string), and guard `undefined` to avoid render crashes |
| 41 | **Async Component Error/Loading Contract** | `defineAsyncComponent` without `errorComponent`/`loadingComponent` (and `delay`/`timeout`) silently shows nothing on failure. Note `<Suspense>`'s `#fallback` shows only while *pending* — a rejected async `setup()` does NOT render the fallback; it propagates to the nearest `onErrorCaptured`/app `errorHandler`, so an async component with no error boundary above it blanks out silently |

## Template & Binding Correctness (42-49)

| # | Issue | Check For |
| --- | ------- | --------- |
| 42 | **Event Handler Invocation Bug** | `@click="fn()"` calls `fn` during render and binds its return; use `@click="fn"` or `@click="() => fn(arg)"` |
| 43 | **Missing `.prevent`/`.stop` or Wrong Modifier** | Form submit handlers without `.prevent`, key handlers without the right `.key` modifier → default behavior fires |
| 44 | **Class / Style Binding Shape** | `:class` expects string/array/object; passing the wrong shape silently renders nothing useful |
| 45 | **Interpolating Unwrapped Refs in `<script>`** | Building strings/conditions from a ref without `.value` in script-side logic (template auto-unwraps, script does not) |
| 46 | **Async/Conditional Render Gaps** | Rendering data before it loads (no `v-if="data"` guard) → template errors on `undefined`; pair with loading/error states |
| 47 | **Expensive Expressions in Template** | Method calls or heavy computations inline in the template re-run every render → move to a `computed` |
| 48 | **`v-once`/`v-memo` Correctness** | `v-memo` with wrong/missing deps caches stale renders; only worth it on large lists/static trees. Correctness footgun, not just perf: `v-model` does not work correctly inside a `v-memo` container — flag at bug severity when a `v-model` sits inside one. `v-memo="[]"` is equivalent to `v-once` |
| 49 | **Whitespace/HTML-Validity in Templates** | Invalid nesting (block inside `<p>`, interactive inside `<button>`) is auto-corrected by the browser → SSR markup ≠ client tree (hydration mismatch, see #67) |

## State Management - Pinia (50-55)

| # | Issue | Check For |
| --- | ------- | --------- |
| 50 | **Lost Reactivity Destructuring a Store** | `const { count } = useStore()` breaks reactivity → use `storeToRefs(store)` for state/getters; actions can be destructured directly |
| 51 | **Mutating State Outside Actions** | Scattered direct state mutation across components → centralize in actions for traceability and testability |
| 52 | **Store Used Outside Active Pinia** | Calling `useStore()` at module top-level or before Pinia is installed (esp. SSR) → call inside setup/handlers |
| 53 | **Cross-Request Store State (SSR)** | Module-scope singletons holding request data leak across requests in SSR → rely on per-request Pinia / `useState` |
| 54 | **Overusing the Store** | Local-only UI state pushed into a global store → keep it in the component; stores are for shared/cross-cutting state |
| 55 | **Legacy Vuex Misuse** | If Vuex is present: mutations vs actions confusion, non-namespaced modules, direct state writes → flag for Pinia migration where appropriate |

## Performance & Memory (56-63)

| # | Issue | Check For |
| --- | ------- | --------- |
| 56 | **Listeners/Timers Not Cleaned Up** | `addEventListener`, `setInterval`/`setTimeout`, observers, subscriptions, sockets started in setup/`onMounted` must be torn down in `onUnmounted` (or use VueUse auto-cleanup) → memory leak. Under `<KeepAlive>`, `onUnmounted` does NOT fire on deactivation — a cached component's effects keep running while off-screen; pause/tear down in `onDeactivated()` and re-arm in `onActivated()` instead |
| 57 | **Manual `watch`/`effect` Not Stopped** | Watchers created outside component scope (or that should stop early) must capture and call their stop handle, or use `effectScope` (#14) |
| 58 | **Over-Reactive Large Data** | Wrapping large/immutable structures in deep `reactive`/`ref` costs proxy traversal → use `shallowRef`/`shallowReactive`/`markRaw` |
| 59 | **`shallowRef` Nested-Mutation Trap** | `shallowRef` only tracks `.value` replacement → mutating a nested field won't re-render; reassign `.value` wholesale or call `triggerRef(ref)` |
| 61 | **Unbounded List Rendering** | Rendering thousands of rows without virtualization or pagination |
| 62 | **Unnecessary Reactivity / Recompute** | Deriving values eagerly instead of via `computed`; recomputing on every render instead of memoizing |
| 63 | **Inline Object/Function Props Causing Re-render** | Passing freshly-created objects/arrays/handlers as props each render defeats child memoization |

## Nuxt-Specific - NUXT-ONLY (64-78)

> Apply these only when Nuxt is detected: `nuxt` listed in `package.json`
> dependencies/devDependencies, a `nuxt.config.{ts,js,mjs}`, a `defineNuxtConfig` call, or a
> `.nuxt/` directory. On plain Vue, skip silently. If Nuxt signals are ambiguous, note
> `[nuxt: uncertain]` rather than silently skipping the SSR checks — the cross-request leak
> items (#53, #68) are the highest-value Criticals here.

| # | Issue | Check For |
| --- | ------- | --------- |
| 64 | **Bare `$fetch` in Setup Not Keyed** | `useFetch`/`useAsyncData` register a keyed async dep: the SSR result is serialized into the payload and reused on the client, and same-key calls dedupe. A bare `$fetch` in setup is not keyed → its SSR result is discarded and the client refetches after hydration. Use `$fetch` only in event handlers, `watch`, lifecycle hooks, and server routes |
| 65 | **`useFetch` vs `useAsyncData` vs `callOnce`** | Prefer `useFetch(url, opts)` for the single-URL case; reach for `useAsyncData(key, fn)` only when the source isn't one URL (multiple calls, non-`$fetch` source, custom dedup key). Prefer `status` (`'idle'\|'pending'\|'success'\|'error'`) over `pending` — `pending` is still returned but is a coarser boolean, not deprecated. For **one-time side effects** (analytics events, store initialization, logging) that don't return data, use `callOnce(key, fn)` — NOT `useAsyncData`; Nuxt docs explicitly warn that using `useAsyncData` for side effects causes unintended repeated executions |
| 66 | **Missing/Unstable Async-Data Key** | Composables need a stable explicit key for caching/dedup; dynamic or missing keys cause cache collisions or refetch storms. In Nuxt 4 same-key calls share one reactive state object — reusing a key with a different fetcher is a conflict |
| 67 | **Hydration Mismatch** | `Date.now()`/`Math.random()`, `window`/`document`, locale/timezone, invalid HTML nesting (#49), non-stable ids (use `useId()` 3.5+ for labels/aria), reading `localStorage`/cookies during render, or trees branched on `import.meta.client` → wrap in `<ClientOnly>` (with `#fallback` to avoid CLS) or defer to `onMounted` |
| 68 | **`useState` vs Plain `ref` for SSR** | Module-scope `ref` leaks across requests → use `useState(key, init)` with a unique stable key (collisions silently share state). Its value is serialized into the payload — it must be plain-JSON-serializable (no functions, class instances, symbols, or circular references); never put secrets/another user's data in it; initialize per-request data inside `init`, not via outer-scope capture. Reset with `clearNuxtState(key)` where a fresh per-navigation value is required |
| 69 | **Legacy `process.client`/`process.server`** | Deprecated in Nuxt 3, removed in Nuxt 4 → replace with `import.meta.client`/`import.meta.server`; their presence usually signals copied Nuxt 2 code worth extra scrutiny |
| 70 | **Client-Only Code on Server** | `window`/`document`/browser APIs during SSR → guard with `import.meta.client`/`onMounted` or `<ClientOnly>` |
| 71 | **SSR Auth/Header Forwarding** | `useFetch`/`useAsyncData` **auto-forward** the incoming request's cookies/headers on SSR (via `useRequestFetch()` under the hood, excluding e.g. `host`, `content-length`, `accept`, `content-type`, `x-forwarded-*`, `cf-*`) — do NOT flag `useFetch`/`useAsyncData` for missing header forwarding **on same-origin/relative URLs**. The real gap is a raw server-side **`$fetch`** call (or `useAsyncData` wrapping a bare `$fetch`) to an authenticated endpoint, which does NOT carry cookies/headers by default → forward explicitly with `useRequestFetch()` or `$fetch(url, { headers: useRequestHeaders(['cookie']) })`. Symptom: works on client nav, 401s on hard refresh/SSR |
| 72 | **Server Route Input Validation** | `server/api` handlers: read input via `readBody`/`getQuery`/`getRouterParam`; validate with `readValidatedBody(event, schema.parse)` / `getValidatedQuery(...)` using zod/valibot, not hand-rolled checks. Unvalidated input into DB/fs/`$fetch` is an injection/DoS risk |
| 73 | **Server Error Handling** | Throw `createError({ statusCode, statusMessage })` for client-facing errors; never return raw `Error`/DB errors (leaks internals, becomes a 500); don't echo unvalidated input in error messages |
| 74 | **Nitro Cache Key Leak** | `defineCachedEventHandler`/`cachedFunction`/`routeRules` caching must not cache per-user or auth-dependent responses without a `getKey` including the varying dimension → one user's response served to another (data leak) |
| 75 | **Runtime Config Exposure** | Private keys go top-level under `runtimeConfig` (server-only, via `useRuntimeConfig()`); anything under `runtimeConfig.public` is serialized to the client payload — never secrets there. Don't commit real secrets as defaults in `nuxt.config.ts` (leave empty, supply via `NUXT_`-prefixed env vars). Accessing a private key in client code is `undefined` — a bug. Don't confuse with `app.config.ts` (build-time, public) |
| 76 | **Nuxt 4 Data Defaults & Aliases** | In Nuxt 4 `useFetch`/`useAsyncData` `data` is a `shallowRef` by default (`deep: false`) → deep-mutating fetched objects won't re-render; replace `.value` or pass `{ deep: true }`. Default `dedupe: 'cancel'`. Nuxt 4 also remaps `~`/`@` to the `app/` srcDir and `~~`/`@@` to the project root (`#shared`/`#server` for those dirs) — a `~` import of a root-level file (e.g. `~/server/...`, `~/shared/...`) is a real migration bug, not a style choice. Watch for half-migrated `app/` dir layouts |
| 77 | **Missing SEO / `useSeoMeta`/`useHead`** | Pages missing title/meta; pass a getter/computed for dynamic values (`useSeoMeta({ title: () => data.value?.title })`) — a plain string captured before async data resolves yields stale/empty meta. Prefer typed `useSeoMeta` |
| 78 | **Middleware / Plugin Misuse** | Middleware: `return navigateTo(...)`/`return abortNavigation()` (un-returned redirect no-ops); know global (`*.global.ts`) vs named vs inline. Plugins: correct `.client`/`.server` suffix or `import.meta.client` guard; `defineNuxtPlugin` `dependsOn`/`order` when sequencing matters; avoid heavy async that blocks hydration |

## TypeScript (79-87)

| # | Issue | Check For |
| --- | ------- | --------- |
| 79 | **`any` Overuse** | `any` on props/emits/refs/composable returns/function params defeats checking and spreads (anything touching an `any` becomes `any`) → use `unknown` + narrowing, generics, or a real type. Watch for implicit `any` (untyped params, `JSON.parse`, `res.json()`) |
| 80 | **Untyped Component Contracts** | `defineProps`/`defineEmits`/`provide`-`inject` without types → public surface is unchecked |
| 81 | **Typed Composable Return** | Don't flag a well-typed composable return; flag one returning a loosely-typed object → declare an explicit return interface so consumers get checking |
| 82 | **Discriminated Union Props** | Mutually-exclusive prop combinations modeled as all-optional → use a discriminated union so impossible states are unrepresentable |
| 83 | **`as` / YOLO Casting Overuse** | Flag `as any` to silence an error, and the double-assertion `as unknown as Foo` used to force unrelated types — these bypass the checker and hide real shape/null bugs → narrow with type guards / `instanceof` / `in`. NOT findings: `as const` (it *tightens* types), a single well-justified narrowing where inference can't reach the truth (e.g. `e.target as HTMLInputElement` in a handler, a framework-required cast) — judge whether the cast hides a plausible bug before flagging |
| 84 | **Non-Null Assertion `!` Overuse** | `x!.y` suppresses null checks → guard instead, especially around template refs and async data |
| 86 | **`Ref`/`ComputedRef` Typing** | Don't flag a well-inferred ref; flag one whose weak inference leaves downstream `.value` mistyped → annotate the generic (`ref<User \| null>(null)`) |

## Testing (88-107)

Standard: Vitest for unit + component (`@vue/test-utils` baseline, `@testing-library/vue`
welcome; `@nuxt/test-utils` for Nuxt), Playwright for e2e / regression / smoke. Match the level
to the responsibility — **pure functions: plain unit tests (no mount); single-component
render/interaction/emits: component tests; multi-page/real-network journeys: e2e**. Flag
mismatches (mounting a component to test a formatter; an e2e re-asserting a pure util). Tests
must exercise real code on real positive **and** negative paths.

| # | Issue | Check For |
| --- | ------- | --------- |
| 88 | **Over-Mocking the Unit Under Test** | Mocking the component/composable being tested, or stubbing so much that no real code runs → test passes without exercising behavior. Mock the boundary (network/IO), not the unit |
| 89 | **Happy-Path Only** | Only the success case asserted; no error, empty, loading, boundary, or rejection path → negative coverage missing |
| 90 | **Assertions That Can't Fail** | `expect(wrapper).toBeTruthy()`, asserting a mock's own return, asserting nothing after an action → vacuous test |
| 91 | **Snapshot-Only Tests** | `toMatchSnapshot()` as the sole assertion captures markup churn but asserts no behavior → require explicit behavioral assertions |
| 92 | **`shallowMount` / Global Stubs Hide Integration** | Asserting rendered text/behavior actually produced by a stubbed child → passes vacuously. Prefer `mount` for component-integration; stub only genuinely external/heavy children; never assert a stub's rendered internals |
| 93 | **Testing Implementation Details** | Asserting internal refs/`wrapper.vm` private state, `findComponent(X).vm.*`, or a child stub's `.props()` instead of rendered output / emitted events → brittle; refactors break green tests |
| 94 | **Not Awaiting Reactivity/DOM/Timers** | Asserting before `await nextTick()`/`await flushPromises()`, or not advancing `vi.useFakeTimers()` for debounce/throttle → nondeterministic |
| 95 | **Mocking `useFetch`/`useAsyncData` Bypasses Logic** | Returning the final data shape from a mocked composable skips the component's `transform`/`default`/`pick`/error handling → that logic is untested. Mock at the network boundary (`registerEndpoint` from `@nuxt/test-utils`, MSW); if you must `mockNuxtImport`, assert the transform separately |
| 96 | **Wholesale Stubbing of `fetch`/`$fetch`/Pinia** | Replacing the network or store layer so the component's real data flow is bypassed → use realistic fixtures and exercise the actual store action |
| 97 | **No Coverage of Emitted Events / Interaction** | Component tests that never trigger interaction or assert `emitted()` → contract untested |
| 98 | **Testing-Library Query Misuse** | Prefer `getByRole`/`getByLabelText`/`getByText` over `getByTestId` (test the accessible UI, not test hooks); use `queryBy*` for absence, awaited `findBy*` for async appearance; `getBy*` for absence throws |
| 99 | **Nuxt Component Tests Without `@nuxt/test-utils`** | Components using auto-imports/Nuxt composables need `mountSuspended`/`renderSuspended` + the nuxt vitest environment; mocking every Nuxt composable to avoid the runtime is a smell |
| 100 | **Playwright Smoke Asserts Real Outcomes** | E2E that only checks a 200 or element existence, not the user-visible result (text rendered, navigation, data shown) → assert the observable outcome |
| 101 | **Playwright Web-First Assertions** | `expect(await locator.textContent()).toBe(...)`/`.count()` resolves once with no retry → use auto-retrying `await expect(locator).toHaveText/toHaveCount/toBeVisible`; avoid `waitForTimeout` and `waitForLoadState('networkidle')` |
| 102 | **Playwright Auth/State via UI** | Logging in through the UI every test is slow/flaky → authenticate once via global-setup + `storageState` (or a fixture); enable `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` |
| 103 | **Test Isolation** | Tests sharing mutable state or depending on execution order → flaky; reset mocks/state between tests |
| 104 | **Vitest Mock Reset/Restore** | `vi.fn`/`vi.spyOn` not reset between tests → state bleeds. Note `clearMocks` only zeroes call history; to reset a mock *implementation* you need `mockReset`/`restoreMocks: true` (config) or `vi.restoreAllMocks()` (restores spies) / `vi.resetAllMocks()` in `afterEach`. A `mockResolvedValue` set in one test leaks into later tests unless reset. `vi.mock` factories persist for the whole file |
| 105 | **`vi.mock` Hoisting & Path** | `vi.mock(path, factory)` is hoisted above imports → referencing outer variables in the factory throws unless wrapped in `vi.hoisted()`; a wrong/relative module path silently mocks nothing (no error), so the real module runs and the test gives false confidence |
| 106 | **Async Assertion Rigor** | Async tests must `await expect(promise).rejects/.resolves`, and event/callback tests should use `expect.assertions(n)`/`expect.hasAssertions()` → otherwise an async test can finish green without its assertion ever running |
| 107 | **Vitest Environment Config** | Component tests need a DOM environment (`environment: 'jsdom'`/`'happy-dom'` in config or `// @vitest-environment` docblock); a pure-`node` environment leaves `document`/`window` undefined and either crashes or pushes authors toward over-mocking |

## Router & Navigation (108-112)

| # | Issue | Check For |
| --- | ------- | --------- |
| 108 | **Navigation Guard Returns** | `beforeEach`/`beforeRouteLeave`/route middleware must return `next()`/a route/`false` (or in Nuxt `navigateTo`/`abortNavigation`) → un-returned guards hang or no-op the redirect |
| 109 | **Async Guards Not Awaited** | Async work in a guard (auth check, fetch) not awaited → navigation proceeds before the decision resolves |
| 110 | **Unsaved-Changes / Leave Guards** | Forms with dirty state and no `beforeRouteLeave`/`onBeforeRouteLeave` guard → silent data loss on navigation |
| 111 | **Redirect Loops / Open Redirects** | Guards redirecting into themselves; redirecting to a user-supplied `?redirect=` URL without allow-listing (open redirect) |
| 112 | **Route Param Reactivity** | Component reused across param changes (`/user/1` → `/user/2`) won't re-run setup → `watch(() => route.params.id, ...)` or a keyed `<RouterView>`. **(Nuxt)** `onBeforeRouteUpdate()` or `<NuxtPage :page-key="route.fullPath" />` are the idiomatic equivalents |

## Forms & Validation (113-116)

| # | Issue | Check For |
| --- | ------- | --------- |
| 113 | **Validation Doesn't Run on Submit** | Field-level validation that isn't enforced at submit, or submit handler not awaiting async validators → invalid data through |
| 114 | **Client-Only Validation Trusted** | Client validation treated as sufficient; the server route must independently validate (see #72) → never trust the client |
| 115 | **Error State Not Cleared/Associated** | Stale error messages after correction; errors not tied to inputs (`aria-describedby`) for a11y/UX |
| 116 | **Uncontrolled Submit / Double Submit** | Submit without `.prevent`, no pending-disable → duplicate submissions / full page reload |

## Error Handling (117-120)

| # | Issue | Check For |
| --- | ------- | --------- |
| 117 | **Unhandled Async in Setup** | `await` in setup without try/catch → a rejection crashes SSR render / leaves the component blank. **(Nuxt)** `useFetch`/`useAsyncData` are the exception, not the finding: they route a rejection into their `error` return rather than throwing, so idiomatic top-level `await useFetch(...)`/`await useAsyncData(...)` is not an unhandled-async crash — the finding is for a bare `await` with no try/catch and no framework error channel |
| 118 | **No Error Boundary** | No `onErrorCaptured`, app-level `errorHandler`, or Nuxt `error.vue` for sections that can throw → whole tree blanks out. **(Nuxt)** for a fallible section instead of the whole page, wrap it in `<NuxtErrorBoundary>` with an `@error` handler + fallback slot exposing `clearError()`; surface thrown errors client-side via `showError`/`createError` and read them with `useError()` |
| 119 | **Swallowed Errors** | `catch {}` that logs nothing and shows no UI state → silent failure; user sees a spinner forever |
| 120 | **`loading`/`error` State Stuck** | Async op that doesn't reset `loading` in a `finally` or set an `error` state on rejection → stuck UI |

## Security (121-126)

| # | Issue | Check For |
| --- | ------- | --------- |
| 121 | **`v-html` Without Sanitization** | `v-html` with user/remote content is an XSS sink → sanitize (DOMPurify) or render as text. Static/constant `v-html` is not XSS |
| 122 | **Untrusted URL / Style Bindings** | Binding `javascript:` or unvalidated URLs to `:href`/`:src` enables injection/navigation attacks. Also flag `:style="userProvidedStyles"` (an object or CSS string from user/remote data) — malicious CSS can overlay transparent elements over login buttons and other UI (clickjacking). Safe alternative: bind only specific, enumerated CSS properties (`:style="{ color: userColor }"`) or sanitize server-side. `:class` with user-controlled keys is similarly risky |
| 123 | **`target="_blank"` Without `rel`** | External links opened with `target="_blank"` need `rel="noopener noreferrer"` → reverse-tabnabbing |
| 124 | **Tokens in `localStorage`** | Auth tokens in `localStorage`/`sessionStorage` are XSS-exfiltratable → prefer httpOnly cookies; flag client-readable token storage. **(Nuxt)** `useCookie()` is the SSR-safe replacement when a cookie (rather than a pure server-set httpOnly cookie) is the right tool |
| 125 | **Secrets Reaching the Client** | Secrets in `runtimeConfig.public` (#75), in `useState`/payload (#68), or env vars referenced in client code → leaked to the browser |
| 126 | **Missing Origin/CSRF Checks** | `postMessage` handlers without origin checks; mutating server routes without CSRF protection where cookies authenticate |

## Accessibility & Semantics (127-132)

Report when relevant to the change; don't audit the whole app.

| # | Issue | Check For |
| --- | ------- | --------- |
| 127 | **Non-Semantic Interactive Elements** | `<div @click>` instead of `<button>` → no keyboard/focus/role semantics |
| 128 | **Missing Labels / `alt`** | Inputs without labels, images without `alt`, icon-only buttons without `aria-label`. In reusable components that render form controls, hardcoding an `id` causes duplicate IDs when the component is used more than once → use Vue 3.5+ `useId()` to generate unique per-instance IDs (`const id = useId()`) and wire them to labels |
| 129 | **Keyboard Operability & Focus Trap** | Click handlers without keyboard equivalents; dialogs/menus without focus trap or focus restore |
| 130 | **`aria-live` for Async Results** | Async-loaded content / form errors not announced (`aria-live`, `role="alert"`) |
| 131 | **ARIA Misuse** | Redundant or incorrect `role`/`aria-*` fighting native semantics |
| 132 | **Color/State Without Text** | State signaled by color alone, no text/aria alternative |

## Dependency & Config Hygiene (133-136)

Relevant when `package.json` / config changed.

| # | Issue | Check For |
| --- | ------- | --------- |
| 133 | **Heavy / Duplicate Dependency Added** | A large dep added for a small need, or one that duplicates VueUse/stdlib/an existing dep → bundle bloat |
| 134 | **Server-Only Dep in Client Bundle** | Node/server-only packages imported into client-executed code → bundle bloat or runtime crash |
| 135 | **Loose Version Ranges / postinstall** | Unpinned `*`/broad `^` on volatile app deps, or new `postinstall` scripts → supply-chain/repro risk |
| 136 | **`peerDependencies` Range in Published Libraries** | Applies ONLY to a package that publishes a consumable library (has `exports`/`main` + is published, not `private: true`) — NOT to apps, where pinning framework versions in `dependencies` is correct. In a published library, framework peers (`vue`, `nuxt`, `pinia`, `vue-router`) belong in `peerDependencies` with a **range** (`^3`, `>=3.4 <4`), not a pinned exact version and not in `dependencies` → a pinned/duplicated peer causes version conflicts and duplicate Vue instances in the consumer. Match the library's actual supported range (the example here is illustrative) |

## Options API & Migration (137-142)

For mixed or legacy code only. Flag highest-value gotchas; don't dual-track every rule.

| # | Issue | Check For |
| --- | ------- | --------- |
| 137 | **`data` Must Be a Function** | Component `data` as an object shares state across instances → must be `data() { return {...} }` |
| 138 | **`this` in Arrow Methods** | Arrow functions in `methods`/lifecycle lose the component `this` → use regular functions |
| 139 | **Mixins Over Composables** | New shared logic via mixins (implicit, collision-prone) → prefer composables |
| 140 | **Removed Vue 2 APIs** | `filters`, `$listeners`, `.native` modifier, `Vue.set`/`Vue.delete`, global `Vue.x` → removed/changed in 3 |
| 141 | **`v-model` API Change** | Vue 2 `value`/`input` and `.sync` → Vue 3 `modelValue`/`update:modelValue` and named models |
| 142 | **Global API / App Creation** | `new Vue()` and `Vue.use` → `createApp(...).use(...)`; global config moved to the app instance |

## Maintainability & Complexity (143-148)

Cross-cutting. "Complex" is subjective, so flag these ONLY with a concrete, named signal — never
on taste or "this feels complex." Concrete signals that count as complex (rough guides; respect
the project's existing norms):

- a `<script setup>` past ~200-300 lines, or a single function past ~50 lines;
- a function with more than ~10 branches / nesting deeper than ~3 levels (template or script);
- a component with ~10+ props, several mode-encoding booleans, or ~7+ pieces of local state;
- the same block of markup or logic duplicated across 3+ sites;
- long chained optional/ternary expressions (`a?.b?.c ? x : y ? z : w`).

Default to Low; escalate to Medium only when the complexity demonstrably causes bugs or blocks
change. Never demand structure or comments for their own sake.

| # | Issue | Check For |
| --- | ------- | --------- |
| 143 | **Oversized Component** | An SFC far past the codebase's norm (e.g. several hundred lines, or a `<script setup>` doing data fetching + transforming + several unrelated UI concerns at once) → extract child components and/or composables. Size/complexity alone is the trigger, not #146's 3+-site duplication bar (see #146 for the util-vs-composable-vs-component decision, #39 for the single-responsibility framing). Name the concrete size and the distinct responsibilities, not a vibe |
| 144 | **Too Many Props / Boolean Flags** | A large prop surface (e.g. ~10+ props, or several `boolean` flags encoding modes like `isOpen`/`isLoading`/`isCompact`/`isPrimary`) → decompose the component, use slots, or model mutually-exclusive variants with a discriminated union (#82). Cite the count |
| 145 | **Deep Nesting / High Branch Complexity** | Deeply nested template `v-if`/`v-for` (3+ levels) or long script functions with many branches/early-returns → extract sub-components or pure, independently-testable helpers. Nesting/branch depth alone is the trigger, not #146's 3+-site duplication bar (see #146 for the util-vs-composable-vs-component decision). State the nesting depth / branch count |
| 146 | **Duplication → Extract the Right Reuse** | A repeated block across 3+ sites → name the duplicated sites AND the right refactor target: **pure stateless logic → a reusable util function**; **stateful/reactive logic (refs, watchers, lifecycle) → a `useX` composable**; **repeated markup + behavior → a child component**. Suggest the specific extraction, not just "deduplicate" |
| 147 | **Dead / Unused Code (in the diff)** | `delete` — unused imports, variables, refs, props, emits, parameters, or functions; unreachable branches; commented-out code introduced or left behind in the changed files. Scope to the changed code/files only (don't sweep the whole codebase unless asked); for a newly-added exported symbol, grep for references before calling it unused |
| 148 | **Missing "Why" Comments on Non-Obvious Logic** | Genuinely non-obvious code — intricate reactivity, regex, bitwise math, a workaround for a known bug, a non-obvious business rule, or a deliberate perf hack — with nothing explaining WHY → add a concise, focused comment (the *why*, not the *what*; TSDoc for exported functions/types where it aids consumers). Do NOT flag self-explanatory code or demand comments everywhere — over-commenting is its own noise |

## Advanced Reactivity Hazards (149-150)

| # | Issue | Check For |
| --- | ------- | --------- |
| 149 | **Write-Inside-Read-Primitive → Infinite Reactive Loop** | A function that (a) writes reactive state (`ref.value =`, `.push()`/`.splice()` on a reactive array, `.set()`/`.add()` on a reactive Map/Set, etc.) and (b) is called from a Vue `computed()`, `watchEffect()`, or template creates an infinite loop. Vue's reactive setter immediately marks the caller's active effect dirty — **the write alone is sufficient; no subsequent read of the written value is required.** The effect re-runs → re-calls the function → writes again → browser hang. **`reactive()` wrapper is irrelevant** — a plain composable `return { fn }` crashes identically. Classic footgun: a read-sounding (`is*`/`check*`/`has*`) function secretly writes a ref. Fix: keep read-predicates pure; restrict writes to intent-signaling methods (`onPageVisit`, `onToggle`). **Critical** if callable from template/computed (returned from composable, on a `reactive()` object, passed via provide/prop). Also covers getter properties on `reactive()` that write state — same crash, distinct from #7. **Verify: if called from `computed(() => fn())`, does `fn` write any reactive state? If yes → Critical.** |
| 150 | **Module-Scope Mutable Ref Leaks Across Composable Instances** | A `ref()` or `reactive()` declared at module scope (outside the composable function body) is shared across every component that calls the composable — the intent is usually per-instance state, but every caller mutates the same singleton. Unlike #53 (SSR cross-request leak), this is a pure client-side instance-bleed that is silent in dev, invisible in unit tests (which usually mount one component), but surfaces when two components on the same page independently call `useX()` and expect isolated state. Fix: declare all per-instance state **inside** the composable function body. Shared-intentionally-singleton state is fine at module scope but must be documented. Severity: Critical when the shared state carries user- or entity-specific data (e.g., a shopping cart, form draft, selected entity) |

## Component Features & SSR Hazards (151-157)

Every item here names a concrete failure (loop, leak, broken render, hydration mismatch, or data
exposure) — none are style/preference. Feature-authoring conventions with no demonstrated failure
(animation choices, lazy-hydration tuning, render-function style, plugin/layer authoring) are
intentionally out of scope for this catalog.

| # | Issue | Check For |
| --- | ------- | --------- |
| 151 | **Async Watcher Race / No Cleanup** | A `watch`/`watchEffect` firing an async request (search, filter, autocomplete) with no cancellation guard → a slower earlier response can resolve after a faster later one and overwrite it with stale data. Fix: `onWatcherCleanup()` (3.5+ global) or the callback's `onCleanup` argument, paired with an `AbortController`, to cancel/ignore the superseded request |
| 152 | **State Mutation Inside `onUpdated`** | Mutating reactive state or calling APIs inside `onUpdated`/`updated` re-triggers the render it just responded to → infinite update loop / browser hang, the same class of bug as #149 via a different hook. Move derived-state logic to `watch`/`computed`; reserve `onUpdated` for low-level DOM sync (e.g. refreshing a third-party widget) that does not write reactive state |
| 153 | **KeepAlive Resource & Data-Exposure Safety** | `<KeepAlive>` with no `:max` lets the cache grow unbounded (memory leak); caching a view holding auth/sensitive data leaves it resident in memory after the user navigates away or logs out; `include`/`exclude` match against an explicit `defineOptions({ name })` — a component without one silently isn't matched. Vue has no API to evict a single cached instance; force recreation with `:key` |
| 154 | **Teleport Stacking / SSR Safety** | A teleport target nested inside an ancestor with `transform`/`filter`/`perspective` breaks `position: fixed` on the teleported content (modals/tooltips mis-layer or clip). **(Nuxt)** teleporting during SSR without wrapping in `<ClientOnly>` causes a hydration mismatch |
| 155 | **Suspense Single-Root Violation** | `<Suspense>` requires a single root node in both the default slot and the `#fallback` slot; more than one root throws a render error. (Suspense remains an experimental API in Vue 3 — extra scrutiny warranted) |
| 156 | **Custom Directive SSR / Cleanup Gaps** | A directive that sets DOM attributes/classes without implementing `getSSRProps` renders differently on the server than the client → hydration mismatch (ties to #67). Observers/listeners attached in a directive's mounted hook must be torn down in `unmounted` or they leak, same failure mode as #56 |
| 157 | **Missing Nuxt Page `validate`** | A dynamic route with no `definePageMeta({ validate })` renders on any param value, including garbage input, instead of returning a 404 or a custom error (`{ statusCode }`). Complements server-route input validation (#72) |

## Common Patterns

**Reactive props with defaults (3.5+ reactive props destructure):**

```ts
// Reactive in 3.5+ — the compiler rewrites these back to props.x access
const { size = 'sm', items = [] } = defineProps<{ size?: 'sm' | 'lg'; items?: string[] }>()
// Pass through a getter to keep reactivity across boundaries:
watch(() => size, onSizeChange)
```

**Two-way binding (3.4+), with a transformer:**

```ts
const model = defineModel<string>()                       // replaces modelValue + update:modelValue
const trimmed = defineModel<string>({ set: (v) => v.trim() })
```

**Cleanup side effects:**

```ts
import { useEventListener } from '@vueuse/core'
useEventListener(window, 'resize', onResize) // auto-removed on unmount

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize)) // manual equivalent
```

**Type-safe, reactive provide/inject:**

```ts
import type { InjectionKey, Ref } from 'vue'
import { readonly } from 'vue'
export const themeKey: InjectionKey<Ref<'light' | 'dark'>> = Symbol('theme')
// provide(themeKey, readonly(theme)); const theme = inject(themeKey) // typed, one-way
```

**Type-only imports on their own line; narrow instead of YOLO casting:**

```ts
import { ref, computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'

// avoid: const u = data as unknown as User   // YOLO cast hides shape bugs
function isUser(x: unknown): x is User {
  return typeof x === 'object' && x !== null && 'name' in x
}
```

**Extract pure logic into a testable util/composable:**

```ts
// utils/price.ts - pure, unit-testable without mounting a component
export function formatPrice(cents: number, currency = 'USD'): string { /* ... */ }

// composables/useCart.ts - reactive state isolated from any single component
export function useCart() {
  const items = ref<CartItem[]>([])
  const total = computed(() => items.value.reduce((s, i) => s + i.price, 0))
  return { items, total }
}
```

**Published component library `package.json` (framework peers as ranges):**

```jsonc
{
  "peerDependencies": { "vue": "^3.4" },   // range, not pinned; not in dependencies
  "devDependencies": { "vue": "^3.5.13" }  // pin the dev/test version here instead
}
```

**Nuxt data fetching (keyed, SSR-safe, auth-forwarded):**

```ts
// In setup: keyed dedup + SSR payload transfer; use status over the coarser boolean `pending`
const { data, error, status } = await useFetch(`/api/users/${id}`, {
  headers: useRequestHeaders(['cookie']), // forward auth on SSR
})
// In an event handler / server route: bare $fetch is correct
async function save() { await $fetch('/api/users/1', { method: 'PATCH', body }) }
```

**Nuxt server route with validated input:**

```ts
import { z } from 'zod'
const Body = z.object({ name: z.string().min(1) })
export default defineEventHandler(async (event) => {
  const result = Body.safeParse(await readBody(event))
  if (!result.success) throw createError({ statusCode: 400, statusMessage: 'Invalid body' })
  return saveUser(result.data) // result.data is fully typed
})
```

**Behavioral component test (positive + negative path):**

```ts
import { mount, flushPromises } from '@vue/test-utils'
import UserCard from './UserCard.vue'

it('shows the user name after load', async () => {
  const fetchUser = vi.fn().mockResolvedValue({ name: 'Ada' })
  const wrapper = mount(UserCard, { props: { userId: 1, fetchUser } })
  expect(wrapper.text()).toContain('Loading')
  await flushPromises()
  expect(wrapper.text()).toContain('Ada') // real rendered outcome
})

it('shows an error when the fetch rejects', async () => {
  const fetchUser = vi.fn().mockRejectedValue(new Error('boom'))
  const wrapper = mount(UserCard, { props: { userId: 1, fetchUser } })
  await flushPromises()
  expect(wrapper.text()).toContain('Something went wrong') // negative path
  expect(wrapper.emitted('error')).toBeTruthy()
})
```
