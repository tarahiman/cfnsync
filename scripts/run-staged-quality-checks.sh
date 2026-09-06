#!/bin/sh

set -eu

if ! repository_root=$(git rev-parse --show-toplevel); then
  echo 'Unable to locate the repository root.' >&2
  exit 2
fi
dependencies_path="${repository_root}/node_modules"

if [ ! -d "$dependencies_path" ]; then
  echo 'node_modules is required to check the staged snapshot.' >&2
  echo 'Run "pnpm install --frozen-lockfile" and retry the commit.' >&2
  exit 2
fi

if ! snapshot_directory=$(mktemp -d "${TMPDIR:-/tmp}/cfnsync-staged.XXXXXX"); then
  echo 'Unable to create the staged snapshot directory.' >&2
  exit 2
fi

cleanup() {
  rm -rf "$snapshot_directory"
}
trap cleanup EXIT HUP INT TERM

# checkout-index materializes exactly what Git would commit. In particular, it
# neither reads nor modifies unstaged files in the contributor's working tree.
if ! git checkout-index --all --prefix="${snapshot_directory}/"; then
  echo 'Unable to materialize the staged snapshot.' >&2
  exit 2
fi
if ! ln -s "$dependencies_path" "${snapshot_directory}/node_modules"; then
  echo 'Unable to attach dependencies to the staged snapshot.' >&2
  exit 2
fi

(
  cd "$snapshot_directory"
  # pnpm verifies that node_modules belongs to the current directory and may
  # attempt to replace a symlinked modules directory. npm's script runner does
  # not mutate dependencies, so use it to invoke the repository's staged
  # quality checks against this isolated snapshot. For the same reason
  # "quality:check" itself chains its steps with npm: a nested "pnpm run" here
  # aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, and on a terminal it
  # would delete the contributor's real node_modules through the symlink.
  # Single gate definition: the hook runs exactly what CI runs, so any step
  # added to "quality:check" is picked up here without touching this script.
  npm run quality:check
) || exit 1
