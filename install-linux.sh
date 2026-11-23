#!/bin/sh
# Build the current master commit locally. Requires Rust and native build dependencies.
set -eu
fail() { printf 'gopher: %s\n' "$*" >&2; exit 1; }
install_dir=${GOPHER_INSTALL_DIR:-"$HOME/.local/bin"}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dir) [ "$#" -ge 2 ] || fail '--dir requires a directory'; install_dir=$2; shift 2 ;;
        --help|-h) printf 'Usage: sh install-linux.sh [--dir DIRECTORY]\nBuilds master; requires Rust, a C compiler, GTK3 and WebKitGTK 4.1 development packages.\n'; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[ "$(uname -s)" = Linux ] || fail 'Use install-macos.sh on macOS or install.ps1 on Windows.'
command -v curl >/dev/null 2>&1 || fail 'Install curl, then retry.'
cargo_bin=$(command -v cargo || true)
if [ -z "$cargo_bin" ]; then cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"; fi
[ -x "$cargo_bin" ] && "$cargo_bin" --version >/dev/null 2>&1 || fail 'Install Rust with Cargo from https://rustup.rs, then retry.'
rust_bin="$(dirname "$cargo_bin")/rustc"
if [ ! -x "$rust_bin" ]; then rust_bin=$(command -v rustc || true); fi
[ -n "$rust_bin" ] && "$rust_bin" --version >/dev/null 2>&1 || fail 'Install a Rust toolchain with rustup, then retry.'
export PATH="$(dirname "$cargo_bin"):$PATH"
if ! command -v cc >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists glib-2.0 gtk+-3.0 webkit2gtk-4.1; then
    printf '%s\n' 'Install native build dependencies, then rerun this script:' >&2
    printf '%s\n' '  Debian/Ubuntu: sudo apt install build-essential pkg-config libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev' >&2
    printf '%s\n' '  Fedora: sudo dnf install gcc gcc-c++ pkgconf-pkg-config glib2-devel gtk3-devel webkit2gtk4.1-devel' >&2
    printf '%s\n' '  Arch: sudo pacman -S --needed base-devel glib2 gtk3 webkit2gtk-4.1' >&2
    fail 'A C compiler, pkg-config, GTK3 and WebKitGTK 4.1 development files are required.'
fi
target=$("$rust_bin" -vV | sed -n 's/^host: //p')
[ -n "$target" ] || fail 'Could not determine the Rust host target.'
commit=$(curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 \
    -H 'Accept: application/vnd.github.sha' -H 'X-GitHub-Api-Version: 2022-11-28' \
    https://api.github.com/repos/jacobzymet/gopher/commits/master)
case "$commit" in *[!0-9a-fA-F]*|'') fail 'GitHub did not return a valid master commit.' ;; esac
[ "${#commit}" -eq 40 ] || fail 'GitHub did not return a full master commit.'
commit=$(printf '%s' "$commit" | tr 'A-F' 'a-f')
mkdir -p "$install_dir"
install_dir=$(cd "$install_dir" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/gopher-build.XXXXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
cache="${XDG_CACHE_HOME:-$HOME/.cache}/gopher/update-build/$target"
printf 'Building Gopher master@%.12s locally. The first build may take several minutes.\n' "$commit"
cd "$work"
GOPHER_BUILD_COMMIT="$commit" "$cargo_bin" install --git https://github.com/jacobzymet/gopher \
    --rev "$commit" --locked --force --bin gopher --target "$target" \
    --root "$work/build" --target-dir "$cache" || fail 'Build failed; check Rust and the native build dependencies. Your installed app was not replaced.'
identity=$("$work/build/bin/gopher" --version)
printf '%s\n' "$identity" | grep -Fx "Commit: $commit" >/dev/null || fail 'The built app does not identify the requested commit.'
staged=$(mktemp "$install_dir/.gopher-install.XXXXXXXX")
if ! cp "$work/build/bin/gopher" "$staged" || ! chmod 755 "$staged" || ! mv -f "$staged" "$install_dir/gopher"; then
    rm -f "$staged"
    fail 'Could not install the locally built app.'
fi
printf 'Installed %s to %s/gopher\n' "$identity" "$install_dir"
case ":$PATH:" in *":$install_dir:"*) ;; *) printf 'Add %s to PATH to launch with: gopher\n' "$install_dir" ;; esac
printf 'Run gopher. Check master and build future updates in Settings → App.\n'
