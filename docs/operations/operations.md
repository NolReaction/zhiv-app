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

Выпуск **0.7.0** и административное дополнение в `master` используют схему **V52**.
Объединённая ветка `work/0.7.0` продолжает её до **V56**, сохраняя SQL V1–V52 без изменений. [Описание выпуска](../releases/release-0.7.0.md), [выдачи и промокоды](admin-panel.md).
Миграции V46–V49 добавили стартовый набор, Web Push, промокоды и настройки частоты.
При переходе с 0.6.9 применяется **V50** для уведомлений о доступном ягодном сборе
и конкретных результатах заданий. Новых таблиц нет: расширено состояние очереди
и синхронизация занятости сборщика. V47/V49 сохранены без изменений.
Административное дополнение добавляет **V51** для ревизии выдач и **V52** для управляемых промокодов; V50 уведомлений сохранена.
В объединённой ветке **V53** меняет только будущий начальный набор, **V54** расширяет предел jobs до 18,
**V55** добавляет знания товаров/места рынка с повышением ревизии профиля, **V56** отделяет шахтёра
от занятости сборщика в уведомлениях. Новый старт идёт через B49 → V50–V56; существующая база
master продолжает V-цепочку. Кошельки, оплаченные работы и административный аудит сохраняются.

База, уже обновлённая напрямую из `0.6.9-economy` со старыми экономическими **V50–V52**,
имеет другую историю и не поддерживается этим автоматическим переходом. Мигратор остановится;
не запускайте `repair` или reset для её обхода. Для такой базы нужен отдельный проверенный перенос
после определения применённых SQL и резервного копирования.
Если сервер ранее обновлялся из `work/admin-operations` на `36b9cb5`, отдельный процесс миграций распознаёт только известные старые V50 выдач/V51 промокодов с совпадающими SQL и checksum. После штатной резервной копии и остановки API он атомарно переименовывает эти две записи истории в V51/V52 и применяет недостающую V50 уведомлений. Промокоды, аудит и игровые данные сохраняются; прерванный переход можно продолжить той же командой. Неизвестная или неуспешная история останавливает миграцию. Автоматические `repair`, очистка БД и сброс данных для объединения не используются.
Web и API обновляются вместе; прогресс, начатые работы и каталог хозяйства сохраняются.

Выпуск объединяет `0.6.9-update` и `0.6.9-light` одним новым коммитом в `master`.
Прежнее исключение повторных проверок при оформлении 0.6.9 к нему не относится.
[Состояние проверок 0.7.0](../releases/release-0.7.0.md#проверки).
Получите обновлённый `origin/master` и создайте ветку от точного релизного SHA.
Для старых серверных checkout до объединения истории 0.6.9 не выполняйте
`git pull` с попыткой слияния истории; сохраните прежнюю ветку.

1. Сверить проверки выпуска, включая PostgreSQL integration suite, и указанные в описании исключения.
2. Создать и проверить свежую резервную копию.
3. Из чистого checkout проверенного коммита выполнить `bash scripts/deploy-update.sh`: сборка и проверенный backup выполняются при работающем приложении; затем включаются техработы, применяются миграции и обновляются сервисы. После проверок готовности клиенты автоматически переходят на новую сборку. [Порядок, ограничения первого внедрения и восстановление после ошибки](client-updates.md).
4. Проверить главную страницу, `/healthz` и `/readyz`, затем просмотреть логи API.

Чтобы обновление использовало именно выбранный релизный коммит из `master`, а не
произвольное состояние рабочей ветки, на сервере выполните:

```bash
(
set -euo pipefail
umask 022
cd ~/zhiv-app
git diff --quiet
git diff --cached --quiet
read -r -p 'Full published release commit SHA: ' release_commit
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
git fetch origin +refs/heads/master:refs/remotes/origin/master
git merge-base --is-ancestor "$release_commit" FETCH_HEAD
git switch -c "deploy/$(date +%Y%m%d-%H%M%S)" "$release_commit"
bash scripts/deploy-update.sh
curl -fsS --max-time 20 --output /dev/null \
  --write-out 'Главная: HTTP %{http_code}\n' https://im-alive.ru/
curl -fsS --max-time 20 https://im-alive.ru/readyz
)
```

Для другой установки замените путь и домен. Проверка ancestry подтверждает,
что коммит входит в `master`; результаты проверок и их исходный SHA сверяются с описанием выпуска.
Скрипт развёртывает снимок выбранного коммита целиком и не сливает рабочие ветки.
Сброс пользователей или игрового прогресса — отдельная операция владельца;
обычное обновление её не выполняет. [Очистка всех пользователей](reset-user-data.md)
и [полный сброс БД](reset-database.md) удаляют аккаунты, поэтому не подходят для
обнуления только игровых достижений или выдачи стартовой валюты.
Для будущего общего перезапуска игры с сохранением входов и друзей подготовлен
[отдельный сброс игрового прогресса](reset-game-progress.md), включая предварительный
просмотр и ограничения для старых открытых клиентов.

Для получения кода и сборки используйте `umask 022`. Закрытые права `umask 077`
ограничивайте отдельной подоболочкой резервного копирования, как в примере ниже,
чтобы они не меняли права последующих checkout и сборок.

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
(
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
)
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
