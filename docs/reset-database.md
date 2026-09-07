# Полный сброс базы для 0.5.1

Это отдельная, разовая команда владельца. Она удаляет **всю базу `zhiv`**:
пользователей, историю, связи, приглашения, сеансы, привязки способов входа,
коды, незавершённые попытки авторизации и историю миграций. Затем схема
создаётся заново из миграций текущего кода. Перезапуск API очищает и лимиты
запросов, хранящиеся в памяти процесса.

DNS, домен, `deploy/.env`, секреты, роли PostgreSQL, другие базы и Docker volumes
сохраняются. Настройки и сертификаты Caddy остаются прежними. Старые данные
сохраняются только в закрытой резервной копии для восстановления; это не
безвозвратное стирание всех резервных копий. Профили и сеансы в рабочей базе
после операции отсутствуют. Старый браузерный сеанс нужно сменить новым входом.

`reset-user-data.sh` очищает только данные известной схемы V19 и сохраняет
миграции. Для полностью новой базы используется именно `reset-database.sh`.

## Один раз синхронизировать VPS после замены истории master

Выполнить после публикации 0.5.1 в `origin/master`. Не сливать старую feature-ветку
с новым `master`: одинаковые файлы не означают общую историю коммитов.
Из обычной учётной записи, которой принадлежит checkout:

```bash
cd ~/zhiv-app
set -euo pipefail
umask 077
sync_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sync_backup="$(mktemp -d "$HOME/zhiv-before-051.XXXXXX")"
chmod 700 "$sync_backup"
if [[ -f deploy/.env ]]; then sudo cp -a deploy/.env "$sync_backup/deploy.env"; fi
if [[ -d deploy/.secrets ]]; then sudo cp -a deploy/.secrets "$sync_backup/deploy-secrets"; fi
git branch "backup/before-051-$sync_stamp" HEAD
git stash push --include-untracked -m "VPS before 0.5.1 $sync_stamp"
git fetch origin +refs/heads/master:refs/remotes/origin/master
git switch --create "deploy/0.5.1-$sync_stamp" --track origin/master
git log -1 --oneline
git status --short
printf 'Private configuration copy: %s\n' "$sync_backup"
```

Новая локальная ветка точно следует свежему `origin/master`; старые ветки
сохраняются. Изменённые отслеживаемые и неигнорируемые новые файлы попадают в
stash, игнорируемые `.env` и `.secrets` остаются на месте. Если секреты хранятся
по нестандартным путям из `.env`, они тоже остаются на месте; скопировать их
в закрытую копию отдельно. Не применять старый stash целиком: нужные изменения
конфигурации возвращать выборочно после просмотра. Не выполнять `git clean`.
Убедиться, что выведенный коммит — опубликованный 0.5.1 и его CI прошёл успешно.

## Выполнить полный сброс

Обычный предварительный `compose up` не нужен: скрипт сам собирает и запускает
новую версию. Не запускать одновременно с другим деплоем, миграцией или backup.
PostgreSQL должен быть запущен; на диске нужно место для dump и его полной
временной копии.

```bash
cd ~/zhiv-app
sudo bash scripts/reset-database.sh --confirm-delete-database
```

На запрос в терминале ввести **`RESET zhiv`**. Скрипт сначала собирает образы.
Затем останавливает Caddy, web, API и одноразовые сервисы, делает `pg_dump`
в `../zhiv-backups` с закрытыми правами и полностью восстанавливает его во
временную базу. Ошибка сборки, dump или восстановления останавливает операцию
до удаления рабочей базы. После проверки копии скрипт удаляет только `zhiv`,
создаёт её заново, выполняет `provision` и `migrate`, проверяет пустоту всех
таблиц приложения и запускает сервисы с ожиданием healthcheck. История Flyway
будет новой и заполненной выполненными миграциями.

После успеха открыть сайт в новой вкладке и пройти регистрацию заново.
Старые приглашения, сеансы и профили больше не действуют. При желании очистить
локальные данные сайта в браузере; серверные данные уже очищены. Проверить:

```bash
sudo docker compose --env-file deploy/.env -f deploy/compose.yml ps
sudo docker compose --env-file deploy/.env -f deploy/compose.yml logs --tail=100 api
```

## Если произошла ошибка

Не запускать сброс повторно вслепую: новая копия после удаления базы уже не
содержит старые данные. Скрипт печатает путь к исходному dump и указывает,
была ли старая база удалена. Сервисы могут остаться остановленными, в том
числе после ошибки миграции или healthcheck. После устранения причины
запустить обычный деплой — он повторит provision/migrate и healthcheck:

```bash
sudo docker compose --env-file deploy/.env -f deploy/compose.yml up --build -d --wait --wait-timeout 240
```

Перезапуск не восстанавливает старые данные. Для явного отката данных использовать
**исходный проверенный dump**, путь к которому вывел скрипт; команда ниже снова
заменяет текущую `zhiv`, поэтому нужна отдельная осознанная операция владельца:

```bash
sudo bash
cd /home/YOUR_USER/zhiv-app
set -euo pipefail
read -r -p 'Absolute path to verified original dump: ' restore_dump
test -s "$restore_dump"
read -r -p 'Type RESTORE zhiv to replace current data: ' restore_confirmation
[[ $restore_confirmation == 'RESTORE zhiv' ]]
compose=(docker compose --env-file deploy/.env -f deploy/compose.yml)
"${compose[@]}" stop caddy web api provision migrate
"${compose[@]}" exec -T db dropdb -U zhiv --maintenance-db=postgres --if-exists zhiv
"${compose[@]}" exec -T db createdb -U zhiv --template=template0 --owner=zhiv zhiv
"${compose[@]}" exec -T db pg_restore -U zhiv -d zhiv --exit-on-error < "$restore_dump"
"${compose[@]}" run --rm --no-deps provision
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 240 api web caddy
exit
```

Заменить `/home/YOUR_USER/zhiv-app` фактическим путём. Восстановление возвращает
данные копии и применяет миграции текущего релиза; это не откат к старому коду.
Не использовать для production `docker compose down -v` и не удалять volumes.
Для защиты от потери VPS нужна также копия вне VPS, см. `operations.md`.

Основания команд: [PostgreSQL: pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html),
[PostgreSQL: dropdb](https://www.postgresql.org/docs/current/app-dropdb.html),
[Docker Compose: up](https://docs.docker.com/reference/cli/docker/compose/up/).
