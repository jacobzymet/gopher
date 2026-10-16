#!/bin/sh
# Requires Node.js 24.7+, npm, Git and curl.
set -eu
command -v node >/dev/null 2>&1 || { printf 'Install Node.js 24.7+ first.\n' >&2; exit 1; }
bootstrap_dir=$(mktemp -d "${TMPDIR:-/tmp}/gopher-install.XXXXXXXX")
bootstrap="$bootstrap_dir/install.ts"
trap 'rm -f "$bootstrap"; rmdir "$bootstrap_dir"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 https://raw.githubusercontent.com/jacobzymet/gopher/master/scripts/install.ts -o "$bootstrap"
node "$bootstrap" "$@"
