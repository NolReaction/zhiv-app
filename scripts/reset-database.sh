#!/usr/bin/env bash
# Manual, destructive reset of the dedicated zhiv database. Never run on deploy/timer.
set -euo pipefail
umask 077

if [[ $# != 1 || $1 != --confirm-delete-database ]]; then
  echo 'Deletes the entire zhiv database, including every user and its migration history.' >&2
  echo 'Usage: sudo bash scripts/reset-database.sh --confirm-delete-database' >&2
  exit 2
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
compose=(docker compose)
if [[ -f deploy/.env ]]; then compose+=(--env-file deploy/.env); fi
compose+=(-f deploy/compose.yml)
"${compose[@]}" config --quiet
"${compose[@]}" exec -T db pg_isready -U zhiv -d zhiv

echo 'This erases every profile, check-in, login identity, session, code and saved limit.'
echo 'Only database zhiv is replaced. Domain, secret files, PostgreSQL roles and Docker volumes stay.'
read -r -p 'Type RESET zhiv to continue: ' confirmation </dev/tty
if [[ $confirmation != 'RESET zhiv' ]]; then
  echo 'Confirmation did not match; nothing was reset.' >&2
  exit 2
fi

# Build before stopping traffic; a failed build cannot erase the working database.
"${compose[@]}" build migrate api web
backup_dir="$project_dir/../zhiv-backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_file="$(mktemp "$backup_dir/before-database-reset-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")"
restore_db="zhiv_reset_verify_$(date +%s)_$$"
restore_created=false
backup_verified=false
services_stopped=false
database_replaced=false
cleanup() {
  local result=$?
  if $restore_created; then
    "${compose[@]}" exec -T db dropdb -U zhiv --if-exists "$restore_db" || true
  fi
  if $services_stopped; then
    echo 'Site services may be stopped. Check the error before restarting; see docs/operations/reset-database.md.' >&2
    if $database_replaced; then
      echo 'The old database was already deleted; restarting services does not restore its data.' >&2
    fi
  fi
  if $backup_verified; then
    echo "Verified backup retained: $backup_file"
  else
    echo "Backup path (verification did not complete): $backup_file" >&2
  fi
  return "$result"
}
trap cleanup EXIT

echo 'Stopping traffic and application writers; PostgreSQL stays running.'
services_stopped=true
"${compose[@]}" stop caddy web api provision migrate
"${compose[@]}" exec -T db pg_dump -U zhiv -d zhiv --format=custom > "$backup_file"
test -s "$backup_file"
"${compose[@]}" exec -T db pg_restore --list < "$backup_file" > /dev/null

echo 'Verifying the backup by restoring it into a separate temporary database.'
"${compose[@]}" exec -T db createdb -U zhiv --template=template0 "$restore_db"
restore_created=true
"${compose[@]}" exec -T db pg_restore -U zhiv -d "$restore_db" --exit-on-error < "$backup_file"
backup_verified=true
"${compose[@]}" exec -T db dropdb -U zhiv "$restore_db"
restore_created=false

echo 'Backup verified. Replacing only database zhiv and replaying migrations.'
# Deliberately omit --force: any unexpected remaining connection aborts the reset.
"${compose[@]}" exec -T db dropdb -U zhiv --maintenance-db=postgres zhiv
database_replaced=true
"${compose[@]}" exec -T db createdb -U zhiv --template=template0 --owner=zhiv zhiv
"${compose[@]}" run --rm --no-deps provision
"${compose[@]}" run --rm --no-deps migrate

"${compose[@]}" exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
    item record;
    remaining bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.flyway_schema_history WHERE success)
        OR EXISTS (SELECT 1 FROM public.flyway_schema_history WHERE NOT success)
        OR to_regclass('public.app_users') IS NULL THEN
        RAISE EXCEPTION 'Fresh application migrations did not complete.';
    END IF;
    FOR item IN SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          AND schemaname !~ '^pg_toast'
          AND NOT (schemaname = 'public' AND tablename = 'flyway_schema_history')
    LOOP
        EXECUTE format('SELECT count(*) FROM %I.%I', item.schemaname, item.tablename) INTO remaining;
        IF remaining <> 0 THEN
            RAISE EXCEPTION 'Table %.% is not empty; site remains stopped.', item.schemaname, item.tablename;
        END IF;
    END LOOP;
    RAISE NOTICE 'Fresh migrations verified; every application table is empty.';
END $$;
SQL

# A fresh API process also clears all in-memory rate-limit buckets.
"${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 180 api
"${compose[@]}" exec -T api curl -fsS --max-time 10 http://127.0.0.1:8080/readyz
echo
"${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 180 web
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 120 caddy
services_stopped=false
echo 'Complete: fresh database and application processes. Everyone must sign in and create a new profile.'
