#!/bin/sh
set -eu
CALLER_DIR=$(pwd)
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$RELEASE_DIR"
. "$RELEASE_DIR/common.sh"
if [ "$#" -ne 1 ]; then echo 'Usage: ./restore.sh /path/to/miracle-backup.tar.gz' >&2; exit 1; fi
archive=$1
case "$archive" in /*) ;; *) archive="$CALLER_DIR/$archive";; esac
if [ ! -f "$archive" ]; then echo 'Usage: ./restore.sh /path/to/miracle-backup.tar.gz' >&2; exit 1; fi
# Check before stopping anything. Existing installations are never overwritten.
maintenance restore-check
compose stop app postgres
maintenance prepare-restore < "$archive"
compose up -d --wait --wait-timeout 120 postgres
maintenance restore-db
maintenance init
up_app
url=$(compose exec -T app node dist/server/server/cli.js setup-link)
printf 'Restore complete. Open Miracle: %s\n' "$url"
