# Жив

PWA с одной главной кнопкой: пользователь нажимает **«Я ЖИВ»**, а сервер сохраняет подтверждённое время. Отображение отметки людям и группам — следующий вертикальный срез, не скрытое обещание текущего MVP.

## Первый срез

- onboarding только с именем;
- случайный публичный ID, не связанный с именем;
- серверная сессия в `HttpOnly` cookie;
- идемпотентное создание профиля: потерянный ответ не плодит аккаунты;
- большая кнопка с цветом от зелёного к красному за 24 часа;
- мемная серия повторных нажатий и конфетти на пятом;
- серверный cooldown 30 секунд и `Idempotency-Key`;
- append-only события для будущего календаря;
- схема `DIRECT`-связей, групп и снимков аудитории уже в миграциях;
- PWA shell работает офлайн, `/api/**` никогда не кэшируется и не ставится в очередь.

## Запуск

Весь production-контур:

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yml up --build
```

Только интерфейс с временным in-memory API-адаптером:

```bash
npm ci
npm run dev:vps
```

Dev-адаптер повторяет HTTP-контракт Ktor, но стирает данные после перезапуска. В production Caddy отправляет `/api/**` в Ktor/PostgreSQL.

## Проверки

```bash
npm run lint
npm test
cd apps/api && gradle test
```

Backend рассчитан на JDK 25 и Gradle 9.5. В IntelliJ IDEA достаточно открыть корень проекта, импортировать `apps/api/build.gradle.kts` как Gradle-модуль и использовать сохранённую конфигурацию **API · Ktor** — она явно задаёт `APP_ENV=development`. В остальных способах запуска `APP_ENV` обязателен, чтобы сервер не перешёл в небезопасный режим из-за опечатки в окружении. PostgreSQL-интеграционный тест автоматически пропускается без Docker.

## Репозиторий

```text
app/                         React/Next маршруты и PWA manifest
components/                  продуктовые UI-компоненты
lib/                         API-контракт и чистая логика интерфейса
public/                      service worker и иконка
apps/api/                    Ktor API, JDBC и Flyway migrations
deploy/                      Docker Compose, Caddy, образы
docs/                        требования, ERD, решения и VPS
tests/                       тесты web-домена
```

Документы: [требования](docs/requirements.md), [архитектура и ERD](docs/architecture.md), [VPS в РФ](docs/vps.md).
