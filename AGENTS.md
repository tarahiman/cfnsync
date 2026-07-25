# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cfnsync** — a minimal CLI tool that syncs a directory of raw CloudFormation templates to stacks: it detects template add/modify/delete, creates/diffs/executes change sets, and creates/updates/deletes stacks in dependency order. Purpose: ease IaC operation of legacy products that run on hand-written CloudFormation. It deliberately is *not* a new IaC abstraction (no CDK-like layer, no template generation). Target runtime is CI (GitHub Actions, non-interactive); the repository and tool are both named `cfnsync`.

The user communicates in Japanese, and all spec documents are written in Japanese.

## Current state: implemented (T-01..T-21 complete)

The implementation is complete and lives in `src/` with the full acceptance-test suite in `test/` (all green; run it before and after any change). The project follows **spec-driven TDD**:

1. `docs/spec/requirements.md` — requirements FR-1..FR-13 / NFR-1..NFR-6 with EARS-style (WHEN/IF) acceptance criteria. **Each acceptance criterion maps 1:1 to a test case.**
2. `docs/spec/design.md` — approved design (survived 9 rounds of adversarial review). Decides: TypeScript/Node.js 24+, npm distribution, commander/yaml/zod/vitest/aws-sdk-client-mock, ports & adapters architecture.
3. `docs/spec/tasks.md` — TDD task breakdown (T-01..T-21) with the acceptance-criteria → test-case mapping table; its checklist reflects completion status.

Do NOT re-scaffold or ignore existing code; extend it.

The specs are the source of truth. Any behavior change must be reflected in requirements.md/design.md **before** implementation. Both documents have been hardened through repeated adversarial review (Codex, via the `/codex:adversarial-review` command); significant spec changes should be re-reviewed the same way.

## Commands

Use pnpm 11.2.2. Tests must not require real AWS access.

- `pnpm install` — install dependencies
- `pnpm run build` — type-check + emit to `dist/` (`tsc`)
- `pnpm test` — full Vitest suite (`vitest run`); `pnpm vitest run <file>` for one file
- `pnpm run lint` — Biome check + `scripts/check-control-chars.mjs`
- `pnpm run format` / `pnpm run format:check` — Biome format (write / verify-only)
- `pnpm run quality:check` — the full gate CI mirrors: skill-reference check → format check → lint → tests → build. Run this before considering a change done.
- `pnpm run hooks:setup` — one-time: install pinned Gitleaks + the tracked `.githooks` pre-commit hook (secret scan + code checks on staged changes)

Biome is the linter/formatter (single quotes, 2-space indent); see `biome.json` for the disabled rules. It ignores `docs/`, `README.md`, `dist/`, `.claude/`.

## Architecture (from design.md — read it before implementing)

Ports & adapters; dependency direction is `cli → usecase → core / ports / report`, with `aws` implementing `ports`:

- `src/core/` — **pure logic, no AWS SDK imports**: config loading/validation (zod), state management, change detection, template parsing (CFN short-form YAML tags), dependency graph (Export/ImportValue → topological sort), planning. Most acceptance tests land here as plain unit tests.
- `src/ports/` — `CloudFormationGateway` / `StsGateway` / `StateBackend` interfaces.
- `src/aws/` — AWS SDK v3 implementations (CloudFormation, STS, S3 state backend), tested with `aws-sdk-client-mock`.
- `src/backend/` — `local` `StateBackend` implementation (O_EXCL lock + atomic temp-file replace); the `s3` backend lives in `src/aws/`.
- `src/report/` — output contract: `renderText`/`renderJson` rebuild only whitelisted fields from a `DeployReport`, applying NoEcho redaction (NFR-4) as defense-in-depth. `report` may read `core` types but nothing depends back on it.
- `src/usecase/` — command orchestration: guard (account verification), executor (change set lifecycle), deploy/delete/import, fencing, force-unlock, status/graph, redactor, cliBoundary.
- `src/cli/` — thin commander definitions. Subcommands: `status`, `plan`, `deploy`, `graph`, `import`, `force-unlock`.

Unit of management is the **stack key** `<template-path>@<region>` (multi-region: one template can deploy to several regions with per-region parameter/tag overrides).

## Safety invariants (do not weaken these in code or spec)

These came out of adversarial review and are load-bearing; see requirements.md FR-1/FR-2/FR-6/FR-7 and design.md §4.5/§7/§8 for full detail:

- **Fail-closed everywhere**: mutations require `allowedAccounts`/`allowedRegions` config + STS `GetCallerIdentity` match; state is bound to a single AWS account; unverifiable situations abort, they don't warn-and-continue.
- **State backend** is Terraform-style (`local` default / `s3` for CI) with generation/ETag compare-and-swap, S3 conditional-write locking, atomic file replacement. Fencing (ownership re-check before every side effect) is explicitly **best-effort**; strict guarantees live in CAS + per-stack `*_IN_PROGRESS` guards. Don't claim stronger guarantees than the spec does.
- **Change set ownership**: names encode `cfnsync-<stateID>-<runID>-<timestamp>`; only own-stateID change sets may be cleaned up; foreign change sets (other tools/humans/other state) block execution — `ExecuteChangeSet` implicitly deletes all other change sets on a stack, so re-inspect immediately before executing.
- **Never `DeleteStack` a `REVIEW_IN_PROGRESS` stack**; recreate a CREATE-type change set on it instead.
- **Management tag** `cfnsync:state-id=<stateID>` is auto-applied to every stack and is the provenance check for CREATE recovery (`added` but stack already exists).
- Stack deletion only with `--allow-delete`, in reverse order of the merged old+new dependency graph, refusing when dependency info can't be reconstructed from state.

## Exit codes

`0` success (including no changes) / `1` error / `2` diff exists (plan/dry-run only). CI depends on these.
