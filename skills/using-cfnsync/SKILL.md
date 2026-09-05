---
name: using-cfnsync
description: Use when operating or investigating the cfnsync CLI (a tool that syncs a directory of raw CloudFormation templates to stacks). Helpful for choosing between status/plan/deploy/graph/import/force-unlock, interpreting exit codes (0/1/2), performing safety checks around deploy, troubleshooting fail-closed / locking / change-set-ownership situations, and assisting with cfnsync.yaml configuration.
---

# Using cfnsync

`cfnsync` is a CLI that syncs a directory of raw CloudFormation templates (YAML/JSON) with AWS stacks. It detects added/modified/deleted templates, creates/diffs/executes change sets, and creates/updates/deletes stacks in dependency order. It targets non-interactive execution in CI (GitHub Actions) and has no template-generation or abstraction layer like CDK.

Use this guide to select and run cfnsync subcommands and interpret their output (exit codes, diffs, and errors) correctly.

## Writing the config file

Read the bundled references whenever reading, writing, or validating `cfnsync.yaml`:

- Parameter reference: [`references/config-reference.md`](references/config-reference.md)
- Commented sample: [`references/examples/cfnsync.sample.yaml`](references/examples/cfnsync.sample.yaml)

The references are distributed with the skill and do not require access to the cfnsync source repository.

## Command usage

Run commands as `cfnsync <command> [options]`. Every subcommand accepts these common options:

| Option | Meaning |
|---|---|
| `--config <path>` | Read configuration from this path (default `./cfnsync.yaml`) |
| `--profile <name>` | Use this AWS shared-config profile |
| `--region <region>` | Override `defaultRegion` (the only way to override it) |
| `--output <text|json>` | Select human-readable or machine-readable output (default `text`) |

`AWS_REGION` / `AWS_DEFAULT_REGION` do not change the region cfnsync targets: the config file is the source of truth, so the stack key `<template-path>@<region>` is identical in every environment. `AWS_PROFILE` is still used when `--profile` is omitted.

Use `--output json` for automation. Run `cfnsync --help` or `cfnsync <command> --help` to verify the options supported by the installed version.

### `status`

```sh
cfnsync status [common options]
```

Compare state with the current templates and report `added`, `modified`, `deleted`, and `unchanged`. This performs no CloudFormation or STS calls; an S3 backend may read state from S3.

### `plan`

```sh
cfnsync plan [common options]
```

Create and describe change sets, print the diff, then delete those change sets without executing them. Review Add/Modify/Remove operations, replacements, and deletion previews. A diff produces exit code `2`.

**`plan` is the only command that previews a diff.** `deploy --dry-run` was removed; use `plan` instead.

### `deploy`

```sh
cfnsync deploy [common options] [--auto-approve] [--allow-delete] \
  [--on-failure <stop|continue>]
```

Detect changes and resolve dependency order, then run in two stages: a **planning stage** that creates and describes a change set for every target (no `ExecuteChangeSet`, no `DeleteStack`), and — after **a single approval for the whole run** — an **execution stage** that executes them in dependency order.

| Option | Meaning |
|---|---|
| `--auto-approve` (`-y`) | Skip the approval prompt and apply directly; **required whenever there is no TTY** |
| `--allow-delete` | Permit deletion of removed stacks; without it, only report deletions |
| `--on-failure <stop|continue>` | Stop after a failure or continue with independent stacks (default `stop`). **Applies to execution-stage failures only** — a planning-stage failure always aborts the whole run |

The approval prompt (`Do you want to perform these actions? [y/N]`) and the approval summary go to stderr; only `y` / `yes` approves. A rejected run deletes every change set it created, reports the unexecuted stacks as `skipped`, adds `cancelled: true` to the deploy report on stdout, and exits `0`. No approval is requested when nothing is scheduled for execution.

**Without a TTY, `deploy` requires `--auto-approve`**: otherwise it stops with a `CliUsageError` (exit `1`) at the CLI boundary, before constructing any AWS client. This also happens when there are no changes at all, because the TTY check precedes change detection. `plan` is exempt — use it when you only want to inspect the diff. `deploy --dry-run` no longer exists: it is rejected as an unknown option (`CliUsageError`, exit `1`).

While approval is pending the state lock stays held, so other runs are blocked with the `s3` backend. The approved diff is **not** guaranteed to match the actual state at execution time — the defense is the re-check performed immediately before each execution, and nothing stronger is claimed. Properties referencing an Export that this same run creates are shown as `{{changeSet:KNOWN_AFTER_APPLY}}`, so their final value is not settled at approval time; do not resolve or guess those values.

### `graph`

```sh
cfnsync graph [common options]
```

Show the per-region dependency graph derived from template exports/imports and explicit `dependsOn` entries. This has no AWS side effects.

### `import`

```sh
cfnsync import [common options] [--reconcile <remote|local>] [--write-template]
```

Adopt existing stacks into config, templates, and state. It only reads CloudFormation stacks, but it writes local config/template files and the configured state backend (including S3), and acquires/releases the S3 state lock when that backend is selected.

| Option | Meaning |
|---|---|
| `--reconcile remote` | Resolve a template difference by replacing the local template with the deployed template |
| `--reconcile local` | Keep the local template and record deployed state so the next plan exposes the difference |
| `--write-template` | Write a deployed template when its local template file does not exist |

Without `--reconcile`, a local/deployed template difference is an error.

### `force-unlock`

```sh
cfnsync force-unlock <runId> [common options]
```

Conditionally release a stale S3 state lock only when it is owned by the specified run ID. First confirm that the prior process or CI job has fully terminated. Never unlock a live run.

## Choosing a subcommand

| Command | Purpose | Side effects |
|---|---|---|
| `status` | Inspect local changes quickly | State read only |
| `plan` | Preview exact CloudFormation changes | Creates and deletes temporary change sets |
| `deploy` | Detect changes, resolve dependency order, create/diff every change set, then execute in dependency order after one approval | Yes. To preview only, use `plan` instead |
| `graph` | Inspect deployment order | State read only |
| `import` | Adopt existing stacks | Reads CloudFormation; writes local config/templates and configured state, and manages an S3 lock when applicable |
| `force-unlock` | Recover from a stale S3 lock | Conditionally deletes the lock |

### Typical workflow

1. **Check the situation**: run `cfnsync status --output json` to see the diff category between templates and state.
2. **Pre-flight check**: run `cfnsync plan` to review the change set's Add/Modify/Remove and any replacement warnings. Always look for destructive changes (replacement, deletion).
3. **Execute**: if it looks fine, run `cfnsync deploy` (with `--allow-delete` when needed) and review the approval summary before answering. In CI, add `--auto-approve` and generally do not fiddle with the other flags — run the command fixed on the repository side.
4. **Understand dependencies**: if inter-template dependencies or deploy order are unclear, check with `cfnsync graph --output json`.
5. **Adopt existing stacks**: to bring a manually-created or externally-managed stack under cfnsync, use `cfnsync import` (`--reconcile remote|local` picks the direction to resolve template diffs; `--write-template` writes the template out locally).
6. **Handle a stale lock**: if `deploy`/`import` aborted and left a lock, **first confirm that the previous run that held the lock (including a CI job) has fully terminated**, then run `cfnsync force-unlock <runId>` with the displayed run ID and re-run. Never release a lock held by a running execution.

## Meaning of exit codes

| Exit code | Meaning |
|---|---|
| `0` | Success (including "no changes" = no diff) |
| `1` | Error (config validation, fail-closed guard, AWS operation failure, etc.) |
| `2` | Diff exists (`plan` only; no actual changes were made) |

CI pipelines branch on these exit codes, so note that `plan` returning `2` is not an "error" — it is the normal case indicating that a diff exists.

## Safety invariants (summary)

cfnsync's mutating operations are designed around the following defense-in-depth layers. Do not weaken or paraphrase these away when explaining or proposing behavior.

- **Fail-closed is the overall policy**: when `allowedAccounts`/`allowedRegions` are absent from config, do not match the STS `GetCallerIdentity` result, or the target account/regions cannot be resolved, mutating operations (change-set creation/execution, stack deletion) are not performed at all and the command exits with an error. It never warns and continues. In addition, state records the connected account ID as `accountId` on the first mutating run (after acquiring the lock), and on subsequent runs it refuses all writes if the STS-resolved result does not match (account switch, misused state file, etc.). This is a guard bound to the state itself, separate from the config-level `allowedAccounts` allow-list.
- **The state backend** follows a Terraform-like design: the default is `local` (single-process), with `s3` for CI. It protects the consistency of the source of truth via generation/ETag compare-and-swap, conditional-write locking on S3, and atomic file replacement. The fencing that re-checks ownership immediately before each side effect is **best-effort** (CloudFormation itself provides no fencing token, so the race window cannot be fully eliminated); strict guarantees come from CAS and per-stack `*_IN_PROGRESS` guards. Do not describe fencing as "strict mutual exclusion".
- **Change-set ownership management**: change-set names are encoded as `cfnsync-<stateID>-<runID>-<timestamp>`, and only change sets with your own stateID may be reclaimed (deleted) automatically. If a change set created by another tool, person, or state exists, execution is blocked (fail-closed). Because `ExecuteChangeSet` is a destructive operation that implicitly deletes other change sets on the same stack, re-check the target change set immediately before executing.
- **Never `DeleteStack` a stack in the `REVIEW_IN_PROGRESS` state.** In that state, recreate a CREATE-type change set instead.
- **The management tag** `cfnsync:state-id=<stateID>` is auto-applied to every stack and is used for the provenance (ownership) check in CREATE recovery (when a stack is judged `added` but already exists). The tag proves only that a run of this state created the stack — never *which input values* it was created with. So CREATE recovery is **fail-closed when any input cannot be verified**: if the template declares a `NoEcho` parameter, or the stack has any `dependsOn`, cfnsync refuses to re-sync even when everything else matches.
- **Planning-stage failures always abort the whole run**, whatever `--on-failure` says: cfnsync never asks for approval of an incomplete plan.
- **Stack deletion** is performed only when `--allow-delete` is explicitly specified, in reverse order of the dependency graph merged from old and new config (dependencies deleted last). If dependency info cannot be reconstructed from state, deletion is refused.

## Troubleshooting hints

- `plan`/`deploy` exits `1` with an error mentioning "allowedAccounts" / "allowedRegions": missing config, or a mismatch of the connected account/region. This is a normal fail-closed refusal, so fix the config or re-run with the correct `--profile`/`--region` (do not work around it by loosening values).
- Errors about "another change set exists": a manual action or another tool created a change set on the target stack. Inspect that change set on the AWS side before executing, execute or delete it, then re-run cfnsync.
- Lock acquisition failure: usually correct behavior (preventing concurrent runs). Do not `force-unlock` without confirming the previous run has truly terminated.
- A `deploy` that fails partway: you may re-run with the same config. Already-succeeded stacks are automatically skipped as unchanged.
- `deploy` exits `1` complaining that there is no TTY: add `--auto-approve` (`-y`). This happens even when there are no changes to apply. Never work around it by faking a TTY.
- `deploy` exits `1` on an `added` stack that already exists and points at `import`: this is the fail-closed CREATE recovery above. **Running `import` alone does not fix it** — `import` rewrites existing `NoEcho` values in the config to `__REQUIRED__`, so the desired secrets are lost and the next `deploy` then stops on the leftover-`__REQUIRED__` check. Correct order: save a copy of `cfnsync.yaml` → `cfnsync import --reconcile local` → restore the `NoEcho` values that were rewritten to `__REQUIRED__` from that copy → `cfnsync plan` → `cfnsync deploy`. Restoring the secret values is manual by design.
