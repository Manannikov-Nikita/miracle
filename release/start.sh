#!/bin/sh
set -eu
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$RELEASE_DIR"
. "$RELEASE_DIR/common.sh"
if ! compose pull app postgres maintenance; then
  echo 'Could not download release images. Check your connection and the release image availability, then try again.' >&2
  exit 1
fi
maintenance init
up_app
url=$(compose exec -T app node dist/server/server/cli.js setup-link)
printf '\nOpen Miracle: %s\n' "$url"
if command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true
fi
