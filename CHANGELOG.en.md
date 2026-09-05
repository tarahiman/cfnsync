[日本語](./CHANGELOG.md) | English

# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). **Breaking changes are allowed while on 0.x.**

## Unreleased

`deploy` now defaults to "create every change set → show every diff → one yes/no approval for the whole run → execute everything in dependency order" (like `terraform apply`). **CI users are always affected.** Read breaking changes 1 and 2 first.

### Breaking changes

#### 1. `--confirm` removed (replaced by `--auto-approve` / `-y`)

- **Before**: executed without confirmation by default; `--confirm` asked for confirmation on a TTY.
- **After**: approval is requested by default. `--confirm` is now an unknown option and produces a `CliUsageError` (exit code `1`). To skip the approval, pass `--auto-approve` (short form `-y`). `--auto-approve` is specific to `deploy` and is not offered on any other subcommand.

**Migration**:

```sh
# Before: confirm on a TTY, then execute
cfnsync deploy --confirm
# After: approval is the default, so no flag is needed
cfnsync deploy

# Before: execute without confirmation (the default)
cfnsync deploy
# After: state explicitly that you are skipping approval
cfnsync deploy --auto-approve
```

#### 2. `deploy` without a TTY requires `--auto-approve`

- **After**: running `deploy` without `--auto-approve` in an environment that has no TTY (CI in particular) stops with a `CliUsageError` (exit code `1`). The rejection happens at the CLI boundary, so there are no side effects at all — not even an AWS client is constructed, and the state backend is never touched. With `--output json`, stdout carries the `CliUsageError` payload.
- **A run with no changes at all fails the same way.** The TTY check runs before change detection, so you cannot assume "there is no diff, therefore it still exits `0`".
- `plan` never asks for approval and is exempt; it keeps working without a TTY. Use `plan` when you only want to inspect the diff (`deploy --dry-run` was removed — see breaking change 9).

**Migration**: add `--auto-approve` to `deploy` in your CI workflow. **Forgetting this breaks the deploy job.**

```yaml
# Before
- run: npx @tarahi/cfnsync deploy --no-color
# After
- run: npx @tarahi/cfnsync deploy --auto-approve --no-color
```

#### 3. Replaced output contract for a rejected approval

- **Before**: rejecting the approval printed a dedicated payload `{"exitCode": 0, "cancelled": true, "message": "Deployment cancelled."}` to stdout under `--output json`, and in text mode printed only `Deployment cancelled.` to stderr with nothing on stdout.
- **After**: a rejected run also prints exactly one ordinary deploy report to stdout, with `cancelled: true` added to that report. **The dedicated payload's `exitCode` and `message` fields are gone.** In text mode, stderr still gets `Deployment cancelled.` and stdout additionally gets the report. The exit code is still `0`.
- Runs that were not rejected have no `cancelled` field at all (compatible with the existing schema).

**Migration**: scripts that detect a rejection should stop reading `.exitCode` / `.message` and read `.cancelled` instead. The stacks that were not executed are recoverable from existing deploy-report fields (`stacks[].outcome` is `skipped`).

#### 4. `--on-failure` narrowed to the execution stage

- **Before**: even a **planning-stage** failure, such as a leftover `__REQUIRED__` placeholder, marked dependent stacks as `skipped` while independent stacks were still executed according to `--on-failure continue`.
- **After**: a planning-stage failure aborts the entire run regardless of the `--on-failure` value (exit code `1`). `--on-failure stop|continue` applies **only to execution-stage failures**.
- This is not merely "clarifying a scope that was always execution-only". The previous `docs/spec/design.md` §8.2 explicitly described a leftover `__REQUIRED__` as a "planning failure" occurring "before any AWS side effect", and specified that "only independent stacks follow `--on-failure`". **This genuinely narrows the meaning of a public option.**
- The rationale: never ask for approval of irreversible operations against an incomplete plan. The behavior does not differ under `--auto-approve` either — an incomplete plan is dangerous regardless of whether approval was requested.

**Migration**: if you relied on `--on-failure continue` to make partial progress, resolve the planning-stage failure first (a leftover `__REQUIRED__`, a change-set creation failure, and so on) and re-run. Split the config file if you need separate execution units. A dedicated degraded-execution option may be considered later; it is out of scope for this release.

#### 5. Unverifiable CREATE recovery is now fail-closed

This applies to the automatic re-sync path taken when a previous run succeeded at `CreateStack` but was interrupted before saving state — that is, when a stack classified as `added` already exists in AWS.

- **Before**: `NoEcho` parameters and `dependsOn` were excluded from the comparison, and cfnsync warned and then recorded the local desired values into state as a re-sync.
- **After**: if the target template declares a `NoEcho` parameter, or the stack has one or more `dependsOn` entries, cfnsync does not re-sync and treats the target as a failure (exit code `1`) — even when the management tag, template, visible parameters, tags, and capabilities all match.
- **Rationale**: the real value of a `NoEcho` parameter cannot be retrieved from AWS, so it cannot be verified. If you changed a `NoEcho` value after the interruption, the old behavior recorded the new, not-yet-applied value as "applied", the next detection reported `unchanged`, and **the change was lost permanently**.

**Recovery procedure**: running `cfnsync import` alone does *not* fix this. **`import` unconditionally rewrites existing `NoEcho` values in the config file to `__REQUIRED__`**, so you lose the secret values you intended, and the next `deploy` stops on the leftover-`__REQUIRED__` check. Follow this order instead:

1. Save a copy of `cfnsync.yaml` (the desired `NoEcho` parameter values are about to be lost).
2. Run `cfnsync import --reconcile local` (keep the local template and record the deployed side's hash into state).
3. Restore the `NoEcho` parameters that `import` rewrote to `__REQUIRED__` back to the desired values from your saved copy.
4. Review the diff with `cfnsync plan`.
5. Run `cfnsync deploy`.

**Known limitation**: this recovery requires restoring the secret values by hand. That is a structural consequence of AWS never returning the real value of a `NoEcho` parameter (only a masked one), and it is deliberately not automated.

#### 6. Configurations resolving to the same (region, stack name) are rejected

If several templates resolve to the same `stackName` in the same region, cfnsync rejects the configuration with a `ConfigError` (exit code `1`) before touching AWS. The same applies when a template-path change makes "delete (from old state) + create (from new config)" point at the same (region, stack name): cfnsync fails closed before any AWS side effect and points you at a rename-based migration. Renaming to a *different* stack name, and spreading the same `stackName` across several regions, remain allowed.

#### 7. Changed text rendering for change sets with zero resource differences

When a change set succeeds but contains zero CloudFormation resource differences — for example when only Outputs / Exports changed — the text output changes from `(変更なし)` ("no changes") to a note stating that there are zero CloudFormation resource differences and that non-resource changes such as Outputs may be included. **Such targets are still executed** (skipping them would leave the Export uncreated, breaking any downstream stack that uses `Fn::ImportValue`). The distinction is made in the renderer only, so **the JSON output is unchanged** (`operation` stays `update`, `warnings` stays empty). If you use text output as a regression baseline, allow for this difference.

#### 8. `AWS_REGION` / `AWS_DEFAULT_REGION` no longer override the default region

- **Before**: the target region was resolved as `--region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `defaultRegion` from the config file. With one of those variables set, the same config file produced a different stack key `<template-path>@<region>` — that is, a different unit of management.
- **After**: the target region comes from `--region` (when given) or `defaultRegion`, and nothing else. `AWS_REGION` / `AWS_DEFAULT_REGION` are never used to resolve it (they only affect the AWS SDK's own default region resolution). `AWS_PROFILE` is still read when `--profile` is omitted.
- **Rationale**: when an environment variable silently changes the stack key, a multi-region setup that passes the `allowedRegions` fail-closed check plans the region recorded in state as a deletion and the environment variable's region as an addition. The managed targets swap without any config change, so the config file is the source of truth for the region and only an explicit CLI flag may override it.
- The acceptance criteria retire the former FR-7-3 (an implicit ID: "the region can be given as a CLI option, an environment variable, or in the config file") and replace it with FR-7-9a–FR-7-9d. The old ID is never reused.

**Migration**: if you switched cfnsync's target region with `AWS_REGION` / `AWS_DEFAULT_REGION`, replace it with one of the following. **Runs that relied on those variables alone now target the region from the config file.**

```sh
# Before: switch the target region with an environment variable
AWS_REGION=us-east-1 cfnsync plan
# After (a): state it explicitly on the CLI
cfnsync plan --region us-east-1
# After (b): make the config file the source of truth (express multiple regions with stacks.<template>.regions / regionOverrides)
```

After migrating, run `cfnsync status` and confirm that the region in the `STACK KEY` column is the one you intend and that no unexpected `added` / `deleted` entries appear.

#### 9. `deploy --dry-run` removed (diff preview consolidated into `plan`)

- **Before**: `cfnsync deploy --dry-run` stopped after creating change sets and printing the diff, duplicating the purpose and the execution path of `cfnsync plan` as a second public option.
- **After**: `--dry-run` is gone from `deploy`. `cfnsync deploy --dry-run` is rejected as an unknown option with a `CliUsageError` (exit code `1`) and no longer appears in `deploy --help`. **Diff previews are consolidated into `cfnsync plan`.**
- **Rationale**: it never asked for approval, exited `2` on a diff, and accepted the common options and `--no-color` — exactly like `plan`. Adding `--allow-delete` deleted nothing during a dry run, so the deletion preview meant the same thing as in `plan`, and `--on-failure` only applies to the execution stage. Two public paths for one purpose multiplied the branches in the docs, the exit-code explanation, and the approval guard, and left users unsure which to use.

**Migration**: replace `deploy --dry-run` with `plan`. **Without this change the command fails with exit code `1`.**

```sh
# Before: inspect the diff only
cfnsync deploy --dry-run
# After
cfnsync plan

# Before: inspect the diff including deletions
cfnsync deploy --dry-run --allow-delete
# After (--allow-delete was a no-op during a dry run; plan shows deletion previews too)
cfnsync plan
```

- **Acceptance criteria**: the former `FR-5-3` (`--dry-run` stops after the diff) and `FR-5-9b` (`--dry-run` follows the same change-set lifecycle as `plan`) are retired and replaced by `FR-5-20a`–`FR-5-20d`, which are written in terms of `plan`. `FR-12-8d` is new and requires `deploy --dry-run` to be an unknown option; `FR-5-20e` / `FR-5-20f` are new and remove the execution notice and the `skipped` progress line from `plan`'s deletion preview. Retired IDs are never reused.
- **Internals**: `plan` still calls the same `usecase/deploy` implementation with the internal `DeployOptions.dryRun` flag. Removing the public option and reorganizing the internals are separate decisions; splitting them now would duplicate the Phase A safety invariants (leftover change-set ownership checks, `REVIEW_IN_PROGRESS` protection, fencing, CAS), so it is deliberately out of scope (see `docs/spec/design.md` §5.3.5).
- **Output change**: `plan` no longer emits the execution notice on deletion previews (formerly `dry-run のため削除を実行しません`). It disappears from both the text output and the `warnings` array of `--output json`. `plan` never executes anything (`FR-5-20b`), so annotating only the delete targets with "will not run" was inconsistent with the `create` / `update` targets that are equally not executed, and it was boilerplate noise for CI scripts reading the JSON. That a stack is a delete target is still carried by the delete-specific line in the text diff (`FR-5-7e`), and the origin of a pending deletion by the `FR-6-11` warning. For the same reason `plan` no longer emits the `skipped` progress line (stderr) for delete targets; the `DeployReport` `outcome` stays `skipped`, so the JSON is unchanged.
- **`deploy` output is unchanged**: without `--allow-delete` you still get the `削除対象です。実削除には --allow-delete が必要です` warning and its `skipped` progress line. The error message shown when no approval channel is available now points at `cfnsync plan` instead of `--dry-run`.

#### 10. State schema v3 and pending stack deletions

Fixes a bug where renaming `stackName` and leaving the old stack undeleted dropped that stack from state, so it **never reappeared as a deletion candidate** ([Issue #16](https://github.com/tarahiman/cfnsync/issues/16)). Tracking those stacks required a new state field, so **the state schema moves from `2` to `3`.**

- **Before**: a `stackName` change is planned as "delete the old name + create the new name", but saving the successful creation under the same stack key erased the old stack name. Whether the deletion was never attempted (no `--allow-delete`), refused (termination protection), or failed (`DeleteStack`, the completion wait, or the post-deletion state save), nothing was left to retry from. On later runs both the config and the state pointed at the new name, so the entry was `unchanged` and the orphaned stack never came back as a deletion candidate.
- **After**: the save that records a successful creation of the new stack name also records the old stack name under `pendingDeletions` **in the same compare-and-swap**. A pending deletion is removed only once the physical stack is actually deleted (or confirmed absent from CloudFormation). Until then it keeps showing up in `status` / `plan` / `deploy` as a deletion candidate.
- Pending deletions go through **exactly the same safeguards as any other deletion**: `--allow-delete` is required, deletion follows the reverse order of the merged dependency graph, deletion is refused when the dependency information cannot be reconstructed, termination protection is never cleared automatically, `DeleteStack` is never called on a `REVIEW_IN_PROGRESS` stack, the `stackId` must match, and both fencing and compare-and-swap still apply, as does the connection guard.
- The rationale and the alternatives are recorded in [ADR-0003](./docs/decisions/0003-pending-stack-deletions.md) and the change proposal [0001](./docs/changes/0001-pending-stack-deletions.md).

**Migration**: nothing to do. `schemaVersion: 1` / `2` state files are still read, are treated as having no pending deletions, and are normalized to `3` on the first successful save.

**The downgrade is one-way.** Once a state file has been saved as `schemaVersion: 3`, older cfnsync versions reject it with `StateCorruptionError` (they only accept `1` / `2`). If you must roll back, recover with one of:

- `s3` backend: restore the previous object version from bucket versioning
- `local` backend: restore from `cfnsync.state.json.bak`
- Manual edit: set `schemaVersion` back to `2` and drop `pendingDeletions` (**the tracked pending deletions are lost and the orphaning in Issue #16 comes back**)

**Output changes**: pending deletions appear as the existing `deleted` change type / `delete` operation. **No new JSON fields were added.** Their stack key uses the reserved prefix form `cfnsync:pending/<stack name>@<region>`, and `plan` / `deploy` diffs carry a warning naming the originating stack key. Confirming that a pending deletion's stack is gone is disclosed through the existing `deleted-absent` kind in `reconciliations`. If you baseline text output for regressions, expect these extra lines.

**Configuration constraint**: to keep that stack-key namespace collision-free, **template paths starting with the reserved prefix `cfnsync:` are now rejected with a `ConfigError` (exit code `1`).** Rename such paths if you have any.

**Other behavior change**: with `--on-failure continue`, a run could previously delete the old stack even though creating the renamed stack had failed. The old stack is now deleted only when the successful creation of its counterpart is already recorded in state.

**Adversarial-review fix (`FR-6-9a` / `FR-6-13`)**: the "deleted only when the counterpart's successful creation is already recorded in state" check above initially verified only "does a pending deletion with this id exist", and a pending deletion's id is derived solely from its physical stack name and region. **An unrelated pending deletion left behind by an older, unrelated rename (or a prior run's leftover) that happens to share the same stack name would satisfy that check, letting the tool wrongly conclude "this run's paired create succeeded" and delete the old stack of a rename whose new stack had actually failed to create.** A related gap let a pending deletion's physical stack be deleted even when `import` had since brought that same physical stack back under live management at a different template path. Both are fixed: the tool now also verifies that the pending deletion's `originStackKey` matches this run's own pair (`FR-6-9a`), and that the target `stackId` is not currently held by another `stacks` key (`FR-6-13`), immediately before `DeleteStack`. No public API changes; this only adds refusal cases (new error messages).

### Added

- `--auto-approve` (`-y`) on `deploy`.
- The approval summary is printed to stderr (even under `--output json`, so the single-JSON-document contract on stdout is preserved). It follows the same coloring rules as the diff itself and can be decolorized with `--no-color` / `NO_COLOR`. Real `NoEcho` values are masked by the same redactor used for diffs.
- `reconciliations` in the deploy JSON report. It appears only in runs where a re-sync occurred (empty change set confirmed, already-deleted stack confirmed, CREATE recovery) and machine-readably discloses the `stackKey`, the kind of re-sync, and whether state was updated. Runs without a re-sync are unaffected, so existing consumers are not impacted. The same information is listed in the text output.

### Changed

- The state lock is held for the entire time approval is pending. With the `s3` backend, other runs are blocked meanwhile, which means the lock's hold time depends on a human's response time rather than on execution time. Keep this in mind for interactive approval workflows (there is no approval timeout).
- The re-check performed immediately before execution is fixed to the order `DescribeStacks` → `ListChangeSets` → lock-ownership verification (fencing) → `ExecuteChangeSet`. Because waiting for approval is a race window of arbitrary length, planning-stage check results are not reused; each target is re-checked immediately before its own execution. `UPDATE` is restricted to an allowlist of executable terminal states, so a transition to something like `ROLLBACK_COMPLETE` while approval was pending is not missed.
- **The diff you approved is not guaranteed to match the actual state at execution time.** A change set is a snapshot taken at creation time, and the re-checks above are the whole of the defense. They narrow the race window but do not close it, and cfnsync claims nothing stronger.
- When approval is rejected, or the planning stage fails, every change set created so far is deleted. The `REVIEW_IN_PROGRESS` stack shell produced by creating a CREATE-type change set for a new stack does remain in AWS (the safety invariants forbid calling `DeleteStack` on a shell). The shell is reclaimed on the next run, which recreates a CREATE-type change set on top of it and converges. Now that the approval flow is the default, these shells occur more often.

### Known properties

- **Properties that reference an Export created by this very run do not have a final value at approval time.** `Fn::ImportValue` is not resolved when the change set is created; it is held as `{{changeSet:KNOWN_AFTER_APPLY}}` (references to an Export that already exists do resolve to the real value at creation time). cfnsync presents that pending marker as-is and never resolves or fills it in itself. This is the same property as terraform's "known after apply".

## 0.1.0 — 2026-07-26

Initial release.
