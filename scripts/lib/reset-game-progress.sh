#!/usr/bin/env bash
# Shared by the explicit reset and deployment entrypoints. The caller owns
# deploy.lock and must stop API/web writers before calling this function.
# dc() uses the caller's exact Compose project, credentials and overlays.
reset_game_progress_with_rehearsal() (
  set -euo pipefail
  umask 077
  dc exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 \
    -v apply_reset=off < scripts/reset-game-progress.sql

  backup_dir="$project_dir/../zhiv-backups"
  mkdir -p "$backup_dir"
  if (( EUID == 0 )); then chown --reference="$project_dir" "$backup_dir"; fi
  chmod 700 "$backup_dir"
  backup_file="$(mktemp "$backup_dir/before-game-reset-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")"
  if (( EUID == 0 )); then chown --reference="$project_dir" "$backup_file"; fi
  restore_db="zhiv_game_reset_verify_$$"
  restore_created=false
  backup_verified=false
  reset_committed=false
  cleanup_reset() {
    local result=$?
    if $restore_created; then dc exec -T db dropdb -U zhiv --if-exists "$restore_db" || true; fi
    if $reset_committed; then echo 'The 0.7.1 game reset transaction completed. Repeating it preserves new progress.'; fi
    if $backup_verified; then
      echo "Verified original backup retained: $backup_file"
    else
      echo "Backup path (verification incomplete): $backup_file" >&2
    fi
    return "$result"
  }
  trap cleanup_reset EXIT

  dc exec -T db pg_dump -U zhiv -d zhiv --format=custom --exclude-table-data=public.earth_latest_locations --exclude-table-data=public.earth_frozen_locations --no-owner --no-acl > "$backup_file"
  test -s "$backup_file"
  dc exec -T db pg_restore --list < "$backup_file" > /dev/null
  dc exec -T db createdb -U zhiv --template=template0 "$restore_db"
  restore_created=true
  dc exec -T db pg_restore -U zhiv -d "$restore_db" \
    --no-owner --no-acl --exit-on-error < "$backup_file"
  backup_verified=true

  echo 'Rehearsing the 0.7.1 reset on the restored copy, including preservation checks.'
  dc exec -T db psql -X -U zhiv -d "$restore_db" -v ON_ERROR_STOP=1 \
    -v apply_reset=on < scripts/reset-game-progress.sql
  dc exec -T db dropdb -U zhiv "$restore_db"
  restore_created=false

  echo 'Backup and rehearsal passed. Applying the one-time 0.7.1 fresh start.'
  dc exec -T db psql -X -U zhiv -d zhiv -v ON_ERROR_STOP=1 \
    -v apply_reset=on < scripts/reset-game-progress.sql
  reset_committed=true
)
