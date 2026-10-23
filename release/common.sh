#!/bin/sh
set -eu
# Every wrapper changes to its own directory, so spaces and Unicode are safe.
if ! command -v docker >/dev/null 2>&1; then
  echo 'Install Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux): https://docs.docker.com/get-docker/' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker is unavailable. Start Docker Desktop or the Docker daemon, then run this script again.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 is required. Update Docker Desktop or install the Compose plugin.' >&2
  exit 1
fi
compose() {
  if [ -f "$RELEASE_DIR/settings.env" ]; then
    docker compose --env-file "$RELEASE_DIR/settings.env" -f "$RELEASE_DIR/compose.yaml" "$@"
  else
    docker compose -f "$RELEASE_DIR/compose.yaml" "$@"
  fi
}
maintenance() { compose run --rm -T --no-deps maintenance "$@"; }
port=${MIRACLE_PORT:-3001}
case "$port" in ''|*[!0-9]*) echo 'MIRACLE_PORT must be an integer from 1 to 65535.' >&2; exit 1;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then echo 'MIRACLE_PORT must be from 1 to 65535.' >&2; exit 1; fi
up_app() {
  if ! compose up -d --wait --wait-timeout 180 postgres app; then
    echo 'Startup failed. If the local port is occupied, stop the program using it or change MIRACLE_PORT in settings.env to 3002, then run ./start.sh again.' >&2
    echo 'Inspect the error above and: docker compose logs --tail 80 app postgres' >&2
    return 1
  fi
}
