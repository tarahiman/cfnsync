# Contributing

Thanks for your interest in cfnsync. This project follows **spec-driven TDD**: the specs in `docs/spec/` are the source of truth, and each acceptance criterion maps 1:1 to a test case.

## Development

Requires Node.js 24+ and [pnpm](https://pnpm.io/) 11.2.2.

```sh
pnpm install          # install dependencies
pnpm run build        # type-check and build to dist/
pnpm test             # run the full Vitest suite (no real AWS access needed)
pnpm vitest run <file># run a single test file
pnpm run lint         # Biome + control-char check
pnpm run format       # Biome format
pnpm run format:check # verify formatting without modifying files
pnpm run quality:check# format check, lint, tests, and build
```

Run the test suite before and after any change — it must stay green.

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
path can affect the application, tests, build, or CI, it also runs the format
check, lint, full unit test suite, and build against an isolated copy of the
Git index. Unstaged files are neither checked nor modified. Documentation-only
changes skip those four code checks, but never skip Gitleaks.

If Gitleaks is already managed by your system, you may enable only the hook with
`pnpm run hooks:install`; the hook prefers `GITLEAKS_BIN`, then the pinned
`.tools/bin/gitleaks`, then a `gitleaks` command on `PATH`.

## Making changes

- **Specs first.** Any behavior change must be reflected in [`docs/spec/requirements.md`](./docs/spec/requirements.md) and [`docs/spec/design.md`](./docs/spec/design.md) *before* implementation, with a matching test.
- **Do not weaken the safety invariants** documented in the design spec and the README "Safety model" section (fail-closed guards, state compare-and-swap, change-set ownership). These came out of adversarial review and are load-bearing.
- **User-facing CLI messages are English.** Keep help text and command output in English.

## Manual AWS verification

Automated tests never touch real AWS. Before a release, run a manual end-to-end pass against an **isolated, disposable** AWS account with a dedicated S3 state bucket and stack names you are free to delete — never a production account or existing stacks. Exercise `status` → `graph` → `plan` → `deploy`, an update, a `--allow-delete` deletion, a concurrent-lock scenario, and `import`. See [`docs/spec/design.md`](./docs/spec/design.md) for the full rationale.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
