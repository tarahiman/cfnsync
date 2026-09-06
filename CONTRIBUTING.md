# Contributing

Thanks for your interest in cfnsync. This project follows **spec-driven TDD**. Start with the [documentation map](./docs/README.md) and [specification governance guide](./docs/spec/README.md): requirements and design are the normative sources of truth, while traceability, decisions, change history, and work tracking have separate roles.

## Development

Requires Node.js 24+ and [pnpm](https://pnpm.io/) 11.2.2.

```sh
pnpm install          # install dependencies
pnpm run build        # type-check and build to dist/
pnpm test             # run the full Vitest suite (no real AWS access needed)
pnpm vitest run <file># run a single test file
pnpm run lint         # Biome (warnings fail) + control-char and message-language checks
pnpm run typecheck:test # type-check src/ and test/ together (tsconfig.test.json)
pnpm run format       # Biome format
pnpm run format:check # verify formatting without modifying files
pnpm run check:docs   # verify Markdown links, heading anchors, and requirements IDs
pnpm run quality:check# skill/docs checks, format, lint, test type-check, tests, and build
```

Run the test suite before and after any change — it must stay green.

`pnpm run build` type-checks only `src/` because it emits `dist/`. `test/` is far
larger than `src/`, so `typecheck:test` type-checks both together with
`tsconfig.test.json` (`noEmit`), which is what stops a test from silently
asserting against a shape the implementation never had.

Lint failures include warnings: `biome check` runs with `--error-on-warnings`, so
unused variables, unused imports and the `noUseless*` family fail the gate
instead of scrolling past. The `overrides` in `biome.json` also enforce the layer
boundaries (`cli → usecase → core / ports / report`, with `aws` and `backend`
implementing `ports`) through `noRestrictedImports`: for example, an
`@aws-sdk/*` import inside `src/core/` fails lint.

## Pre-commit checks

After cloning the repository, install the pinned Gitleaks binary and enable the
tracked pre-commit hook:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:setup
```

`hooks:setup` downloads Gitleaks 8.30.1 from its official GitHub release,
verifies the archive's pinned SHA-256 checksum, installs it under
`.tools/bin/`, and configures this clone to use `.githooks/`.

The setup script and hook support macOS, Linux, and Windows through WSL.
Native Windows shells are not currently supported.

Before every commit, the hook scans the staged patch with Gitleaks. If a staged
path can affect the application, tests, build, or CI, it also runs
`quality:check` against an isolated copy of the Git index. Unstaged files are
neither checked nor modified. Documentation-only changes skip the staged quality
gate (CI still validates documentation links and normative numbering/IDs), but
never skip Gitleaks.

`quality:check` is the single definition of the quality gate: the hook and the
pull-request workflow both invoke that one script, so a step added to it applies
to both without editing `scripts/run-staged-quality-checks.sh` or the workflow.

The hook is **opt-in**: `hooks:setup` sets `core.hooksPath` in this clone's local
Git config, and nothing installs it automatically (no `postinstall` hook — that
would add unreviewed code execution to `pnpm install`, which conflicts with
pinning and checksum-verifying Gitleaks). Skipping the hook is safe: CI runs the
same gate on every pull request. The hook only lets you find failures sooner.

`main` is protected by a repository ruleset that forbids direct pushes and
requires a pull request, so every change reaches `main` through the pull-request
workflow (Gitleaks plus `quality:check`). The workflow therefore triggers on
`pull_request` only; do not rely on pushing to `main` to run the checks.

If Gitleaks is already managed by your system, you may enable only the hook with
`pnpm run hooks:install`; the hook prefers `GITLEAKS_BIN`, then the pinned
`.tools/bin/gitleaks`, then a `gitleaks` command on `PATH`.

## Making changes

- **Specs first.** Follow the [specification change flow](./docs/spec/README.md#仕様変更の流れ). Any behavior change must be reflected in [`docs/spec/requirements.md`](./docs/spec/requirements.md) and [`docs/spec/design.md`](./docs/spec/design.md) *before* implementation, then propagated to traceability, tests, user documentation, and the changelog as applicable.
- **Do not weaken the safety invariants** documented in the design spec and the README "Safety model" section (fail-closed guards, state compare-and-swap, change-set ownership). These came out of adversarial review and are load-bearing.
- **User-facing CLI messages are English.** Keep help text and command output in English.

## Manual AWS verification

Automated tests never touch real AWS. Before a release, run a manual end-to-end pass against an **isolated, disposable** AWS account with a dedicated S3 state bucket and stack names you are free to delete — never a production account or existing stacks. Exercise `status` → `graph` → `plan` → `deploy`, an update, a `--allow-delete` deletion, a concurrent-lock scenario, and `import`. See [`docs/spec/design.md`](./docs/spec/design.md) for the full rationale.

## Releasing

Releases are published by CI, not from a laptop. Pushing a `vX.Y.Z` tag runs
[`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which publishes to npm
using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions
mints a short-lived OIDC token, so **no long-lived npm token is stored anywhere** — do not
add an `NPM_TOKEN` secret.

> The trusted publisher on npm is bound to the workflow **file name** `publish.yml`
> (Environment left blank). Renaming or moving that file breaks publishing.

### Steps

1. Complete the manual AWS verification pass described above.
2. On a branch, bump `version` in `package.json`, open a PR, and merge it into `main`.
3. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull
   git tag "v$(node -p 'require("./package.json").version')"
   git push origin "v$(node -p 'require("./package.json").version')"
   ```

The workflow then runs `quality:check`, verifies the release preconditions, publishes, and
creates a GitHub Release with auto-generated notes. It refuses to publish when the tag name
does not match `v<package.json version>`, when the tagged commit is not contained in `main`,
or when that version is already on the registry (`scripts/verify-release-tag.mjs`). The same
checks run locally:

```sh
pnpm run quality:check                              # gate: skill/docs refs, format, lint, type-check, tests, build
GITHUB_REF_NAME=v0.2.0 node scripts/verify-release-tag.mjs
pnpm pack --pack-destination /tmp                   # optional: inspect the tarball
```

### Notes

The package is published under the scoped name `@tarahi/cfnsync` — npm rejects the unscoped `cfnsync` as too similar to the existing `gensync`. `publishConfig.access` is set to `public`; the installed command name is still `cfnsync`.

`prepack` regenerates `npm-shrinkwrap.json` (in an isolated temp directory, because npm cannot resolve this repository's pnpm-managed `node_modules`), cleans and rebuilds `dist/`, and runs `verify:dist` to reject stale build output. The published tarball contains only `dist/`, `npm-shrinkwrap.json`, both READMEs, `LICENSE`, and `package.json`. `npm-shrinkwrap.json` is a build artifact and is not committed.

The workflow publishes with `--provenance`, so each release carries an attestation linking it to the commit and workflow run it was built from. The workflow deliberately does **not** set `registry-url` on `actions/setup-node`: that writes an unresolved `_authToken` placeholder into `.npmrc` and can prevent the OIDC fallback ([pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
