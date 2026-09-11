#!/bin/sh

set -eu

version='8.30.1'
os_name=$(uname -s)
architecture=$(uname -m)

case "$os_name" in
  Darwin)
    platform='darwin'
    ;;
  Linux)
    platform='linux'
    ;;
  *)
    echo "Unsupported operating system for the pinned Gitleaks installer: $os_name" >&2
    exit 2
    ;;
esac

case "$architecture" in
  arm64 | aarch64)
    machine='arm64'
    ;;
  x86_64 | amd64)
    machine='x64'
    ;;
  *)
    echo "Unsupported architecture for the pinned Gitleaks installer: $architecture" >&2
    exit 2
    ;;
esac

archive="gitleaks_${version}_${platform}_${machine}.tar.gz"
case "${platform}_${machine}" in
  darwin_arm64)
    expected_sha256='b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'
    ;;
  darwin_x64)
    expected_sha256='dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'
    ;;
  linux_arm64)
    expected_sha256='e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'
    ;;
  linux_x64)
    expected_sha256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
    ;;
esac

install_directory=${GITLEAKS_INSTALL_DIR:-.tools/bin}
install_path="${install_directory}/gitleaks"

if [ -x "$install_path" ]; then
  if ! installed_version=$("$install_path" version); then
    echo "Unable to inspect the Gitleaks binary at $install_path." >&2
    exit 2
  fi
  if [ "$installed_version" = "$version" ]; then
    echo "Gitleaks $version is already installed at $install_path."
    exit 0
  fi
fi

if ! temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/cfnsync-gitleaks.XXXXXX"); then
  echo 'Unable to create a temporary directory for Gitleaks.' >&2
  exit 2
fi
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

download_path="${temporary_directory}/${archive}"
url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}"

if ! curl \
  --fail \
  --location \
  --proto '=https' \
  --retry 3 \
  --show-error \
  --silent \
  --tlsv1.2 \
  --output "$download_path" \
  "$url"
then
  echo "Unable to download Gitleaks from $url." >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$download_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$download_path" | awk '{print $1}')
else
  echo 'A SHA-256 utility (sha256sum or shasum) is required.' >&2
  exit 2
fi

if [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "Gitleaks archive checksum mismatch: expected $expected_sha256, got $actual_sha256" >&2
  exit 1
fi

if ! tar -xzf "$download_path" -C "$temporary_directory" gitleaks; then
  echo 'Unable to extract the Gitleaks archive.' >&2
  exit 2
fi
if ! mkdir -p "$install_directory"; then
  echo "Unable to create $install_directory." >&2
  exit 2
fi
if ! install -m 0755 "${temporary_directory}/gitleaks" "$install_path"; then
  echo "Unable to install Gitleaks at $install_path." >&2
  exit 2
fi

echo "Installed Gitleaks $version at $install_path."
