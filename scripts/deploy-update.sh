#!/usr/bin/env bash
# Build the checked-out release, verify a backup, then update the VPS services.
set -euo pipefail
umask 022
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
git diff --quiet
git diff --cached --quiet

docker_command=(docker)
if (( EUID != 0 )); then docker_command=(sudo docker); fi
dc() { "${docker_command[@]}" compose --env-file deploy/.env -f deploy/compose.yml "$@"; }
dc config --quiet
dc build

backup_dir="$project_dir/../zhiv-backups"
(
  umask 077
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  backup_file="$(mktemp "$backup_dir/before-update-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")"
  dc exec -T db pg_dump -U zhiv -d zhiv --format=custom --no-owner --no-acl > "$backup_file"
  test -s "$backup_file"
  dc exec -T db pg_restore --list < "$backup_file" > /dev/null
  echo "Backup archive is readable: $backup_file"
)

dc up -d --no-build --wait --wait-timeout 240
# A changed bind-mounted Caddyfile does not trigger a Compose recreation.
# Recreate only the edge so the newly checked-out routing/headers take effect.
dc up -d --no-deps --no-build --force-recreate --wait --wait-timeout 60 caddy
dc ps -a
echo 'Update complete. Check the public home page and /readyz before reopening the app.'
