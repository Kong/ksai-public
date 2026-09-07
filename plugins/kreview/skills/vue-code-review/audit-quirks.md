# Vue audit quirks

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Read by the `findings-auditor` agent as its `stack_quirks` field, and by nothing else. Vue has real version-specific behavior that looks like a bug but isn't, so every item here is a reason to REMOVE or DOWNGRADE a finding that would otherwise read as sound.

## Scope

A Nuxt finding on a non-Nuxt repo is out of scope — a low-severity note at most, never a block.

## Evidence to check before upholding

If a finding claims a missing cleanup, read the `onUnmounted` / setup body. If it claims lost reactivity, trace whether the value is a ref or a snapshot. A wrong `file:line` includes the wrong half of a single-file component: template against `<script>` block, and the right SFC.

A reactivity/contract/security finding must name the input, render, or interaction that triggers it.

## Catalog items whose own text already answers the finding

Most of this is spelled out directly in the catalog item the finding cites — re-read that item's own text before upholding:

- **#1** — props destructuring is reactive in 3.5+.
- **#6** — flush timing only matters when the callback touches the DOM.
- **#9** / **#19** — a top-level `await` in `<script setup>` restores context; the restriction is Options API / async callbacks only.
- **#29** — prop "mutation" of a parent-shared `reactive`/`defineModel` value is a judgment call, not automatic.
- **#33** — index keys are fine on static/append-only lists.
- **#50** — `storeToRefs` against destructuring actions.
- **#64** — `$fetch` is correct in handlers, watchers, lifecycle hooks and server routes; wrong at setup top level.
- **#71** — `useFetch`/`useAsyncData` auto-forward cookies/headers on SSR for same-origin/relative URLs. The real gap is a bare `$fetch` or a cross-origin `useFetch` call that needs explicit forwarding.
- **#83** — `as const` and a single justified narrowing are not YOLO casts.
- **#117** — `useFetch`/`useAsyncData` route rejections into `error` rather than throwing.
- **#121** — a static/hardcoded `v-html` is not XSS.
- **#154** — a Teleport stacking claim is real only if an ancestor actually has `transform`/`filter`/`perspective`, or SSR without `<ClientOnly>`. Confirm the ancestor's styles, don't assume.

An existing `:max`/`defineOptions` on a `<KeepAlive>` claim, an existing `AbortController` on an async-watcher claim, and a `v-memo` subtree that doesn't actually contain the `v-model` it's accused of breaking each kill the finding that cites them.

## Items that need more than a re-read

- **Write-in-read-primitive (#149) and its `onUpdated` sibling (#152).** Same failure class — a write that re-triggers the read/render it's inside. For #149, evaluate the infinite-loop and wrong-state dimensions independently per the checklist in `real_world_patterns`: a clean verdict on one does not downgrade the other, and "no current callers pass a foreign argument" only downgrades the wrong-state dimension, never the infinite-loop dimension. #152 has no foreign-argument/wrong-state dimension — evaluate it on reachability alone: is the mutation actually inside `onUpdated`/`updated`, and does it touch state the same render reads?
- **Complexity, refactor and comment claims (#143-#148, #35, #39).** The catalog's own preamble already requires a concrete named signal (line, prop, branch or duplication count).
