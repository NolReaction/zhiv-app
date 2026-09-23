#!/usr/bin/env bash
# Build the checked-out release, verify a backup, then update the VPS services.
set -euo pipefail
umask 022
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
git diff --quiet
git diff --cached --quiet

# One deployment owns the edge gate; competing scripts must not reopen it.
runtime_dir="$project_dir/deploy/runtime"
mkdir -p "$runtime_dir"
exec 9> "$runtime_dir/deploy.lock"
flock -n 9 || { echo 'Another deployment is already running.' >&2; exit 75; }
export APP_BUILD_ID="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%S)-$$"
maintenance_started=0

publish_status() {
  local maintenance="$1" message="$2" temporary
  temporary="$(mktemp "$runtime_dir/app-status.XXXXXX")"
  printf '{"schemaVersion":1,"buildId":"%s","maintenance":%s,"message":"%s"}\n' \
    "$APP_BUILD_ID" "$maintenance" "$message" > "$temporary"
  chmod 644 "$temporary"
  mv -f "$temporary" "$runtime_dir/app-status.json"
}

finish() {
  local result=$?
  trap - EXIT
  if (( result != 0 && maintenance_started == 1 )); then
    # Never announce a mixed or unhealthy release as ready, including Ctrl+C.
    touch "$runtime_dir/maintenance" || true
    publish_status true 'Обновление задержалось. Мы восстанавливаем работу приложения.' || true
    echo 'Update failed; maintenance remains enabled. Inspect docker compose logs, fix the cause, then rerun scripts/deploy-update.sh.' >&2
    echo 'Do not delete deploy/runtime/maintenance until both web and API are healthy.' >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker_command=(docker)
if (( EUID != 0 )); then docker_command=(sudo docker); fi
dc() { "${docker_command[@]}" compose --env-file deploy/.env -f deploy/compose.yml "$@"; }
dc config --quiet
dc build
# Validate the edge configuration before stopping any healthy application service.
dc run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

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

maintenance_started=1
publish_status true 'Устанавливаем обновление. Приложение скоро продолжит работу.'
touch "$runtime_dir/maintenance"
# Arm the gate before migrations. Recreate also installs the runtime mount on the
# first rollout; the edge then stays alive independently of API/web restarts.
dc up -d --no-deps --no-build --force-recreate --wait --wait-timeout 60 caddy
# Prevent the previous API from writing while the next schema is being installed.
# Docker waits for in-flight requests to finish within the graceful-stop period.
dc stop --timeout 30 web api
dc up -d --no-build --wait --wait-timeout 240 db provision migrate api web
dc exec -T caddy wget --quiet --output-document=- http://api:8080/readyz > /dev/null
dc exec -T caddy wget --quiet --output-document=- http://web:3000/app-status.json > /dev/null
dc exec -T -e "EXPECTED_BUILD_ID=$APP_BUILD_ID" web node -e '
fetch("http://127.0.0.1:3000/app-status.json", { cache: "no-store" })
  .then(async response => {
    if (!response.ok) throw new Error("Built status is unavailable");
    const status = await response.json();
    if (status.schemaVersion !== 1 || status.maintenance !== false || status.buildId !== process.env.EXPECTED_BUILD_ID)
      throw new Error("The running web build does not match this deployment");
  }).catch(error => { console.error(error.message); process.exit(1); });'
# Alert rules are bind-mounted too. Reload them when monitoring is already active;
# do not enable the optional monitoring stack on installations that don't use it.
if dc ps --services --status running | grep -qx prometheus; then
  dc run --rm --no-deps --entrypoint /bin/promtool prometheus check rules /etc/prometheus/alerts.yml
  dc up -d --no-deps --no-build --force-recreate --wait --wait-timeout 90 prometheus
fi
dc ps -a
# Reopen traffic only after both application services and edge connectivity pass.
rm -f "$runtime_dir/maintenance"
publish_status false ''
maintenance_started=0
echo "Update complete: $APP_BUILD_ID. The app can now refresh to this release."
