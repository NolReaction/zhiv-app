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
compose=(docker compose)
if [[ -f deploy/.env ]]; then compose+=(--env-file deploy/.env); fi
compose+=(-f deploy/compose.yml)
"${compose[@]}" config --quiet

# Validate the exact reviewed schema before stopping traffic or creating a dump.
"${compose[@]}" exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 \
  -v apply_reset=off < scripts/reset-game-progress.sql
if ! $apply_reset; then exit 0; fi

backup_dir="$project_dir/../zhiv-backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
exec 9> "$backup_dir/.game-progress-reset.lock"
if ! flock -n 9; then echo 'Another game progress reset is running.' >&2; exit 1; fi
backup_file="$(mktemp "$backup_dir/before-game-reset-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")"
restore_db="zhiv_game_reset_verify_$$"
restore_created=false
backup_verified=false
services_stopped=false
reset_committed=false
cleanup() {
  local result=$?
  if $restore_created; then "${compose[@]}" exec -T db dropdb -U zhiv --if-exists "$restore_db" || true; fi
  if $services_stopped; then
    echo 'Site services may be stopped. Resolve the error before starting api web caddy.' >&2
  fi
  if $reset_committed; then echo 'The game reset COMMITTED. Restarting services does not restore old progress.' >&2; fi
  if $backup_verified; then
    echo "Verified original backup retained: $backup_file"
  else
    echo "Backup path (verification incomplete): $backup_file" >&2
  fi
  return "$result"
}
trap cleanup EXIT

echo 'Stopping site traffic; account login sessions will be retained.'
services_stopped=true
"${compose[@]}" stop caddy web api
"${compose[@]}" exec -T db pg_dump -U zhiv -d zhiv --format=custom --exclude-table-data=public.earth_latest_locations --exclude-table-data=public.earth_frozen_locations --no-owner --no-acl > "$backup_file"
test -s "$backup_file"
"${compose[@]}" exec -T db pg_restore --list < "$backup_file" > /dev/null
"${compose[@]}" exec -T db createdb -U zhiv --template=template0 "$restore_db"
restore_created=true
"${compose[@]}" exec -T db pg_restore -U zhiv -d "$restore_db" \
  --no-owner --no-acl --exit-on-error < "$backup_file"
backup_verified=true

echo 'Rehearsing the reset on the restored copy, including preservation checks.'
"${compose[@]}" exec -T db psql -X -U zhiv -d "$restore_db" -v ON_ERROR_STOP=1 \
  -v apply_reset=on < scripts/reset-game-progress.sql
"${compose[@]}" exec -T db dropdb -U zhiv "$restore_db"
restore_created=false

echo 'Backup and rehearsal passed. Resetting game progress in one transaction.'
"${compose[@]}" exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 \
  -v apply_reset=on < scripts/reset-game-progress.sql
reset_committed=true
"${compose[@]}" up -d --no-deps --no-build --no-recreate --wait --wait-timeout 120 api web caddy
services_stopped=false
"${compose[@]}" exec -T api curl -fsS --max-time 10 http://127.0.0.1:8080/readyz
echo
echo 'Reset complete. Reload game tabs to refresh the scene; old game commands are fenced and existing sign-ins still work.'
