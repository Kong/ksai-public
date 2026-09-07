# Real-World Vue / Nuxt Patterns - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Sources: official Vue Style Guide (priority A/B/C) <https://vuejs.org/style-guide/>,
Nuxt docs <https://nuxt.com/docs>, VueUse <https://vueuse.org/>, Pinia <https://pinia.vuejs.org/>,
Vue Test Utils / Testing Library, Playwright best practices.

Patterns distilled from established Vue/Nuxt conventions and real review feedback. Each
**Check For** is written as a negative constraint — the condition that must actually hold before
you flag, not a bare directive — so the pattern narrows a finding rather than inviting one on
every diff. See **When to Report / When to Skip** at the end.

## Reactivity

### Read Predicates Must Be Pure — No Reactive Writes (write-in-read infinite loop)

**Check For:** Any function, on any object (reactive or plain), that is callable from a Vue
template expression, `computed()`, or `watchEffect()`, AND that writes a reactive `ref`
internally. The `reactive()` wrapper on the object is irrelevant — the loop is driven
solely by Vue's scope-based reactive tracking.

**Anti-pattern:**

```ts
// WRONG — checkItem writes currentEntity; exposing it on any context object
// callable from templates causes an infinite reactive loop.
const checkItem = (data?: EntityData): boolean => {
  if (data?.name && data?.type) {
    currentEntity.value = { ...data, path: data.path || route.fullPath } // WRITE
    return items.value.some(f => f.path === currentEntity.value!.path)  // READ
  }
  return currentEntityIsFavorite.value
}

// Crash: template calling ctx.isActive(data) or computed(() => checkItem(data))
// 1. Vue tracking context is active (template render / computed getter)
// 2. checkItem writes currentEntity → Vue marks the effect dirty immediately (write alone is sufficient)
// 3. Effect re-runs → calls checkItem again → infinite loop → browser hang
```

**Pattern:**

```ts
// CORRECT — pure read; writes live only in intent-signaling methods
const checkItem = (data?: EntityData): boolean => {
  if (data?.name && data?.type) {
    const path = data.path || route.fullPath
    return items.value.some(f => f.path === path) // no write to shared state
  }
  return currentEntityIsFavorite.value
}

// Only onPageVisit / onToggle own writes to currentEntity
```

**Why:** Vue 3 reactive tracking is scope-based, not object-based. Any read or write that
occurs inside a function executes under the active tracking context of the **caller** — the
computed getter or template render that invoked the function. A write to a reactive ref
during this context immediately invalidates the caller's effect, triggering re-execution,
which calls the function again — an infinite loop. The `reactive()` wrapper on the context
object is irrelevant; a plain `return { checkFavorite }` from a composable crashes
identically. Maps to knowledge-base #149.

**Hunt for it:** every function on a returned context object / composable return value — not
just `is*`/`check*`/`get*`/`has*` names, but ANY function whose body contains `someRef.value =`,
`someReactive.prop =`, `.push(`, `.splice(`, `.pop(`, `.set(`, `.add(`, or `delete` on reactive
state — then confirm it's reachable from a template or `computed()` (returned from a composable,
on a `reactive()` object, passed via provide/prop). Also check getter *properties* on `reactive()`
objects that write state — same crash, distinct from #7 (computed getters, not accessor properties).

**Auditing this finding — two dimensions, evaluated independently:** don't let a clean verdict
on one dismiss the other.

1. *Infinite-loop (Critical):* is the function reachable from a template expression,
   `computed()`, or `watchEffect()` — on a returned context object, a `reactive()` object, or
   passed via provide/prop to a child that renders it? If yes → Critical, even with no current
   callers passing a foreign argument and even if a grep finds no call sites yet — the
   architectural exposure on a context object is itself the evidence; a future consumer or the
   framework may invoke it from a tracking context. Downgrade to High only when every greppable
   caller is an event handler (`@click`, `@input`, a lifecycle hook, a watcher callback) with no
   evidence of template/computed invocation — event handlers don't establish a tracking context.
2. *Wrong-state (Medium):* does a call with a foreign argument clobber currently-tracked state,
   producing wrong UI? Requires both a caller passing a different entity's data AND a consumer
   reading the corrupted state. "No such callers exist" downgrades *this* dimension only — it
   does not downgrade dimension 1.

---

### Cancel Superseded Async Watchers (Vue docs - watchers)

**Check For:** A `watch`/`watchEffect` firing an async request (search, filter, autocomplete)
with no cancellation guard

**Anti-pattern:**

```ts
watch(query, async (q) => {
  const res = await search(q) // a slow earlier call can resolve after a later one
  results.value = res         // and overwrite the correct, newer results with stale data
})
```

**Pattern:**

```ts
watch(query, async (q, _old, onCleanup) => {
  const controller = new AbortController()
  onCleanup(() => controller.abort()) // or the global onWatcherCleanup() in Vue 3.5+
  const res = await search(q, { signal: controller.signal })
  results.value = res
})
```

**Why:** Watcher callbacks don't cancel in-flight work when re-triggered. Without an abort/
cleanup guard, out-of-order resolution renders stale results for whatever request happens to
finish last, not the most recent query. Maps to knowledge-base #151.

---

### Preserve Reactivity When Destructuring (Vue docs - reactivity caveats)

**Check For:** Destructuring `reactive()` state or `props`, then expecting updates to flow

**Anti-pattern:**

```ts
const state = reactive({ count: 0 })
const { count } = state // snapshot — never updates
```

**Pattern:**

```ts
import { toRefs } from 'vue'
const state = reactive({ count: 0 })
const { count } = toRefs(state) // count is a Ref, stays reactive
```

**Why:** Destructuring a `reactive()` object copies the current value and severs proxy tracking;
`toRefs`/`toRef` keep the live connection. Note: destructuring **props** at the `defineProps`
call site is reactive in Vue 3.5+ (reactive-props-destructure) and should NOT be flagged. Maps
to knowledge-base #1.

## Component Design

### One-Way Data Flow - Don't Mutate Props (Vue Style Guide, essential)

**Check For:** Assigning to a prop, or pushing/splicing a prop array

**Anti-pattern:**

```ts
const props = defineProps<{ items: string[] }>()
function add(x: string) { props.items.push(x) } // mutates parent state implicitly
```

**Pattern:**

```ts
const props = defineProps<{ items: string[] }>()
const emit = defineEmits<{ 'update:items': [string[]] }>()
function add(x: string) { emit('update:items', [...props.items, x]) }
```

**Why:** Mutating props breaks the one-way contract, makes data flow untraceable, and warns in
dev. Emit an event or use `defineModel`. Maps to #29.

### Always `key` with `v-for`, Never Index on Mutating Lists (Vue Style Guide, essential)

**Check For:** Missing `:key`, or `:key="index"` on lists that reorder/insert/delete

**Anti-pattern:**

```vue
<li v-for="(todo, i) in todos" :key="i">
  <input v-model="todo.done" />
</li>
```

**Pattern:**

```vue
<li v-for="todo in todos" :key="todo.id">
  <input v-model="todo.done" />
</li>
```

**Why:** Index keys make Vue reuse the wrong DOM nodes on reorder/insert, bleeding component
state (checkbox/input values) across rows. Stable IDs patch correctly. Maps to #33.

## Naming

### `useX` Composable Contract (Vue Style Guide A)

**Check For:** A composable not prefixed `use`, or one that returns unwrapped values instead of refs

**Pattern:**

- Composables: `useCart`, `useMouse` — `use` prefix, return refs
- Files match the composable name

**Why:** The `use` prefix signals Composition-API lifecycle/reactivity rules to callers, and the
naming convention is what lets tooling (and reviewers) recognize a function follows composable
rules (top-level registration, reactive returns). Maps to #19.

## Data Fetching (Nuxt)

### `useAsyncData`/`useFetch` over Bare `$fetch` in Setup (Nuxt docs)

**Check For:** `$fetch` called directly in `<script setup>` top level

**Anti-pattern:**

```ts
// Not keyed: the SSR result is discarded, so the client refetches after hydration
const user = ref(await $fetch('/api/users/1'))
```

**Pattern:**

```ts
// Prefer useFetch for the single-URL case; status over the coarser `pending`.
// useFetch auto-forwards the incoming request's cookies/headers on SSR — no
// manual headers needed here.
const { data: user, status, error } = await useFetch('/api/users/1')
// Reach for useAsyncData(key, fn) only when the source isn't one URL.

// Bare $fetch is correct inside event handlers and server routes, but unlike
// useFetch it does NOT auto-forward cookies/headers — forward them explicitly:
async function save() {
  await $fetch('/api/users/1', {
    method: 'PATCH',
    headers: useRequestHeaders(['cookie']), // manual forwarding (#71)
    body,
  })
}
```

**Why:** `useFetch`/`useAsyncData` register a keyed dependency: the SSR result is serialized
into the payload and reused on the client, and same-key calls dedupe. A bare `$fetch` in setup
is not keyed, so the client refetches after hydration — and unlike `useFetch`, raw `$fetch`
does not auto-forward the incoming request's cookies/headers, so an authenticated server-side
`$fetch` needs `useRequestHeaders(['cookie'])`/`useRequestFetch()` explicitly. Maps to #64, #65, #71.

## State Management (Pinia)

### Keep Store Reactivity via `storeToRefs` (Pinia docs)

**Check For:** Destructuring state/getters straight off the store

**Anti-pattern:**

```ts
const { count, double } = useCounter() // loses reactivity
```

**Pattern:**

```ts
import { storeToRefs } from 'pinia'
const store = useCounter()
const { count, double } = storeToRefs(store) // reactive
const { increment } = store // actions destructure fine
```

**Why:** A store is a `reactive` object; destructuring state/getters snapshots them. Actions
are plain functions and can be destructured directly. Maps to #50.

## Performance

### `shallowRef`/`markRaw` for Large Non-Reactive Data (Vue performance guide)

**Check For:** Large arrays/maps, class instances, or third-party objects wrapped in deep reactivity

**Anti-pattern:**

```ts
const rows = ref(hugeDataset) // deep proxy over every nested object
```

**Pattern:**

```ts
import { shallowRef, markRaw } from 'vue'
const rows = shallowRef(hugeDataset)      // track replacement, not deep mutation
const map = markRaw(new ExpensiveMap())   // never make this reactive
```

**Why:** Deep reactivity walks and proxies every nested property, costing memory and CPU on
large/immutable data. `shallowRef`/`markRaw` skip what doesn't need tracking. Maps to #58.

## Resource Management

### Auto-Cleanup Side Effects (VueUse)

**Check For:** `addEventListener`/`setInterval`/observers/subscriptions without teardown

**Anti-pattern:**

```ts
onMounted(() => window.addEventListener('resize', onResize))
// no onUnmounted — leaks the listener after the component is gone
```

**Pattern:**

```ts
import { useEventListener } from '@vueuse/core'
useEventListener(window, 'resize', onResize) // removed automatically on unmount
```

**Why:** Effects started on mount must stop on unmount or they leak memory and keep firing on
detached components. VueUse helpers tie cleanup to the component scope. A listener attached to an
element owned by the component (rather than `window`/`document`) is garbage-collected with that
node and doesn't need explicit teardown — only global/shared targets do. Maps to #56.

## Testing

### Behavioral Component Test vs Over-Mocked Test (Testing Library principles)

**Check For:** Tests that stub the unit under test or mock so heavily that no real logic runs;
assertions on mock internals instead of rendered output or emitted events

**Anti-pattern:**

```ts
import { mount } from '@vue/test-utils'
import UserCard from './UserCard.vue'

// Stubs the very component under test, and mocks its only real behavior
vi.mock('./UserCard.vue', () => ({ default: { template: '<div />' } }))
const fetchUser = vi.fn().mockResolvedValue({ name: 'Ada' })

it('renders', () => {
  const wrapper = mount(UserCard, { props: { fetchUser } })
  expect(wrapper).toBeTruthy()    // can't fail
  expect(fetchUser).toBeDefined() // asserts the mock, not behavior
})
```

**Pattern:**

```ts
import { mount, flushPromises } from '@vue/test-utils'
import UserCard from './UserCard.vue'

it('shows the user name after load', async () => {
  const fetchUser = vi.fn().mockResolvedValue({ name: 'Ada' })
  const wrapper = mount(UserCard, { props: { userId: 1, fetchUser } })
  expect(wrapper.text()).toContain('Loading') // initial state
  await flushPromises()
  expect(wrapper.text()).toContain('Ada')     // real rendered outcome
})
```

**Why:** The unit under test must actually run. Mock only the boundary (network/IO), not the
component or its logic, and assert what the user sees (rendered text, emitted events).
Maps to #88, #90, #93.

### Assert Negative & Error Paths, Not Just Happy Path

**Check For:** Only the success case tested; no rejection, empty, or boundary coverage

**Anti-pattern:**

```ts
it('loads the user', async () => {
  const wrapper = mount(UserCard, { props: { userId: 1, fetchUser: okFetch } })
  await flushPromises()
  expect(wrapper.text()).toContain('Ada')
})
// nothing covers the failure branch the component clearly has
```

**Pattern:**

```ts
it('shows an error when the fetch rejects', async () => {
  const fetchUser = vi.fn().mockRejectedValue(new Error('boom'))
  const wrapper = mount(UserCard, { props: { userId: 1, fetchUser } })
  await flushPromises()
  expect(wrapper.text()).toContain('Something went wrong') // negative path
  expect(wrapper.emitted('error')).toBeTruthy()
})
```

**Why:** A test that only proves the happy path can't catch the regressions it exists to
prevent. Every branch the code can take — especially error/empty/loading — needs a real
assertion. Maps to #89.

### Playwright Smoke Asserts a User-Visible Outcome (Playwright best practices)

**Check For:** E2E that only navigates or checks element existence, never the result

**Anti-pattern:**

```ts
test('home loads', async ({ page }) => {
  const res = await page.goto('/')
  expect(res?.status()).toBe(200)
  await page.waitForTimeout(2000) // arbitrary sleep
})
```

**Pattern:**

```ts
test('user can search and see results', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('searchbox').fill('vue')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('listitem')).toHaveCount(10) // web-first, auto-retrying
  await expect(page.getByText('Results for "vue"')).toBeVisible()
})
```

**Why:** A 200 status proves the server responded, not that the app works. Drive a real user
flow with role/text locators and web-first assertions (no fixed sleeps), and assert the
observable outcome. Maps to #100, #101.

## Usage in Reviews

**Priority Order** (severity vocabulary: Critical / High / Medium / Low):

1. **Critical:** XSS via `v-html`/untrusted URL bindings; secrets reaching the client
   (`runtimeConfig.public`, payload, `useState`); cross-request state leak (Nuxt
   `useState`/module ref); a broken public contract that ships wrong behavior to every user.
2. **High:** prop mutation breaking data flow; reactivity silently lost (`reactive()`
   destructuring/`await`) causing wrong UI; `v-for` key/index bugs; hydration mismatches;
   uncleaned listeners/timers (leak); missing/broken `v-model` contract; unhandled async
   crashing SSR; navigation guard that doesn't return its redirect.
3. **Medium:** tests that don't test (over-mocking, happy-path-only, snapshot-only,
   can't-fail asserts, mocking `useFetch` past its transform); validation not enforced on
   submit; `any`/`as` on public component contracts; stuck `loading`/`error` state.
4. **Low:** performance hints (`shallowRef`, unbounded lists) with no demonstrated cost;
   subjective complexity/duplication flagged with a concrete named signal; a11y polish; docs.

**When to Report:**

- A Style-Guide priority A/B rule is broken and the failure is concrete (wrong render, leak,
  broken contract, XSS).
- The improvement is measurable (correctness, reactivity, memory, real test coverage).
- Consistent with the project's existing conventions.

**When to Skip:**

- C-level stylistic preference with no behavioral impact.
- A framework-conventional pattern the project has deliberately opted out of.
- Nuxt rules when Nuxt is not present.
- Pre-existing issues outside the diff (note them, don't block on them).
