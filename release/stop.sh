#!/bin/sh
set -eu
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$RELEASE_DIR"
. "$RELEASE_DIR/common.sh"
compose stop app postgres
printf '%s\n' 'Miracle stopped. Data and encryption keys are preserved.'
