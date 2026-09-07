---
name: vue-code-review
description: Adversarial Vue code review for .vue single-file components, Vue/Nuxt .ts/.js/.mjs files, package.json changes, and PRs containing Vue code. Orchestrates an adversarial reviewer over the diff against a Vue / Nuxt / TypeScript mistakes catalog (reactivity, component contracts, Pinia, Nuxt SSR, real test coverage), then audits the findings with a findings auditor before reporting. Use whenever reviewing Vue or Nuxt changes, a Vue/Nuxt PR, a component or composable, or assessing Vue/TypeScript implementation quality — even if the request just says "review this component" without naming Vue.
argument-hint: "<pr-url|file-paths|diff> [--no-audit]"
allowed-tools: Agent, Task, Bash, Read, Grep, Glob
---

# Vue Code Review

Orchestrate an adversarial Vue review. The skill resolves the diff, reviews it under the [`vue-code-reviewer`](reviewer.md) mandate beside this file, then runs the [`findings-auditor`](../../agents/findings-auditor.md) agent to red-team the findings before anything reaches the user. Two passes: one attacks the **code**, the next attacks the **findings**.

Focus: Vue + `<script setup>` + Composition API, Nuxt 3/4 when present, pragmatic
TypeScript, and tests that provide real coverage (Vitest for unit/component, Playwright for
e2e/regression/smoke — no superficial tests, no over-mocking, assertions on positive **and**
negative paths).

> **This skill is the standalone path.** It resolves a target, reviews the diff under the mandate
> beside it, and spawns one subagent to audit what it found. The CI review flow does not run this
> skill: a trusted step injects the same mandate into the run's own prompt. Both paths review the
> diff themselves and share the mandate, the catalogs and the auditor; only the dispatch differs.
> See [`docs/decisions/review-pipeline-cost.md`](../../../../docs/decisions/review-pipeline-cost.md).

## Input

Accept any of:

- **Diff file path** → read that file; it is the diff, already taken by the caller
- **GitHub PR URL** → fetch with `gh pr diff <url>` and `gh pr view <url> --json number,title,body,baseRefName,headRefName`
- **File paths** → read the files; use `git diff` (or `git diff <base>...HEAD`) for changes
- **Pasted diff** → use directly

Flags (parse from `$ARGUMENTS`, strip before resolving the target):

- `--no-audit` → skip the findings-audit pass. The code review still runs. Default is to run both.

## Process

### 1. Resolve the target

Take the diff from the path the invocation names, reading it once. Where it names none, determine the diff and the changed Vue-relevant files: `**/*.vue`, plus `.ts`/`.js`/`.mjs`
under Vue/Nuxt source directories, and `package.json`. If nothing Vue-related changed, say so
and stop. For a PR, capture title/body so the reviewer can respect stated intent.

Detect Nuxt so the reviewer scopes Nuxt-only checks: look for `nuxt` in `package.json`
dependencies/devDependencies, a `nuxt.config.{ts,js,mjs}`, a `defineNuxtConfig` call, or a
`.nuxt/` directory. Pass the result to the reviewer as `nuxt_detected: true|false`.

### 2. Adversarial review (you are the reviewer)

Read [reviewer.md](reviewer.md) beside this file and adopt it as your mandate, along with every
catalog it names. Then review the diff yourself, adversarially, over the whole of it however
large it is.

Do not spawn a reviewer subagent. One was spawned here until it was measured: handed the diff
and the mandate the caller already held, it read both a second time and reported back what the
caller could already see. Across three paired runs that boundary cost 31% to 59% of the wall
clock and about half the tokens, for no gain in what was found. The reasoning is in
[`docs/decisions/review-pipeline-cost.md`](../../../../docs/decisions/review-pipeline-cost.md).

Splitting the diff across concurrent reviewers was tried and reverted separately, on arithmetic
recorded in the same file. Split the audit before the review if either is ever worth splitting.

What the mandate needs from you, whether you hold it or hand it on:

- The diff. Take the **path** when the invocation names one and read it once; a pasted diff is
  the whole thing typed again, and what a caller writes is the slowest part of a review.
- The list of changed Vue-relevant files, and the PR title and body when reviewing a PR.
- The catalogs and policies it names, at these paths:

  ```text
  stack_quirks: ${CLAUDE_PLUGIN_ROOT}/skills/vue-code-review/audit-quirks.md
  knowledge_base: ${CLAUDE_PLUGIN_ROOT}/skills/vue-code-review/knowledge-base.md
  real_world_patterns: ${CLAUDE_PLUGIN_ROOT}/skills/vue-code-review/real-world-patterns.md
  review_instructions: ${CLAUDE_PLUGIN_ROOT}/resources/review-instructions.md
  format_policy: ${CLAUDE_PLUGIN_ROOT}/resources/format-policy.md
  ```

- `repo_conventions`, forwarded verbatim when the invocation carries it — a directory of the
  reviewed repository's own convention files, taken from a trusted ref by the caller. Never
  synthesise this path. One pointing into the tree under review would let the reviewed change
  set the terms of its own review, and nothing in the file itself distinguishes a repository's
  conventions from a pull request's instructions to its reviewer. No field, no conventions.

- The tooling and shell constraints the invocation carries. You cannot run this repository's
  tooling — no test runner, build, compile, lint, formatter or package manager — and a catalog
  naming `go test` or `node --test` describes what to look for, never something to run. One
  measured review spent nine of ten denied calls on a test runner. Every Bash call is a single
  plain command, since the allowlist matches the start of the command, so a loop, pipeline,
  `&&` chain, redirection or `git -C <path>` matches nothing.

Produce prioritized findings, each with a severity, a tag and a `relative_file_path:line`
location, and a one-line verdict.

### 3. Findings audit (spawn `findings-auditor` — skip only if `--no-audit`)

The reviewer produces findings; it does not prove them. Spawn a second Agent to red-team them
before the user sees them. This is an independent skeptic, not another review pass — it breaks
false positives, right-sizes severity, kills duplicates, and corrects hallucinated `file:line`
locations.

**Spawn protocol:**

1. Try `subagent_type: "kreview:findings-auditor"`.
2. On unknown subagent type, retry with `subagent_type: "general-purpose"` and prepend the
   auditor's mandate by reading [../../agents/findings-auditor.md](../../agents/findings-auditor.md)
   into the prompt.

The prompt MUST include, verbatim:

- The full set of reviewer findings (every finding with severity, tag, and `file:line`).
- The **path** of the diff file when the invocation names one, never the diff text. Pasting it
  means the whole diff is typed once per subagent, and what an orchestrator writes is the
  slowest part of a review. Paste a diff only when the invocation carried no path, which is how
  a human running this skill by hand usually reaches it.
- The list of changed files.
- The name of the reviewer that produced them, `vue-code-reviewer`, whose severity rubric the auditor enforces.
- Context-field paths so the auditor can re-read the catalog items findings cite, and the Vue traps that make correct code look broken. **Resolve `${CLAUDE_PLUGIN_ROOT}` to its absolute path before putting these in the prompt** — a `general-purpose` fallback subagent does not inherit the plugin env. `stack_quirks` is what makes a shared auditor a Vue one, so it is never the field you drop:

  ```text
  stack_quirks: ${CLAUDE_PLUGIN_ROOT}/skills/vue-code-review/audit-quirks.md
  knowledge_base: ${CLAUDE_PLUGIN_ROOT}/skills/vue-code-review/knowledge-base.md
  real_world_patterns: ${CLAUDE_PLUGIN_ROOT}/skills/vue-code-review/real-world-patterns.md
  ```

- The tooling and shell constraints, verbatim when the invocation carries them. The auditor
  re-verifies each finding against the code, which makes it the agent most likely to reach for a
  test runner or a linter, and every attempt is a denied call that costs a turn. It cannot build,
  compile, test, lint, format or run the code, and every Bash call is a single plain command - a
  loop, pipeline, `&&` chain, redirection or `git -C <path>` matches nothing in the allowlist.

- The instruction: *"Red-team these findings. Default to skepticism. Verify every Critical
  and High against the actual code with Grep/Read. Return your verdict in the required output
  format."*

The auditor returns SHIP / SHIP WITH CHANGES / HOLD, challenged findings
(UPHOLD / DOWNGRADE / REMOVE / REWORD), what survived scrutiny, any escaped bug, and bad locations.

### 4. Fold the verdict in and report

Apply the auditor's verdict before presenting anything:

- REMOVE / DOWNGRADE / REWORD verdicts revise findings in place — never present a contested
  finding without the correction applied.
- Mark "survived scrutiny" findings as high-confidence.
- Promote any escaped bug into the report with proper severity and `file:line`.
- Drop or fix every bad location.
- Recompute the Critical/High counts after applying changes.
- If the verdict was HOLD, lead with it; do not present the contested finding as a blocker
  without its fix.
- Derive the report **Verdict** from the post-audit findings: any surviving Critical/High
  (or an auditor HOLD) → `REQUEST_CHANGES`; no findings and auditor SHIP → `APPROVE`;
  otherwise → `APPROVE_WITH_COMMENTS`.

## Output

```markdown
# Vue Code Review: <target>

## Summary

| Verdict | <APPROVE \| APPROVE_WITH_COMMENTS \| REQUEST_CHANGES> |
| --- | --- |
| Critical/High | <count> |

## Findings
<Findings after the audit pass, ordered by severity, in format-policy format.
Mark high-confidence findings that survived scrutiny.>
```

## Reference

- Vue/Nuxt/TS mistakes catalog: [knowledge-base.md](knowledge-base.md)
- Real-world Vue/Nuxt PR patterns: [real-world-patterns.md](real-world-patterns.md)
- Code reviewer mandate: [reviewer.md](reviewer.md)
- Findings auditor: [../../agents/findings-auditor.md](../../agents/findings-auditor.md)
- Vue traps the auditor applies (`stack_quirks`): [audit-quirks.md](audit-quirks.md)
- Output format & severities: `../../resources/format-policy.md`
- Nuxt MCP server (optional aid when Nuxt is detected): <https://nuxt.com/mcp>
