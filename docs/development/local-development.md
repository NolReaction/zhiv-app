# Локальная разработка и проверки

[Документация](../README.md) · [Архитектура](../architecture.md) · [Правила изменений](../../CONTRIBUTING.md)

## Быстрый старт

Нужен Node.js ≥ 22.13 (CI использует 24). Для Kotlin API — JDK 25 и Docker для PostgreSQL-тестов. Next-разработка работает отдельно от API и не требует PostgreSQL.

```bash
git status --short
git branch --show-current
npm ci
npm run dev:local
```

Откройте `http://localhost:3000`. Если порт занят, Next напечатает выбранный порт. `dev:mochlik` — alias того же Next-запуска. Локальный экран регистрации создаёт тестовый аккаунт; данные в памяти процесса и могут исчезнуть при перезапуске.

После изменения зависимостей используйте `npm ci` по lockfile. В управляемом Sites-окружении предусмотрен `npm run install:ci`: это Bash-скрипт с ограничением времени и проверкой архива Vinext. Он не обязателен для обычного Next-запуска на компьютере.

## Телефон в той же сети

Создайте `.env.local` по [.env.example](../../.env.example), заменив адрес на активный IPv4 компьютера:

```dotenv
NEXT_ALLOWED_DEV_ORIGINS=192.168.1.20
NEXT_PUBLIC_APP_ORIGIN=http://192.168.1.20:3000
```

```bash
npm run dev:lan
```

На телефоне откройте `http://192.168.1.20:3000`. В `NEXT_ALLOWED_DEV_ORIGINS` указывается hostname/IP без протокола; несколько значений разделяются запятыми. `NEXT_PUBLIC_APP_ORIGIN` содержит полный origin и используется для ссылок. При другом порте замените его и в адресе, и в настройке; после изменения env перезапустите Next.

Если не открывается: проверьте одинаковую сеть, актуальный IP, разрешение входящих соединений в firewall и изоляцию Wi-Fi-клиентов. `localhost` на телефоне — сам телефон. Обычный HTTP в LAN подходит для UI; проверка Service Worker/установки PWA требует localhost или HTTPS.

## Два контура сборки

| Назначение | Разработка | Сборка | Запуск сборки |
|---|---|---|---|
| Next/VPS | `npm run dev:local` или `dev:lan` | `npm run build:vps` | `npm run start:vps` |
| Sites/Vinext | `npm run dev` | `npm run build` | `npm run start` |

`dev:vps` также запускает Next на `0.0.0.0`, а не контейнеры. `build:vps` создаёт `.next/`; Sites создаёт `dist/`. Sites-скрипты используют Bash; на Windows для них нужен совместимый Bash/WSL. Не заменяйте один контур другим при релизной проверке.

Production-сборка Next сама не запускает Ktor. На VPS маршрутизацию обеспечивает [Caddy](../../deploy/Caddyfile). Без него локальный production API закрыт: `DEV_API_DISABLED` — ожидаемый ответ, а не сломанная БД. Проверка настоящих входа, прав и миграций выполняется через серверный стек; инструкции — [эксплуатация](../operations/operations.md).

## Карта и графика

Во втором терминале:

```bash
npm run world:watch
```

Редактируйте `world/tiled/forest.tmj` и сохраняйте. Watcher обновляет [forest.generated.json](../../features/world/tiled/forest.generated.json) и сохраняет последний корректный результат при ошибке. Однократный экспорт — `npm run world:export`, проверка соответствия без записи — `npm run world:check`. Подробнее: [Tiled](../game/tiled-editor.md), [свет](../game/world-lighting.md).

DEV-панель в приложении доступна при разработке; она управляет тестовыми условиями сцены. Для изолированной карты есть `/prototype/tiled-world`. Проверьте и круг главной кнопки, и большую карту: они используют одни данные, но разную камеру.

`world:export` не конвертирует PNG в WebP. Ручной экспорт и версии браузерных картинок — [art/README.md](../../art/README.md). [scripts/prepare-world-assets.mjs](../../scripts/prepare-world-assets.mjs) и [описание прежней загрузки мира](../game/world-loading.md) относятся к legacy-карте; не используйте их для экспорта текущей Tiled-разметки.

## Проверки

Для обычной правки сначала выберите регрессию по [функции приложения](app-features.md) или по соответствующей странице мира. Не запускайте весь набор заново после изменения только текста документации.

```bash
npm run typecheck
npm run lint
npm run world:check
```

Полный веб-набор со свежей Sites-сборкой:

```bash
npm test
npm run build:vps
```

`npm test` выполняет `npm run build`, затем `node --test --test-concurrency=1 tests/*.test.mjs`. `npm run test:web` запускает только тесты и **не пересобирает** `dist/`. Часть тестов читает готовую сборку; после изменения runtime-кода она должна быть актуальной. Сборки и тесты, читающие `dist/`, выполняйте последовательно.

Для точечной проверки после актуальной Sites-сборки:

```bash
node --test --test-concurrency=1 tests/forest-lighting.test.mjs tests/new-map-scene.test.mjs
```

Серверный набор из корня репозитория:

```bash
cd apps/api
./gradlew --no-daemon test
```

В Windows используйте `gradlew.bat --no-daemon test`. Нужны JDK 25 и работающий Docker для integration tests. Пропущенная PostgreSQL suite не считается проверкой БД. Точные CI-gates описаны в [.github/workflows/ci.yml](../../.github/workflows/ci.yml): lint, types, обе сборки, веб-тесты, Ktor/PostgreSQL и Compose smoke на изолированных данных.

## Быстрая диагностика

| Симптом | Что проверить |
|---|---|
| После перезапуска пропал локальный аккаунт | Это memory API. Создайте новый тестовый профиль; production-аккаунт хранится в PostgreSQL |
| UI работает, вход через провайдера недоступен | Локальный API не выполняет OAuth/SMTP; проверьте нужный серверный контур |
| Карта не обновилась | Ошибка в выводе `world:watch`, затем `world:check`; для нового изображения нужен отдельный WebP-экспорт |
| Свет не виден | DEV → Ночь, наличие точки `Lights`, `intensity`, радиус и её положение; [инструкция](../game/world-lighting.md) |
| Старые изображения после обновления | Сравните versioned URL/runtime-каталог; не начинайте с удаления всех пользовательских данных |
| Тапы ожидают подтверждения | Значок сервера/очередь, сеть, request ID; [разбор синхронизации](../game/game-sync-reliability.md) |
| API вернул 5xx | Сохраните request ID и используйте [инструкцию инцидентов](../operations/incident-response.md) |

После проверки просмотрите `git diff`, добавьте только относящиеся к задаче изменения и кратко обновите `WORK_STATE.md`. Публикация ветки и деплой — разные действия; команды обновления сервера не нужны для локальной правки.
