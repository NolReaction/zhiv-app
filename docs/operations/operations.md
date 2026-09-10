# Эксплуатация и резервные копии

Production-контур запускается из `deploy/compose.yml`. PostgreSQL не публикует
порт наружу, контейнеры имеют healthcheck, а Docker хранит не более пяти логов
по 10 МБ на сервис. Статус `unhealthy` сам по себе не перезапускает контейнер:
для production нужен внешний uptime/disk alert.

Образ PostgreSQL 18 хранит versioned `PGDATA` внутри `/var/lib/postgresql`,
поэтому именно туда подключён named volume. Перед переносом уже существующего
инстанса со старого mount-path сначала сделайте проверенный `pg_dump`: не
перемещайте production volume между путями вслепую.

## Перед обновлением

1. Убедиться, что CI прошёл полностью, включая PostgreSQL integration suite.
2. Создать и проверить свежую резервную копию.
3. Из чистого checkout проверенного коммита выполнить `bash scripts/deploy-update.sh`: скрипт повторно сохраняет и проверяет backup, применяет миграции, обновляет сервисы и пересоздаёт Caddy.
4. Проверить главную страницу, `/healthz` и `/readyz`, затем просмотреть логи API.

Compose сначала запускает `provision` для подготовки ролей, затем отдельный сервис
`migrate` с Flyway. API стартует после успешных миграций и сам схему не меняет.
Миграции добавляются новыми файлами; автоматического отката схемы нет.

## Зашифрованный backup вне VPS

Рекомендуемый минимум — ежедневный `pg_dump` PostgreSQL 18 в restic-репозиторий
на отдельном S3-compatible хранилище. Restic шифрует данные до отправки.
Пароль репозитория необходимо хранить также вне VPS, например в password
manager; без него копии восстановить невозможно.

На хосте задаются `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, S3 credentials и
путь к production env-файлу. Пример одного запуска из корня репозитория:

```bash
set -euo pipefail
umask 077
backup_dump="$(mktemp /var/tmp/zhiv-backup.XXXXXX.dump)"
trap 'rm -f -- "${backup_dump}"' EXIT

docker compose --env-file deploy/.env -f deploy/compose.yml \
  exec -T db pg_dump --username zhiv --dbname zhiv \
  --format=custom --no-owner --no-acl >"${backup_dump}"

docker compose --env-file deploy/.env -f deploy/compose.yml \
  exec -T db pg_restore --list <"${backup_dump}" >/dev/null
restic backup --stdin --stdin-filename zhiv.dump --tag zhiv-db <"${backup_dump}"
restic snapshots --tag zhiv-db --latest 1
```

Временный dump содержит пользовательские данные и создаётся с доступом только
для пользователя запуска. Используйте зашифрованный диск; файл удаляется даже при ошибке.
Задание следует запускать systemd timer с `Persistent=true` и уведомлением через
`OnFailure=`. Ориентир хранения: 14 daily, 8 weekly, 12 monthly. `restic forget
--prune` и `restic check` лучше выполнять отдельным еженедельным заданием.

## Проверка восстановления

`restic check` не заменяет реальный restore. Не реже раза в месяц последняя
копия восстанавливается в отдельный Compose project без портов и production
volume:

```bash
(
set -euo pipefail
umask 077
restore_dir="$(mktemp -d /var/tmp/zhiv-restore.XXXXXX)"
restore_dump="$restore_dir/zhiv.dump"
restore_env="$restore_dir/compose.env"
restore_compose=(
  docker compose
  --project-name zhiv-restore-drill
  --env-file "$restore_env"
  -f deploy/restore.compose.yml
)

cleanup() {
  "${restore_compose[@]}" down --volumes --remove-orphans || true
  rm -f -- "$restore_dump" "$restore_env"
  rmdir -- "$restore_dir"
}
trap cleanup EXIT

printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" >"$restore_env"
restic dump --tag zhiv-db latest zhiv.dump >"$restore_dump"

"${restore_compose[@]}" up --detach --wait
"${restore_compose[@]}" exec -T db \
  pg_restore --username zhiv_restore --dbname zhiv_restore \
  --no-owner --no-acl --exit-on-error <"$restore_dump"
"${restore_compose[@]}" exec -T db \
  psql --username zhiv_restore --dbname zhiv_restore \
  --tuples-only --command \
  "SELECT version FROM flyway_schema_history WHERE success ORDER BY installed_rank DESC LIMIT 1;"
)
```

Команда очистки всегда указывает отдельный project name `zhiv-restore-drill`;
запуск `down --volumes` для production project запрещён. Проверка успешна только
после полного `pg_restore`, чтения Flyway history и удаления временного контура.
Целевые ориентиры на старте: RPO не более 24 часов и RTO не более одного часа.

Нельзя автоматически удалять `check_ins` и `check_in_audiences`: это append-only
история приватности. Также нельзя удалять истёкшие bootstrap keys без отдельной
tombstone-модели — повтор старого ключа сможет создать лишний аккаунт.
