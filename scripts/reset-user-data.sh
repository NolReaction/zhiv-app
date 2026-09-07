#!/usr/bin/env bash
# One-time, explicit operator reset. Never run as part of deployment or a timer.
set -euo pipefail
umask 077

if [[ $# != 1 || $1 != --confirm-delete-all-users ]]; then
  echo 'Deletes ALL profiles, history, connections, sessions, recovery codes and login proofs.' >&2
  echo 'Usage: sudo bash scripts/reset-user-data.sh --confirm-delete-all-users' >&2
  exit 2
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
compose=(docker compose)
if [[ -f deploy/.env ]]; then compose+=(--env-file deploy/.env); fi
compose+=(-f deploy/compose.yml)
"${compose[@]}" config --quiet

# Refuse a reset until the new login-only API is actually running. An empty
# bootstrap payload cannot create a user even on an older API.
auth_options="$("${compose[@]}" exec -T api curl -fsS --max-time 10 http://127.0.0.1:8080/api/v1/auth/options)"
if [[ ! $auth_options =~ \"(vk|email)\"[[:space:]]*:[[:space:]]*true ]]; then
  echo 'Enable VK or email before resetting users.' >&2
  exit 1
fi
bootstrap_status="$("${compose[@]}" exec -T api curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8080/api/v1/bootstrap)"
if [[ $bootstrap_status != 410 ]]; then
  echo 'Deploy the login-only bootstrap guard before resetting users. Expected HTTP 410.' >&2
  exit 1
fi

backup_dir="$project_dir/../zhiv-backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_file="$(mktemp "$backup_dir/before-user-reset-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")"
restore_db="zhiv_reset_verify_$$"
restore_created=false
backup_verified=false
services_stopped=false
cleanup() {
  local result=$?
  if $restore_created; then
    "${compose[@]}" exec -T db dropdb -U zhiv --if-exists "$restore_db" || true
  fi
  if $services_stopped; then
    echo 'Services may be stopped or partially started. Resolve the error, then start api web caddy with Docker Compose.' >&2
  fi
  if $backup_verified; then
    echo "Verified backup retained: $backup_file"
  else
    echo "Backup path (verification did not complete): $backup_file" >&2
  fi
  return "$result"
}
trap cleanup EXIT

echo 'Stopping site traffic for a consistent backup and reset.'
services_stopped=true
"${compose[@]}" stop caddy web api
"${compose[@]}" exec -T db pg_dump -U zhiv -d zhiv --format=custom --no-owner --no-acl > "$backup_file"
test -s "$backup_file"
"${compose[@]}" exec -T db pg_restore --list < "$backup_file" > /dev/null

echo 'Verifying a complete restore into a separate temporary database.'
"${compose[@]}" exec -T db createdb -U zhiv "$restore_db"
restore_created=true
"${compose[@]}" exec -T db pg_restore -U zhiv -d "$restore_db" \
  --no-owner --no-acl --exit-on-error < "$backup_file"
backup_verified=true
"${compose[@]}" exec -T db dropdb -U zhiv "$restore_db"
restore_created=false

echo 'Backup restored successfully. Resetting all application data in one transaction.'
"${compose[@]}" exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 < scripts/reset-user-data.sql

echo 'User data reset committed. Starting site services.'
"${compose[@]}" start --wait --wait-timeout 120 api web caddy
services_stopped=false
"${compose[@]}" exec -T api curl -fsS --max-time 10 http://127.0.0.1:8080/readyz
echo
echo 'Reset complete. Everyone must sign in again; old profiles and invitations no longer exist.'
