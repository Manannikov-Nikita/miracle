#!/bin/sh
set -eu
umask 077
backup_dir=${1:-.local/backups}
mkdir -p "$backup_dir"
backup_path="$backup_dir/miracle-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
database_name=${MIRACLE_BACKUP_DATABASE:-miracle}
case "$database_name" in miracle|miracle_integration_[0-9]*) ;; *) echo 'Refusing unknown backup database' >&2; exit 2;; esac
docker compose exec -T postgres pg_dump -U miracle -d "$database_name" -Fc > "$backup_path"
test -s "$backup_path"
printf 'Backup saved: %s\n' "$backup_path"
