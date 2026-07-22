---
name: using-cfnsync
description: Use when operating or investigating the cfnsync CLI (a tool that syncs a directory of raw CloudFormation templates to stacks). Helpful for choosing between status/plan/deploy/graph/import/force-unlock, interpreting exit codes (0/1/2), performing safety checks around deploy, troubleshooting fail-closed / locking / change-set-ownership situations, and assisting with cfnsync.yaml configuration.
---

# Using cfnsync

`cfnsync` is a CLI that syncs a directory of raw CloudFormation templates (YAML/JSON) with AWS stacks. It detects added/modified/deleted templates, creates/diffs/executes change sets, and creates/updates/deletes stacks in dependency order. It targets non-interactive execution in CI (GitHub Actions) and has no template-generation or abstraction layer like CDK.

This skill is a guide for selecting and running cfnsync subcommands appropriately from Claude Code and interpreting their output (exit codes, diffs, errors) correctly.

## Writing the config file

The parameter list and samples for `cfnsync.yaml` are canonically defined in the following documents in this repository (this skill does not duplicate them — always refer to these when reading or writing the config file):

- Parameter reference: [`../../docs/config-reference.md`](../../docs/config-reference.md)
- Commented sample: [`../../docs/examples/cfnsync.sample.yaml`](../../docs/examples/cfnsync.sample.yaml)

## Choosing a subcommand

Every subcommand accepts the common options `--config <path>` (default `./cfnsync.yaml`), `--profile`, `--region`, and `--output <text|json>`. Use `--output json` when you want machine-readable output.

| Command | Purpose | Side effects on AWS |
|---|---|---|
| `status` | Compare state with the current templates and show `added`/`modified`/`deleted`/`unchanged` | None (read-only) |
| `plan` | Create change sets, show the diff, and exit without executing | Creates change sets only (does not execute) |
| `deploy` | Detect changes, resolve dependency order, create/diff/execute change sets non-interactively | Yes. `--dry-run` limits it to creation and diff only |
| `graph` | Show the dependency graph derived from Export/`Fn::ImportValue` and `dependsOn` | None (read-only) |
| `import` | Adopt an existing stack's config, template, and state | Read-only against AWS. Local config/template/state may be modified |
| `force-unlock <runId>` | Conditionally release a stale lock in S3 state, only when the given run ID matches | Releases the lock only (does nothing if it does not match) |

The common options above and `import`'s `--reconcile`/`--write-template` are a summary of the main ones, not a complete list. To confirm the exact options and usage of each command (which flags exist, their defaults, etc.), run `cfnsync --help` or `cfnsync <subcommand> --help` (e.g. `cfnsync deploy --help`). That is the source of truth; when in doubt, check `--help` first rather than assembling options by guesswork.

### Typical workflow

1. **Check the situation**: run `cfnsync status --output json` to see the diff category between templates and state.
2. **Pre-flight check**: run `cfnsync plan` to review the change set's Add/Modify/Remove and any replacement warnings. Always look for destructive changes (replacement, deletion).
3. **Execute**: if it looks fine, run `cfnsync deploy` (with `--allow-delete` when needed). In CI, generally do not fiddle with flags — run the command fixed on the repository side.
4. **Understand dependencies**: if inter-template dependencies or deploy order are unclear, check with `cfnsync graph --output json`.
5. **Adopt existing stacks**: to bring a manually-created or externally-managed stack under cfnsync, use `cfnsync import` (`--reconcile remote|local` picks the direction to resolve template diffs; `--write-template` writes the template out locally).
6. **Handle a stale lock**: if `deploy`/`import` aborted and left a lock, **first confirm that the previous run that held the lock (including a CI job) has fully terminated**, then run `cfnsync force-unlock <runId>` with the displayed run ID and re-run. Never release a lock held by a running execution.

## Meaning of exit codes

| Exit code | Meaning |
|---|---|
| `0` | Success (including "no changes" = no diff) |
| `1` | Error (config validation, fail-closed guard, AWS operation failure, etc.) |
| `2` | Diff exists (`plan`, and `deploy --dry-run` only; no actual changes were made) |

CI pipelines branch on these exit codes, so note that `plan` returning `2` is not an "error" — it is the normal case indicating that a diff exists.

## Safety invariants (summary)

cfnsync's mutating operations are designed around the following defense-in-depth layers. Do not weaken or paraphrase these away when explaining or proposing behavior.

- **Fail-closed is the overall policy**: when `allowedAccounts`/`allowedRegions` are absent from config, do not match the STS `GetCallerIdentity` result, or the target account/regions cannot be resolved, mutating operations (change-set creation/execution, stack deletion) are not performed at all and the command exits with an error. It never warns and continues. In addition, state records the connected account ID as `accountId` on the first mutating run (after acquiring the lock), and on subsequent runs it refuses all writes if the STS-resolved result does not match (account switch, misused state file, etc.). This is a guard bound to the state itself, separate from the config-level `allowedAccounts` allow-list.
- **The state backend** follows a Terraform-like design: the default is `local` (single-process), with `s3` for CI. It protects the consistency of the source of truth via generation/ETag compare-and-swap, conditional-write locking on S3, and atomic file replacement. The fencing that re-checks ownership immediately before each side effect is **best-effort** (CloudFormation itself provides no fencing token, so the race window cannot be fully eliminated); strict guarantees come from CAS and per-stack `*_IN_PROGRESS` guards. Do not describe fencing as "strict mutual exclusion".
- **Change-set ownership management**: change-set names are encoded as `cfnsync-<stateID>-<runID>-<timestamp>`, and only change sets with your own stateID may be reclaimed (deleted) automatically. If a change set created by another tool, person, or state exists, execution is blocked (fail-closed). Because `ExecuteChangeSet` is a destructive operation that implicitly deletes other change sets on the same stack, re-check the target change set immediately before executing.
- **Never `DeleteStack` a stack in the `REVIEW_IN_PROGRESS` state.** In that state, recreate a CREATE-type change set instead.
- **The management tag** `cfnsync:state-id=<stateID>` is auto-applied to every stack and is used for the provenance (ownership) check in CREATE recovery (when a stack is judged `added` but already exists).
- **Stack deletion** is performed only when `--allow-delete` is explicitly specified, in reverse order of the dependency graph merged from old and new config (dependencies deleted last). If dependency info cannot be reconstructed from state, deletion is refused.

## Troubleshooting hints

- `plan`/`deploy` exits `1` with an error mentioning "allowedAccounts" / "allowedRegions": missing config, or a mismatch of the connected account/region. This is a normal fail-closed refusal, so fix the config or re-run with the correct `--profile`/`--region` (do not work around it by loosening values).
- Errors about "another change set exists": a manual action or another tool created a change set on the target stack. Inspect that change set on the AWS side before executing, execute or delete it, then re-run cfnsync.
- Lock acquisition failure: usually correct behavior (preventing concurrent runs). Do not `force-unlock` without confirming the previous run has truly terminated.
- A `deploy` that fails partway: you may re-run with the same config. Already-succeeded stacks are automatically skipped as unchanged.

For more detailed command options, GitHub Actions usage, and manual verification steps, see the repository's [`README.md`](../../README.md).
