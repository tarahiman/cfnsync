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
- `deploy --dry-run` and `plan` never ask for approval and are exempt; they keep working without a TTY.

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
