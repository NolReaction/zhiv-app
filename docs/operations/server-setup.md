## Selectel VPS

Нужны Linux, Docker с Compose v2, Node.js 24, OpenSSL и домен, направленный на VPS. Caddy принимает HTTPS; PostgreSQL, API и web доступны только внутри Docker-сетей.

Все команды выполняются из корня репозитория. Для **нового сервера**:

```bash
cp deploy/.env.example deploy/.env
node scripts/create-deploy-secrets.mjs
bash scripts/create-auth-secret.sh
```

Скрипты создают отдельные пароли БД и ключ защиты email-кодов, сохраняя существующие файлы. На действующем сервере редактируйте имеющийся `deploy/.env`; в `db_admin` должен оставаться настоящий пароль существующей БД.

### ВК и почта

1. Создайте веб-приложение в кабинете [VK ID](https://github.com/VKCOM/vkid-web-sdk). Укажите свой домен и точный redirect URI `https://zhiv.example.ru/api/v1/auth/vk/callback`, заменив домен своим. APP_ID используется как `VK_CLIENT_ID`; `client_secret` для реализованного PKCE-потока не нужен.
2. В [почтовом сервисе Selectel](https://docs.selectel.ru/email-service/connect-email-service/) создайте ресурс, подтвердите домен и настройте TXT, DKIM, SPF и DMARC по инструкции. SMTP-логин и пароль находятся во вкладке «Информация». У домена должна быть одна SPF-запись.
3. Сохраните SMTP-пароль в отдельный файл:

```bash
touch deploy/.secrets/auth/smtp_password
chmod 600 deploy/.secrets/auth/smtp_password
nano deploy/.secrets/auth/smtp_password
chmod 444 deploy/.secrets/auth/smtp_password
nano deploy/.env
```

В файл пароля вставьте только значение, без кавычек и `SMTP_PASSWORD=`. В `.env` измените соответствующие строки, сохранив настройки БД и не создавая дубликатов:

```dotenv
DOMAIN=zhiv.example.ru
VK_CLIENT_ID=APP_ID_FROM_VK_ID
TELEGRAM_CLIENT_ID=
TELEGRAM_CLIENT_SECRET_FILE=
SMTP_HOST=smtp.mail.selcloud.ru
SMTP_PORT=1126
SMTP_TLS_MODE=starttls
SMTP_USER=SMTP_LOGIN_FROM_SELECTEL
SMTP_PASSWORD_FILE=/run/auth-secrets/smtp_password
SMTP_FROM=login@zhiv.example.ru
AUTH_CODE_SECRET_FILE=/run/auth-secrets/code_secret
```

Замените домен, APP_ID и SMTP-логин своими значениями. APP_ID — число; `SMTP_FROM` — адрес подтверждённого домена. Пути `/run/auth-secrets/...` относятся к контейнеру API.

Selectel использует порт 1126 с STARTTLS; обычные исходящие SMTP-порты 25/465/587 [ограничены](https://docs.selectel.ru/infrastructure/blocked-ports/). Секреты исключены из Git и Docker build context. Подробности: [настройка входа](../../docs/operations/auth-0.5.0.md).

### Спутниковая карта MapTiler

Опциональный `NEXT_PUBLIC_MAPTILER_KEY` задаётся в существующем `deploy/.env` перед сборкой web. Без значения обычная карта продолжает работать. Compose передаёт ключ как build argument в `deploy/web.Dockerfile`: Next встраивает его в браузерный JavaScript при `npm run build:vps`. После смены ключа нужна пересборка web через обычный процесс обновления; перезапуск контейнера или новая runtime-переменная не меняют готовый bundle. Корневой `.env.local` исключён из Docker build context и не подменяет `deploy/.env`.

Используйте собственный публичный браузерный ключ MapTiler с разрешённым hostname рабочего сайта, например `im-alive.ru` (без протокола и порта). Ключ, ограниченный `localhost`/`127.0.0.1`, для этого домена не подходит: сначала добавьте адрес в разрешения MapTiler. Ключ виден посетителям в JavaScript и запросах тайлов; он не должен давать доступ к административным операциям. Реальные значения остаются в игнорируемых env-файлах: не добавляйте их в Git и не публикуйте вывод `docker compose config` без `--quiet`, build arguments или полные URL запросов. Пустые примеры безопасны для сборки без спутникового слоя. Для Sites ключ также задаётся до сборки, см. [локальную разработку](../development/local-development.md#спутниковая-карта-maptiler).

### Первый запуск

Следующие команды предназначены для первого запуска с подготовленными настройками и секретами. Для существующего сервера используйте процесс обновления ниже.

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build --wait --wait-timeout 240
docker compose --env-file deploy/.env -f deploy/compose.yml ps -a
curl --fail --show-error --max-time 20 https://zhiv.example.ru/readyz
curl --fail --show-error --max-time 20 https://zhiv.example.ru/api/v1/auth/options
```

В `curl` замените домен своим. Compose запускает подготовку ролей БД и отдельный процесс миграций перед API; текущий `master` 0.7.0 включает миграции до **V52**, в том числе стартовый набор, Web Push, промокоды и настройки частоты уведомлений. После 0.6.9 добавлена V50 для доступных ягодных напоминаний, затем V51/V52 для административных выдач и управляемых промокодов; данные сохраняются. Состав обновления — в [описании выпуска](../releases/release-0.7.0.md), административное дополнение — в [описании панели](admin-panel.md).

Проверьте `vk:true,email:true`, затем настоящий вход через ВК и доставку письма. Эти флаги показывают наличие конфигурации, а не успешность внешних сервисов. Без настроенных ВК/почты текущая форма входа сообщает о недоступности входа; для публичного запуска настройте хотя бы один из этих провайдеров. Регистрация только по имени используется в локальном DEV-контуре и не заменяет настройку production-входа.

На старом открытом профиле сначала привяжите ВК или почту, затем проверьте вход во втором браузере и сохранение публичного ID. Отдельно созданные профили объединяются в разделе «Управление профилем» после подтверждения доступа к обоим. Имя, статус и конфликтующие привязки выбираются перед подтверждением; старые отметки не открываются новым людям. Подробнее: [управление профилем 0.5.1](../../docs/operations/account-0.5.1.md). Обычный вход сохраняет остальные сеансы; восстановление резервным кодом отзывает их. Публичный ID можно передавать людям, резервный код — нельзя. Не удаляйте production volume командой `down -v`.

Для полного начала с нуля используйте [отдельный ручной сброс базы](../../docs/operations/reset-database.md): скрипт проверяет резервную копию полным восстановлением и заново создаёт схему. При обычном обновлении сброс не нужен.

### Ошибки сервера

При серверной ошибке интерфейс показывает код запроса. Найдите его в логах:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml logs --since=30m --no-color api
```

События `api_failure` содержат `request_id`, операцию, статус и безопасную причину без паролей, почты и кодов входа. Подробности: [диагностика API](../../apps/api/DIAGNOSTICS.md).

### Обновление существующего сервера

Дождитесь полного CI для конкретного SHA из `master`, получите его в чистый checkout и запустите `bash scripts/deploy-update.sh`. Скрипт включает резервную копию, режим техработ и принудительное применение конфигурации Caddy. Команда с закреплённым SHA и проверки: [эксплуатация](operations.md#перед-обновлением). Сброс БД не нужен.
