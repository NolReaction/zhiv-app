#!/usr/bin/env bash
# Manual maintenance only. No-argument invocation is a read-only preview.
set -euo pipefail
umask 077

apply_reset=false
case "${1:---preview}" in
  --preview) ;;
  --confirm-reset-game-progress) apply_reset=true ;;
  *) echo 'Usage: bash scripts/reset-game-progress.sh [--preview | --confirm-reset-game-progress]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then echo 'Expected at most one option.' >&2; exit 2; fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if $apply_reset; then
  # The same lock protects deployment and resets from reopening one another's gate.
  mkdir -p deploy/runtime
  if (( EUID == 0 )); then
    touch deploy/runtime/deploy.lock
    chown --reference="$project_dir" deploy/runtime deploy/runtime/deploy.lock
    chmod 755 deploy/runtime
    chmod 644 deploy/runtime/deploy.lock
  fi
  exec 9> deploy/runtime/deploy.lock
  flock -n 9 || { echo 'Another deployment or game reset is running.' >&2; exit 75; }
fi
compose=(docker compose)
if (( EUID != 0 )); then compose=(sudo docker compose); fi
if [[ -f deploy/.env ]]; then compose+=(--env-file deploy/.env); fi
compose+=(-f deploy/compose.yml)
dc() { "${compose[@]}" "$@"; }
"${compose[@]}" config --quiet

# Validate the exact reviewed schema before stopping traffic or creating a dump.
"${compose[@]}" exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 \
  -v apply_reset=off < scripts/reset-game-progress.sql
if ! $apply_reset; then exit 0; fi

services_stopped=false
cleanup() {
  local result=$?
  if $services_stopped; then
    echo 'Site services may be stopped. Resolve the error before starting api web caddy.' >&2
  fi
  return "$result"
}
trap cleanup EXIT
source scripts/lib/reset-game-progress.sh

echo 'Stopping site traffic; sign-ins and friends will be retained, game and check-in history will restart.'
services_stopped=true
"${compose[@]}" stop --timeout 30 caddy web api
reset_game_progress_with_rehearsal
"${compose[@]}" up -d --no-deps --no-build --no-recreate --wait --wait-timeout 120 api web caddy
services_stopped=false
"${compose[@]}" exec -T api curl -fsS --max-time 10 http://127.0.0.1:8080/readyz
echo
echo 'The one-time 0.7.1 reset is complete. Clients will refresh their gameplay state; existing sign-ins and friends still work.'
