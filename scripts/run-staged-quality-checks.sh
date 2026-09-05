#!/bin/sh

set -eu

repository_root=$(git rev-parse --show-toplevel)
dependencies_path="${repository_root}/node_modules"

if [ ! -d "$dependencies_path" ]; then
  echo 'node_modules is required to check the staged snapshot.' >&2
  echo 'Run "pnpm install --frozen-lockfile" and retry the commit.' >&2
  exit 1
fi

snapshot_directory=$(mktemp -d "${TMPDIR:-/tmp}/cfnsync-staged.XXXXXX")

cleanup() {
  rm -rf "$snapshot_directory"
}
trap cleanup EXIT HUP INT TERM

# checkout-index materializes exactly what Git would commit. In particular, it
# neither reads nor modifies unstaged files in the contributor's working tree.
git checkout-index --all --prefix="${snapshot_directory}/"
ln -s "$dependencies_path" "${snapshot_directory}/node_modules"

(
  cd "$snapshot_directory"
  # pnpm verifies that node_modules belongs to the current directory and may
  # attempt to replace a symlinked modules directory. npm's script runner does
  # not mutate dependencies, so use it to invoke the repository's staged
  # quality checks against this isolated snapshot.
  npm run check:docs
  npm run format:check
  npm run lint
  npm test
  npm run build
)
