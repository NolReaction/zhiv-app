# Я живой

PWA для короткой отметки близким: нажмите **«Я ЖИВОЙ»**, и выбранные люди увидят подтверждённое сервером время. Работает в браузере и устанавливается на главный экран телефона.

**Версия:** 0.5.0 · **Стек:** React 19, Next.js 16, Kotlin/Ktor, PostgreSQL 18, Docker Compose, Caddy.

## Возможности

- Вход через VK ID или одноразовый код на почту; несколько способов входа в один профиль.
- Личные связи и группы с приглашениями по ID, одноразовой ссылке или QR.
- Управление доступом к новым отметкам; старая история не открывается задним числом.
- Статусы со сроком действия, избранные люди, личные подписи и поиск по имени.
- Управление сеансами и резервный код восстановления.
- Ежедневная серия отметок и небольшая игра с локальными рекордами.

Отметка считается отправленной после ответа сервера. Без сети она не ставится в очередь. Цвет показывает давность отметки и не означает экстренную ситуацию. Игровые рекорды хранятся в текущем браузере.

## Локальный запуск

Нужен Node.js 24.

```bash
npm ci
npm run dev:local
```

Откройте `http://localhost:3000`. Локальный API хранит данные в памяти и создаёт профиль по имени; после перезапуска данные могут исчезнуть. Настоящий вход через ВК и почту обслуживает Ktor API в серверном контуре.

Для телефона в одной сети создайте `.env.local` по [.env.example](.env.example), укажите адрес компьютера и запустите `npm run dev:lan`. Всем участникам теста нужен одинаковый адрес приложения. Установку PWA и системные возможности браузера проверяйте через HTTPS.

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

Selectel использует порт 1126 с STARTTLS; обычные исходящие SMTP-порты 25/465/587 [ограничены](https://docs.selectel.ru/infrastructure/blocked-ports/). Секреты исключены из Git и Docker build context. Подробности: [настройка входа](docs/auth-0.5.0.md).

### Запуск и обновление

Перед обновлением сделайте [резервную копию с проверкой восстановления](docs/operations.md), затем переключитесь на `master` и получите проверенный коммит через `git pull --ff-only origin master`.

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build --wait --wait-timeout 240
docker compose --env-file deploy/.env -f deploy/compose.yml ps -a
curl --fail --show-error --max-time 20 https://zhiv.example.ru/readyz
curl --fail --show-error --max-time 20 https://zhiv.example.ru/api/v1/auth/options
```

В `curl` замените домен своим. Compose запускает подготовку ролей БД и отдельный процесс миграций перед API; текущая схема включает V16.

Проверьте `vk:true,email:true`, затем настоящий вход через ВК и доставку письма. Эти флаги показывают наличие конфигурации, а не успешность внешних сервисов. Без настроенных провайдеров сохраняется прежняя регистрация по имени.

На старом открытом профиле сначала привяжите ВК или почту, затем проверьте вход во втором браузере и сохранение публичного ID. Отдельно созданные профили автоматически не объединяются. Обычный вход сохраняет остальные сеансы; восстановление резервным кодом отзывает их. Публичный ID можно передавать людям, резервный код — нельзя. Не удаляйте production volume командой `down -v`.

## Проверки

```bash
npm run lint
npm run typecheck
npm run build:vps
npm test
```

`npm test` включает сборку дополнительного Sites-контура и веб-тесты. Для Ktor нужны JDK 25 и Docker:

```bash
cd apps/api
./gradlew test
```

CI проверяет web, Ktor, PostgreSQL и запуск production Compose. Реальные VK/SMTP и поведение iPhone PWA проверяются отдельно.

## Репозиторий и документация

`app/`, `components/`, `lib/` — web; `apps/api/` — API и миграции; `deploy/` — контейнеры; `tests/` — веб-тесты.

- [Вход через ВК и почту](docs/auth-0.5.0.md)
- [VPS](docs/vps.md)
- [Эксплуатация и резервные копии](docs/operations.md)
- [Изменения 0.5.0](docs/release-0.5.0.md)
- [Ревью и следующие приоритеты](docs/review-0.5.0.md)
