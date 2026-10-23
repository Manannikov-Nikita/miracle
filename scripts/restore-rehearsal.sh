#!/bin/sh
# Restores to a disposable database, never to the live application database.
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: scripts/restore-rehearsal.sh BACKUP.dump' >&2; exit 2; }
[ -s "$1" ] || { echo 'Backup missing or empty' >&2; exit 2; }
rehearsal_db="miracle_restore_$(date -u +%s)_$$"
cleanup() { docker compose exec -T postgres dropdb -U miracle --if-exists "$rehearsal_db"; }
trap cleanup EXIT HUP INT TERM
docker compose exec -T postgres createdb -U miracle "$rehearsal_db"
docker compose exec -T postgres pg_restore -U miracle -d "$rehearsal_db" --exit-on-error --no-owner < "$1"
docker compose exec -T postgres psql -U miracle -d "$rehearsal_db" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS restored_tables FROM information_schema.tables WHERE table_schema='public';"
docker compose exec -T postgres psql -U miracle -d "$rehearsal_db" -v ON_ERROR_STOP=1 -Atc "SELECT json_build_object('boards',(SELECT count(*) FROM boards),'results',(SELECT count(*) FROM result_sets),'chunks',(SELECT count(*) FROM result_chunks),'connections',(SELECT count(*) FROM connections),'users',(SELECT count(*) FROM users));"
echo 'Restore rehearsal passed; temporary database removed on exit.'
