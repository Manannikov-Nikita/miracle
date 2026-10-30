#!/bin/sh
set -eu
VERSION='__VERSION__'
REPOSITORY='__REPOSITORY__'
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$(uname -s)" in
 Darwin) os=darwin; default_root="$HOME/Library/Application Support/Miracle";;
 Linux) os=linux; default_root="${XDG_DATA_HOME:-$HOME/.local/share}/miracle"; ldd --version 2>&1 | head -1 | grep -qiE 'glibc|GNU libc|GNU C Library' || fail 'Miracle requires GNU/Linux with glibc. musl/Alpine is unsupported.';;
 *) fail 'Unsupported operating system. Use install.ps1 on Windows.';;
esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) fail 'Supported architectures: arm64 and x64.';; esac
root=${MIRACLE_INSTALL_ROOT:-$default_root}
bin=${MIRACLE_BIN_DIR:-$HOME/.local/bin}
asset="miracle-$VERSION-$os-$arch.tar.gz"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/miracle-install.XXXXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
if [ -n "${MIRACLE_ARCHIVE:-}" ]; then
 cp "$MIRACLE_ARCHIVE" "$temporary/$asset" || fail 'Could not read manual archive.'
 cp "${MIRACLE_CHECKSUM_FILE:-$MIRACLE_ARCHIVE.sha256}" "$temporary/checksum" || fail 'Manual archive requires its .sha256 file.'
else
 base="https://github.com/$REPOSITORY/releases/download/v$VERSION"
 curl -fL --retry 3 "$base/$asset" -o "$temporary/$asset" || fail 'Release download failed; existing installation is unchanged.'
 curl -fL --retry 3 "$base/$asset.sha256" -o "$temporary/checksum" || fail 'Checksum download failed; existing installation is unchanged.'
fi
expected=$(awk 'NR==1 {print $1}' "$temporary/checksum")
case "$expected" in *[!a-fA-F0-9]*|'') fail 'Invalid release checksum.';; esac
[ "${#expected}" -eq 64 ] || fail 'Invalid release checksum.'
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$temporary/$asset" | awk '{print $1}'); fi
[ "$expected" = "$actual" ] || fail 'Release checksum mismatch; existing installation is unchanged.'
# Reject traversal and link entries before extraction. Release payloads contain regular files/directories only.
tar -tzf "$temporary/$asset" > "$temporary/entries" || fail 'Release archive is invalid.'
awk -v top="miracle-$VERSION-$os-$arch" 'BEGIN{bad=0} /^\// || /(^|\/)\.\.($|\/)/ {bad=1} {if ($0!=top && index($0,top "/")!=1) bad=1} END{exit bad}' "$temporary/entries" || fail 'Unsafe release archive paths.'
tar -tvzf "$temporary/$asset" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END{exit bad}' || fail 'Release archive contains unsupported links.'
tar -xzf "$temporary/$asset" -C "$temporary" || fail 'Release extraction failed; existing installation is unchanged.'
payload="$temporary/miracle-$VERSION-$os-$arch"
"$payload/runtime/bin/node" "$payload/install.mjs" "$payload" "$root" "$bin"
