#!/bin/sh
set -eu
CALLER_DIR=$(pwd)
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$RELEASE_DIR"
. "$RELEASE_DIR/common.sh"
archive=${1:-"$RELEASE_DIR/miracle-backup-$(date +%Y%m%d-%H%M%S).tar.gz"}
case "$archive" in /*) ;; *) archive="$CALLER_DIR/$archive";; esac
if [ -e "$archive" ] || [ -e "$archive.partial" ]; then echo 'Backup destination already exists. Choose another filename.' >&2; exit 1; fi
umask 077
# Stop writes while taking the paired database + key backup. Leave the app stopped
# after success so an upgrade can follow immediately without additional writes.
compose stop app
compose up -d --wait --wait-timeout 120 postgres
if ! maintenance backup > "$archive.partial"; then
  rm -f -- "$archive.partial"
  echo 'Backup failed; no successful backup was recorded. Run start to resume the existing version.' >&2
  exit 1
fi
if [ ! -s "$archive.partial" ]; then rm -f -- "$archive.partial"; echo 'Backup was empty.' >&2; exit 1; fi
mv -- "$archive.partial" "$archive"
maintenance mark-backup
printf 'Backup saved: %s\nThe app is stopped. Keep this archive private: it contains database credentials and encryption keys.\n' "$archive"
