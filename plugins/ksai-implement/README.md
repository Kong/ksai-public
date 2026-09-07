# ksai-implement

CI-only skills used by the KSAI GitHub workflow to plan, build, test, and fix repository changes.

Do not install or invoke these skills by hand. The workflow fetches the plugin and supplies trusted issue, branch, plan, review-thread, and CI context that a local call does not have.

## User requests

Write `/ksai` and the outcome you want where the work belongs. KSAI routes an issue request to implementation, a review-thread reply to that thread, and a pull request request from its wording.

| Goal | Example | Where | Result |
| :--- | :--- | :--- | :--- |
| Implement an issue | `/ksai build the retry policy described here` | Issue | Builds small work directly or opens a draft pull request with a plan |
| Address all review feedback | `/ksai address all unresolved review feedback` | Pull request | Handles up to 30 open review threads in one pass |
| Address one review remark | `/ksai address this feedback` | Review thread | Changes code when needed and replies in that thread |
| Change the branch | `/ksai add a regression test for the retry race` | Pull request | Completes one focused task with at most one commit |
| Revise a plan | Submit a commented or changes-requested review | Pull request review | Reworks the plan from submitted feedback |
| Release work | Submit an **Approve** review | Pull request review | Releases the reviewed plan or one waiting phase |

KSAI confirms the route before model work starts. Start with the implementation guide, or read request routing.

The plan review and every phase checkpoint need a native GitHub **Approve** review. `/ksai approve` remains an explicit fallback. Post it on the pull request. Set `require_plan_approval: true` to add the same hold before every implementation step.

### Exact controls

Use exact commands for options, compatibility, or a route you do not want classified:

| Command | Result |
| :--- | :--- |
| `/ksai implement --plan` | Requires a plan for one issue request |
| `/ksai approve` | Explicit approval fallback |
| `/ksai fix [scope]` | Handles open review threads |
| `/ksai do <request>` | Completes one focused pull request task |
| `/ksai revise [request]` | Reworks the plan from review feedback |
| `/ksai help` | Lists enabled controls without starting model work |

The request and command reference lists every surface, option, and result.

## CI skills

| Skill | Workflow contract |
| :--- | :--- |
| `ksai-plan` | Writes the plan and reports `{ status, title, summary, reason }` |
| `ksai-step` | Implements one exact plan step and reports `{ status, step, summary, reason }` |
| `ksai-build` | Builds one small issue and reports `{ status, title, summary, reason }` |
| `ksai-fix` | Handles review threads and reports `{ status, threads, summary, reason }` |
| `ksai-do` | Completes one pull request task and reports `{ status, summary, reason }` |

Each skill writes a JSON manifest and holds no GitHub credential. Trusted workflow steps validate the manifest, enforce protected paths, publish commits, and write GitHub comments.

## Skill contracts

- [`ksai-plan`](./skills/ksai-plan/SKILL.md)
- [`ksai-step`](./skills/ksai-step/SKILL.md)
- [`ksai-build`](./skills/ksai-build/SKILL.md)
- [`ksai-fix`](./skills/ksai-fix/SKILL.md)
- [`ksai-do`](./skills/ksai-do/SKILL.md)
