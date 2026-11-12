# Эксплуатация и резервные копии

Production-контур запускается из `deploy/compose.yml`. PostgreSQL не публикует
порт наружу, контейнеры имеют healthcheck, а Docker хранит не более пяти логов
по 10 МБ на сервис. Статус `unhealthy` сам по себе не перезапускает контейнер:
для production нужен внешний uptime/disk alert. [Доставка тревог, проверка периметра
и изолированная проверка копии](security-resilience.md) включаются отдельно.

Образ PostgreSQL 18 хранит versioned `PGDATA` внутри `/var/lib/postgresql`,
поэтому именно туда подключён named volume. Перед переносом уже существующего
инстанса со старого mount-path сначала сделайте проверенный `pg_dump`: не
перемещайте production volume между путями вслепую.

## Второй сайт на imlive-cloud

На VPS у проектов один HTTPS-вход. Caddy из `/home/dima/zhiv-app/deploy/compose.yml` обслуживает `im-alive.ru` и передаёт `auto-gorizont.ru` в отдельный контейнер через Unix-сокет. В 0.7.2 [маршрут второго сайта](../../deploy/caddy-sites/im-alive.ru.auto-gorizont.caddy) уже входит в релиз. Caddy подключает его при `DOMAIN=im-alive.ru` и видит сокет по пути `/srv/deploy/avto-gorizont/site.sock`. Образ второго проекта из `/home/dima/avto-gorizont` обновлять для этого релиза не требуется.

На 8 ноября доработки общего Caddy были сохранены на сервере в ветке `deploy/auto-gorizont-live-20261108`, коммит `47f72eb` поверх `9b12b92`. Перед первым переходом на 0.7.2 сравните это состояние с фактическим. Возьмите **полный SHA опубликованного коммита 0.7.2 из master** с успешным CI. Выполните блок на `imlive-cloud` под обычным пользователем с действующим доступом к Docker через `sudo`.

```bash
(
set -euo pipefail
umask 022
cd /home/dima/zhiv-app
git status --short --branch
git log -1 --oneline
test -z "$(git status --porcelain)"
old_head=$(git rev-parse HEAD)
old_branch=$(git branch --show-current)
echo "Исходная версия: ${old_branch:-detached HEAD} $old_head"
if git rev-parse -q --verify '47f72eb^{commit}' >/dev/null && [ "$old_head" != "$(git rev-parse 47f72eb)" ]; then
  git diff 47f72eb HEAD -- deploy
fi
check_site_socket() {
  local socket_path=deploy/runtime/avto-gorizont/site.sock
  sudo test -S "$socket_path" || {
    echo "Не удалось подтвердить Unix-сокет $socket_path. Обновление остановлено." >&2
    return 1
  }
}
check_site_socket
dc() { sudo docker compose --env-file deploy/.env -f deploy/compose.yml "$@"; }
flyway_version() {
  dc exec -T db psql -XAt -v ON_ERROR_STOP=1 -U zhiv -d zhiv \
    -c 'SELECT version FROM flyway_schema_history WHERE success ORDER BY installed_rank DESC LIMIT 1'
}
site_check() {
  local path code
  for path in / /postavki/ /admin/; do
    code=$(curl -sS --max-time 15 --noproxy '*' --resolve auto-gorizont.ru:443:127.0.0.1 \
      -o /dev/null -w '%{http_code}' "https://auto-gorizont.ru$path")
    echo "auto-gorizont.ru$path HTTP $code"
    test "$code" = 401 || return 1
  done
}
site_check
curl -fsS --max-time 20 https://im-alive.ru/readyz
before_version=$(flyway_version)
echo "Flyway перед обновлением: $before_version"
df -h .
read -r -p 'Полный SHA из master: ' release_commit
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
git fetch origin +refs/heads/master:refs/remotes/origin/master
git merge-base --is-ancestor "$release_commit" origin/master
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous_ref="backup/before-0.7.2-$stamp"
git branch "$previous_ref" "$old_head"
echo "Ветка для возврата: $previous_ref ($old_head)"
git switch --no-overwrite-ignore -c "deploy/0.7.2-$stamp" "$release_commit"
check_site_socket
dc config --quiet
dc run --rm --no-deps -T --entrypoint caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null |
  python3 -c '
import json, sys
servers = json.load(sys.stdin)["apps"]["http"]["servers"].values()
hosts = {host: route for server in servers for route in server["routes"]
         for match in route.get("match", []) for host in match.get("host", [])}
assert "im-alive.ru" in hosts
assert "unix//srv/deploy/avto-gorizont/site.sock" in json.dumps(hosts["auto-gorizont.ru"])
'
bash scripts/deploy-update.sh </dev/null
site_check
curl -fsS --max-time 20 -o /dev/null https://im-alive.ru/
curl -fsS --max-time 20 https://im-alive.ru/healthz
curl -fsS --max-time 20 https://im-alive.ru/readyz
curl -fsS --max-time 20 https://im-alive.ru/app-status.json |
  python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["buildId"]); sys.exit(not (s["maintenance"] is False and s["buildId"].startswith(sys.argv[1]+"-")))' "$(git rev-parse --short=12 HEAD)"
test "$(flyway_version)" = 82
)
```

При расхождении с ноябрьским снимком сверьте изменения в `deploy/` до ввода релизного SHA. Если исторического коммита в этом checkout нет, сравните действующие настройки общего Caddy, сокета и Compose с релизом. Запишите имя созданной ветки `backup/before-0.7.2-…`. Она сохраняет фактическую исходную версию, включая checkout с detached HEAD. Переключение в том же каталоге сохраняет прежнюю ветку, `deploy/.env`, каталог секретов и каталог с действующим сокетом. Закрытый режим второго сайта предполагает HTTP 401 на трёх путях. Если владелец открыл публичный сайт, сверьте ожидаемые ответы до и после с новой настройкой доступа.

Скрипт собирает образы, проверяет Caddy и пересоздаёт только его контейнер на общем HTTPS-входе, поэтому возможен короткий разрыв соединения с обоими доменами. Затем во время техработ игры второй сайт продолжает обслуживать запросы. Скрипт останавливает игровой web/API и проверяет итоговый `/home/dima/zhiv-backups/before-update-*.dump` полным восстановлением во временный PostgreSQL до запуска Flyway. Сохраните путь из строки `Backup restored and verified`. После обновления проверьте защищённые страницы с действующими учётными записями обычным входом. Из игровой админки откройте игрока с лодкой и проверьте состояние поездки, улов и место для разгрузки.

Для согласованного **сброса игрового прогресса всех игроков** при выкладке замените вызов скрипта в блоке выше на `bash scripts/deploy-update.sh --reset-game-progress-0.7.2 </dev/null`. Обычный вызов сохраняет прогресс. Скрипт репетирует сброс на восстановленной копии и применяет его один раз для 0.7.2. После завершения запрос из корня репозитория выводит время сброса и новое поколение игровых данных. Пустой результат означает, что сброс ещё не применён. [Что сбрасывается и что сохраняется](reset-game-progress.md).

```bash
sudo docker compose --env-file deploy/.env -f deploy/compose.yml exec -T db \
  psql -X -v ON_ERROR_STOP=1 -U zhiv -d zhiv \
  -c "SELECT completed_at, generation FROM public.gameplay_reset_runs WHERE reset_id = '0.7.2'"
```

**Если обновление прервалось.** Проверьте `sudo docker compose --env-file deploy/.env -f deploy/compose.yml ps -a` и `logs --tail 100 migrate api web caddy` с тем же префиксом. Фактическую версию Flyway посмотрите запросом выше. После устранения причины повторите `bash scripts/deploy-update.sh` в выбранной релизной ветке. Если история Flyway совпадает с исходной, передайте напечатанное имя ветки `backup/before-0.7.2-…` команде `git switch` и запустите штатное обновление прежней версии. После изменения схемы возврат кода сам по себе оставит новую БД. Если нужен откат базы, сохраните её текущее состояние, проверьте **конкретный предмиграционный** dump в изолированной среде и согласуйте переключение восстановленной базы вместе со старым web/API. Если игра успела открыться, учтите принятые после копии записи. Общий Caddy, его том сертификатов, каталог сокета и второй Compose-проект должны остаться на месте. [Проверка восстановления](#проверка-восстановления) и [статус при прерванном обновлении](client-updates.md#если-выпуск-оборвался).

## Перед обновлением

Выпуск **0.7.0** и административное дополнение в `master` используют схему **V52**.
Выпуск **0.7.1** из `0.7.1v2` продолжил её до **V68**; исправления обучения и достижений добавили **V69–V70**. Текущий лесной сосед добавляет **V71**, а параметры его управления и новые начальные настройки — **V72**, сохраняя опубликованные миграции без изменений. [Описание выпуска](../releases/release-0.7.1.md), [выдачи и промокоды](admin-panel.md).
Миграции V46–V49 добавили стартовый набор, Web Push, промокоды и настройки частоты.
При переходе с 0.6.9 применяется **V50** для уведомлений о доступном ягодном сборе
и конкретных результатах заданий. Новых таблиц нет: расширено состояние очереди
и синхронизация занятости сборщика. V47/V49 сохранены без изменений.
Административное дополнение добавляет **V51** для ревизии выдач и **V52** для управляемых промокодов; V50 уведомлений сохранена.
В объединённой ветке **V53** меняет только будущий начальный набор, **V54** расширяет предел jobs до 18,
**V55** добавляет знания товаров/места рынка с повышением ревизии профиля, **V56** отделяет шахтёра
от занятости сборщика в уведомлениях. **V57** разрешает ограниченный публичный контекст
общего сбора ягод в журнале, сохраняя прежние записи и защиту от произвольного JSON. **V58** меняет только начальный вводный заказ будущих профилей на одну малину; существующий прогресс не переписывает. V59–V64 добавляют одноразовую награду обучения, наблюдения безопасности, почту, ручное получение выручки рынка и семь одноразовых подарков. V65–V67 добавляют геопозицию и настройки её видимости. V68 добавляет поколение прогресса и журнал однократных сбросов. V69 хранит состояние обучения аккаунта, V70 расширяет допустимые достижения текущих игровых занятий. V71 добавляет лесного соседа, его поставки, выкупы и отдельные от сброса хозяйства ограничения. V72 расширяет управляемые параметры и обновляет только прежние стандартные настройки соседа. V73 сохраняет обещанные награды, V74 вводит только новый курс v7, V75 расширяет стандартный ассортимент. Коллизия reward-V71 исправляется узким проверенным миграционным переходом; [правила](../development/database-baseline.md#совмещение-веток-072-и-072-bot). Автоматического сброса прогресса нет. Новый старт идёт через B49 → V50–V82; существующая база
master продолжает V-цепочку. Кошельки, оплаченные работы и административный аудит сохраняются.

База, уже обновлённая напрямую из `0.6.9-economy` со старыми экономическими **V50–V52**,
имеет другую историю и не поддерживается этим автоматическим переходом. Мигратор остановится;
не запускайте `repair` или reset для её обхода. Для такой базы нужен отдельный проверенный перенос
после определения применённых SQL и резервного копирования.
Если сервер ранее обновлялся из `work/admin-operations` на `36b9cb5`, отдельный процесс миграций распознаёт только известные старые V50 выдач/V51 промокодов с совпадающими SQL и checksum. После штатной резервной копии и остановки API он атомарно переименовывает эти две записи истории в V51/V52 и применяет недостающую V50 уведомлений. Промокоды, аудит и игровые данные сохраняются; прерванный переход можно продолжить той же командой. Неизвестная или неуспешная история останавливает миграцию. Автоматические `repair`, очистка БД и сброс данных для объединения не используются.
Web и API обновляются вместе; прогресс, начатые работы и каталог хозяйства сохраняются.

В 0.7.2 торговый корабль, Берест, «Дела леса» и хозяйство выходят вместе с лодочной рыбалкой. В раннем кандидате со схемой V80 рыбалка была закрыта. В опубликованной сборке [общий релизный флаг](../../apps/api/src/main/resources/world/release-features.json) включает её для веб-клиента, локального API и Ktor. V81 добавляет индекс рекордов рыбалки, V82 включает автоматические рейтинги улова и тапов. Штатное обновление сохраняет прогресс игроков. [Описание 0.7.2](../releases/release-0.7.2.md), [схема базы](../development/database-baseline.md), [новости для игроков](../../public/updates.json).

На общем VPS воспользуйтесь [процедурой с проверкой обоих сайтов](#второй-сайт-на-imlive-cloud). Для другой установки примените общий порядок ниже.
Получите обновлённый `origin/master` и создайте ветку от точного релизного SHA.
Для старых серверных checkout до объединения истории 0.6.9 не выполняйте
`git pull` с попыткой слияния истории; сохраните прежнюю ветку.

1. Сверить проверки выпуска, включая PostgreSQL integration suite, и указанные в описании исключения.
2. Создать и проверить свежую резервную копию.
3. Из чистого checkout проверенного коммита выполнить `bash scripts/deploy-update.sh`: сборка выполняется при работающем приложении; затем включаются техработы и останавливаются web/API. Итоговый backup создаётся после завершения записи и проверяется настоящим восстановлением в изолированной временной PostgreSQL. Только после этого применяются миграции и обновляются сервисы. Нужны Python 3 и свободное место для временной копии базы. После проверок готовности клиенты автоматически переходят на новую сборку. [Порядок, ограничения первого внедрения и восстановление после ошибки](client-updates.md).
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
Для согласованного игрового перезапуска 0.7.2 используется флаг `--reset-game-progress-0.7.2` у `scripts/deploy-update.sh`: очистка выполняется после миграций до открытия трафика. Подробности —
[сброс игрового прогресса](reset-game-progress.md), включая границу очистки, проверенную копию и защиту от старых вкладок. Повтор запуска того же сброса сохраняет новую игру.

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
  --format=custom --exclude-table-data=public.earth_latest_locations \
  --exclude-table-data=public.earth_frozen_locations \
  --no-owner --no-acl >"${backup_dump}"

docker compose --env-file deploy/.env -f deploy/compose.yml \
  exec -T db pg_restore --list <"${backup_dump}" >/dev/null
restic backup --stdin --stdin-filename zhiv.dump --tag zhiv-db <"${backup_dump}"
restic snapshots --tag zhiv-db --latest 1
)
```

Копия сохраняет схему геопозиции и настройки доступа. Данные временных таблиц
`earth_latest_locations` и `earth_frozen_locations` исключены, чтобы копии
не накапливали историю перемещений.

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
trap 'rm -f -- "$restore_dump"; rmdir -- "$restore_dir"' EXIT
restic dump --tag zhiv-db latest zhiv.dump >"$restore_dump"
python3 scripts/restore-backup-drill.py "$restore_dump" --execute
)
```

Проверку выполняют на отдельной машине с локальным Docker и свободным диском.
Скрипт закрепляет локальный daemon и уникальный project name `zhiv-restore-drill-<uuid>`;
запуск `down --volumes` для production project запрещён. Проверка успешна только
после полного `pg_restore`, чтения Flyway history и удаления временного контура.
Без `--execute` скрипт только проверяет формат входного файла и показывает план.
Целевые ориентиры на старте: RPO не более 24 часов и RTO не более одного часа.

Нельзя автоматически удалять `check_ins` и `check_in_audiences`: это append-only
история приватности. Также нельзя удалять истёкшие bootstrap keys без отдельной
tombstone-модели — повтор старого ключа сможет создать лишний аккаунт.
