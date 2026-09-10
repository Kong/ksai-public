# kreview

Adversarial code review skills for local Claude Code sessions and KSAI review workflows.

## How review works

Each skill runs two passes:

1. The calling agent reviews the diff against the selected stack's defect catalog
2. The shared `findings-auditor` attacks those findings, removes false positives and duplicates, and corrects severity

Pass `--no-audit` only when you want the raw first pass. The skills inspect code but never edit it.

## Install

Add the [KSAI marketplace](../../README.md), then run:

```console
/plugin install kreview@ksai
```

## Choose a reviewer

| Skill | Use it for |
| :--- | :--- |
| `go-code-review` | Go files, modules, and pull requests |
| `lua-code-review` | Lua, OpenResty and Kong Gateway plugins, rockspecs, and Test::Nginx suites |
| `vue-code-review` | Vue, Nuxt, and related TypeScript or JavaScript |
| `nestjs-code-review` | NestJS services, modules, controllers, and dependencies |
| `typescript-code-review` | TypeScript or JavaScript outside Vue and NestJS |
| `default-code-review` | Any stack without a dedicated reviewer |

## Run a review

Pass a pull request URL, file paths, or a pasted diff:

```console
/go-code-review <pr-url|file-paths|diff> [--no-audit]
/lua-code-review <pr-url|file-paths|diff> [--no-audit]
/vue-code-review <pr-url|file-paths|diff> [--no-audit]
/nestjs-code-review <pr-url|file-paths|diff> [--no-audit]
/typescript-code-review <pr-url|file-paths|diff> [--no-audit]
/default-code-review <pr-url|file-paths|diff> [--no-audit]
```

Matching skills can also trigger from a plain request such as “review this component.” The default reviewer handles files that match no dedicated stack.

## Contracts

- [`findings-auditor`](./agents/findings-auditor.md)
- [`go-code-review`](./skills/go-code-review/SKILL.md)
- [`lua-code-review`](./skills/lua-code-review/SKILL.md)
- [`vue-code-review`](./skills/vue-code-review/SKILL.md)
- [`nestjs-code-review`](./skills/nestjs-code-review/SKILL.md)
- [`typescript-code-review`](./skills/typescript-code-review/SKILL.md)
- [`default-code-review`](./skills/default-code-review/SKILL.md)
