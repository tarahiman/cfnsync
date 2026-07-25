[日本語](./README.md) | English

# cfnsync

> Sync a directory of raw AWS CloudFormation templates to stacks — detect changes, diff and execute change sets, and deploy in dependency order.

[![npm version](https://img.shields.io/npm/v/@tarahi/cfnsync.svg)](https://www.npmjs.com/package/@tarahi/cfnsync)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`cfnsync` is a minimal CLI for teams that operate legacy products on hand-written CloudFormation. It syncs a folder of raw templates (YAML / JSON) to stacks: it detects added / modified / deleted templates, creates and diffs change sets, and creates, updates, or deletes stacks in dependency order. It is built for non-interactive CI (GitHub Actions in particular).

It is deliberately **not** a new IaC abstraction: no CDK/SAM-style template generation, no linting, no drift remediation, no multi-account fan-out, no GUI.

## Why cfnsync

- **Your templates, unchanged** — operates on raw CloudFormation; nothing to rewrite or migrate.
- **Safe, value-aware change sets** — every deploy goes through a change set you can inspect before execution, including the property before/after values returned by CloudFormation.
- **Dependency-aware** — resolves order from `Export` / `Fn::ImportValue` plus explicit `dependsOn`, and deploys/deletes accordingly.
- **CI-first** — non-interactive, with a stable [exit-code contract](#exit-codes) CI can branch on.
- **Fail-closed** — mutations require an account/region allow-list verified against STS; unverifiable situations abort instead of guessing.
- **State with locking** — Terraform-style state (`local` or `s3`) with compare-and-swap and distributed locking for CI.

## Requirements

- Node.js **24 or later**
- AWS credentials via the standard SDK credential chain (shared profiles, environment variables, or GitHub Actions OIDC). cfnsync never stores credentials.

## Install

Run it directly with `npx` (no install), or add it as a dev dependency:

```sh
npx @tarahi/cfnsync --help
# or
npm install --save-dev @tarahi/cfnsync
```

The npm package is scoped (`@tarahi/cfnsync`), but the command it installs is `cfnsync`. Once it is a dev dependency you can also run it as `npx cfnsync ...`.

## Quickstart

1. Create a `cfnsync.yaml` next to your templates:

   ```yaml
   version: 1
   allowedAccounts: ["123456789012"]
   allowedRegions: [ap-northeast-1]
   defaultRegion: ap-northeast-1

   stacks:
     network.yaml:
       stackName: prod-network
     app.yaml:
       stackName: prod-app
       dependsOn: [network.yaml]
   ```

2. See what would change, review the diff, then deploy:

   ```sh
   npx @tarahi/cfnsync status   # added / modified / deleted / unchanged
   npx @tarahi/cfnsync plan     # create change sets and print the diff (exit 2 if there is a diff)
   npx @tarahi/cfnsync deploy   # execute in dependency order
   ```

## Commands

Every subcommand accepts the common options `--config <path>` (default `./cfnsync.yaml`), `--profile <name>`, `--region <region>`, and `--output <text|json>`.

| Command | Description |
|---|---|
| `status` | Compare state with local templates and print `added` / `modified` / `deleted` / `unchanged`. |
| `plan` | Create change sets, print the diff, and exit without executing. Exit code `2` when a diff exists. |
| `deploy` | Detect changes, resolve order, create/diff/execute change sets non-interactively. |
| `graph` | Print the per-region dependency graph derived from Exports/Imports and `dependsOn`. |
| `import` | Adopt existing stacks into config, templates, and state (read-only against AWS). |
| `force-unlock <runId>` | Conditionally release a stale S3 state lock owned by the given run ID. |

Human-readable diffs from `plan` and `deploy` use ANSI colors by default, including in CI and redirected output: Add is green, Modify yellow, Remove red, and replacements are bold red. Use `--no-color` or set `NO_COLOR` (an empty value also counts) to disable ANSI output. JSON output is always uncolored.

Key `deploy` flags: `--dry-run` (create and diff only), `--allow-delete` (permit deletion of removed stacks — otherwise deletions are only reported), `--on-failure <stop|continue>` (default `stop`), `--confirm` (prompt before executing on a TTY), `--no-color` (disable ANSI diff colors; also available on `plan`). Run `cfnsync <command> --help` for the full flag list.

## Configuration

`cfnsync.yaml` (in the current directory by default) drives everything. `allowedAccounts` / `allowedRegions` are the fail-closed guard for mutating operations; `regions` defaults to `defaultRegion`; `stackName` is derived from `stackNamePrefix` + filename when omitted. `defaultTags` and per-region `regionOverrides` are supported.

For the full parameter list see [`docs/config-reference.md`](./docs/config-reference.md), and a commented starter file at [`docs/examples/cfnsync.sample.yaml`](./docs/examples/cfnsync.sample.yaml).

State defaults to the `local` backend (`cfnsync.state.json` next to the config). For CI or any multi-runner setup, use the `s3` backend (conditional-write locking + compare-and-swap); enabling S3 bucket versioning is recommended.

## Using in CI (GitHub Actions)

Use the `s3` backend and never write state back to Git. Give each environment its own `concurrency.group` and S3 state key so concurrent triggers queue instead of racing.

```yaml
name: cfnsync deploy
on:
  push:
    branches: [main]
concurrency:
  group: cfnsync-prod
  cancel-in-progress: false
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/cfnsync-deploy
          aws-region: ap-northeast-1
      - run: npx @tarahi/cfnsync deploy
        working-directory: templates
```

The execution role needs `sts:GetCallerIdentity`, the CloudFormation change-set / stack / template actions, and (for the `s3` backend) `s3:GetObject` / `PutObject` / `DeleteObject` on the state and lock keys. Your templates may require additional permissions (e.g. `iam:PassRole`) depending on the resources they create. See [`docs/config-reference.md`](./docs/config-reference.md) and [`docs/spec/design.md`](./docs/spec/design.md) for details.

### Exit codes

CI depends on these:

| Code | Meaning |
|---|---|
| `0` | Success (including "no changes") |
| `1` | Error (validation, guard, or AWS operation failure) |
| `2` | Diff exists (`plan` / `--dry-run` only) |

## Claude Code plugin

cfnsync ships a [Claude Code](https://claude.com/claude-code) plugin — a skill that helps Claude drive and interpret cfnsync safely (which subcommand to use, how to read exit codes, the fail-closed / locking / change-set-ownership invariants). Install it from this repository's marketplace:

```
/plugin marketplace add tarahiman/cfnsync
/plugin install cfnsync@cfnsync
```

Then ask Claude to work with cfnsync in a repo that has a `cfnsync.yaml`. The plugin manifest is [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) and the skill lives in [`skills/using-cfnsync/SKILL.md`](./skills/using-cfnsync/SKILL.md).

## Codex plugin

cfnsync also ships a [Codex CLI](https://developers.openai.com/codex/) plugin backed by the same skill. Install it from this repository's marketplace:

```
codex plugin marketplace add tarahiman/cfnsync
codex plugin add cfnsync@cfnsync
```

Then ask Codex to work with cfnsync in a repo that has a `cfnsync.yaml`. The plugin manifest is [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json), the marketplace manifest is [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json), and it points at the same skill: [`skills/using-cfnsync/SKILL.md`](./skills/using-cfnsync/SKILL.md).

## Safety model

Several invariants come out of adversarial review and are load-bearing; do not weaken them:

- Mutations are fail-closed: they require `allowedAccounts` / `allowedRegions` and an STS identity match, and state is bound to a single AWS account.
- State consistency is guaranteed by compare-and-swap (`If-Match` on S3); the losing writer fails. Concurrent operations on one stack fail safely via `*_IN_PROGRESS` guards and CloudFormation's own in-progress rejection.
- Ownership fencing (re-checking before every side effect) is **best-effort** — it narrows the race window but does not, and cannot, close it on the CloudFormation API. Separate the cfnsync execution principal in IAM as well.
- A foreign change set on a managed stack blocks execution (executing a change set implicitly deletes the others), so cfnsync stops rather than clobbering it.

Do not create change sets on cfnsync-managed stacks manually or with other tools. Full rationale is in [`docs/spec/design.md`](./docs/spec/design.md) and [`docs/spec/requirements.md`](./docs/spec/requirements.md).

## Contributing

Built with TypeScript, pnpm, Biome, and Vitest, following spec-driven TDD. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © tarahiman
