#!/bin/sh
# Exercise the built production image without publishing a port or using the
# active workspace database. Requires the project PostgreSQL service running.
set -eu
smoke_id="$(date -u +%s)_$$"
smoke_db="miracle_smoke_$smoke_id"
smoke_container="miracle-app-smoke-$smoke_id"
smoke_env=".local/smoke-$smoke_id.env"
smoke_key=${ENCRYPTION_KEY_PATH:-.local/encryption.key}
[ -s "$smoke_key" ] || { echo 'Run node scripts/init-local.mjs first.' >&2; exit 2; }
smoke_key_dir=$(cd "$(dirname "$smoke_key")" && pwd)
smoke_key="$smoke_key_dir/$(basename "$smoke_key")"
cleanup() {
  docker rm -f "$smoke_container" >/dev/null 2>&1 || true
  docker compose exec -T postgres dropdb -U miracle --if-exists "$smoke_db" >/dev/null 2>&1 || true
  rm -f "$smoke_env"
}
trap cleanup EXIT HUP INT TERM
mkdir -p .local
MIRACLE_SMOKE_DB="$smoke_db" MIRACLE_SMOKE_ENV="$smoke_env" node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
const u=new URL(process.env.DATABASE_URL||'postgres://miracle:miracle_local@127.0.0.1:5544/miracle');
u.hostname='postgres';u.port='5432';u.pathname='/'+process.env.MIRACLE_SMOKE_DB;
writeFileSync(process.env.MIRACLE_SMOKE_ENV,`DATABASE_URL=${u}\nENCRYPTION_KEY_FILE=/run/secrets/encryption_key\nCOOKIE_SECURE=false\nAPP_ORIGIN=http://localhost\nHOST=0.0.0.0\nPORT=3001\n`,{mode:0o600});
JS
docker compose exec -T postgres createdb -U miracle "$smoke_db"
docker run -d --name "$smoke_container" --network miracle_default --env-file "$smoke_env" --mount "type=bind,source=$smoke_key,target=/run/secrets/encryption_key,readonly" "${MIRACLE_SMOKE_IMAGE:-miracle-app:latest}" >/dev/null
# Readiness polling stays inside the isolated container.
docker exec "$smoke_container" node --input-type=module -e '
import assert from "node:assert/strict";import{readFileSync}from"node:fs";
let response;for(let attempt=0;attempt<60;attempt++){try{response=await fetch("http://127.0.0.1:3001/api/health");if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
assert.ok(response?.ok,"Production image health failed");assert.equal((await response.json()).ok,true);
const page=await fetch("http://127.0.0.1:3001/");assert.equal(page.status,200);const html=await page.text();assert.match(html,/<div id="root"><\/div>/);
const asset=html.match(/src="([^\"]+\.js)"/);assert.ok(asset,"Built JS asset absent");assert.equal((await fetch(new URL(asset[1],"http://127.0.0.1:3001"))).status,200);
const uid=readFileSync("/proc/1/status","utf8").match(/^Uid:\s+(\d+)/m)?.[1];assert.equal(uid,"1000");
console.log("Production image smoke passed: health, built frontend asset, UID1000, protected key, isolated database, no host port.");'
