# Мохлик · мобильный клиент 0.3.1

Ветка `experiment/native-mobile`, draft [PR №41](https://github.com/NolReaction/zhiv-app/pull/41), база `master` `493d399`. Версия 0.3.1/build 4, app ID `ru.zhiv.mochlik.lab`. Master, production, реальные аккаунты и ключи провайдеров не менялись.

## Текущий этап: Android на Kotlin

По просьбе пользователя все 12 собственных Android-классов и два прежних JUnit-набора переведены с Java на Kotlin. Код — `apps/mobile/android/app/src/main/kotlin/ru/zhiv/mochlik/lab`, тесты — `src/test/kotlin/ru/zhiv/mochlik/lab`. Новые собственные Android-модули пишутся на Kotlin; готовые зависимости Capacitor/Android не переписываются.

- Kotlin 2.3.21, AGP 8.13.2, Gradle 8.14.3, JDK/JVM target 21. Сгенерированные Capacitor Gradle-файлы остаются управляемыми `cap sync`.
- Сохранены имена плагинов/методов и классов Android, callback разрешения, SQLite schema v2/имя базы/SQL, Preferences и Keystore alias/AES-GCM AAD. Перевод языка не требует удаления приложения или сброса данных; обновление требует прежней подписи.
- Сохранены очереди и глобальные блокировки, ссылочные проверки запросов/Task, session/generation/epoch/launch-ticket fences, пределы HTTP, отмена и timeout, foreground service, условия приватности и push opt-in.
- Исправлена существовавшая в Java ошибка push-поколения: Capacitor `getLong` не принимает обычный JSON Integer. Три операции теперь используют строгий `NativePushGeneration` для Int/Long в безопасном диапазоне JavaScript; неверные типы/дроби/отрицательные значения отклоняются. Добавлены тесты реального JSObject/PluginCall JSON roundtrip.
- `NativeBridgeContractTest` проверяет публичные JVM-имена/сигнатуры, конструкторы компонентов и reflection callback после перевода. Дополнена проверка null Intent extras. Предыдущие assertions сохранены.
- Независимая проверка исправила nullable `onNewIntent`/LocationManager и явное Float→Double для прежнего JSON-представления точности. Интерфейс игры остаётся общим React/TypeScript; iOS-код остаётся Swift.

## Проверки текущих изменений

- Локально: **186/186** mobile JS tests, TypeScript, ESLint, architecture **1334 modules**, mobile build и cap sync обеих платформ — success.
- Android: полный Gradle `assembleDebug lintDebug testDebugUnitTest` прошёл, после последних nullable-правок повторно прошли app APK/lint/JUnit; **16/16** собственных Kotlin-тестов, без ошибок/пропусков. Проверен фактический merged manifest push-службы.
- Secret scan: 0 находок. Проверка свежести экономического отчёта: 68 сценариев.
- Код `c38e554` прошёл [native CI](https://github.com/NolReaction/zhiv-app/actions/runs/43616319573): Android Kotlin main/test compilation, APK/lint/JUnit, 186/186 mobile JS и merged manifest; iOS Simulator/unsigned iPhone и 49 Swift policy assertions. Число 16/16 Kotlin-тестов подтверждено локальными XML, CI подтверждает успешное выполнение JUnit task. [APK этого коммита](https://github.com/NolReaction/zhiv-app/actions/runs/43616319573/artifacts/14122736800).
- Код `c38e554` прошёл [общий CI](https://github.com/NolReaction/zhiv-app/actions/runs/43616319605): Web **8756/8756** (2787 + 3064 + 2905), Ktor/PostgreSQL **1401/1401**, migration/gifts **79/79**, markets **172/172**; все без ошибок/пропусков. Итоговый Web job, engine/editor, secret scan и isolated Compose upgrade/reset rehearsal — success.
- Собственный Java-код удалён из Android main/test; новые Kotlin-файлы проверены сравнением с предыдущим коммитом `f08f710`.
- Финальный коммит отчёта поверх `c38e554` меняет только этот файл и ссылки совместимости в мобильной инструкции; исходники, тесты и конфигурация сборки совпадают с проверенным кодом.

## Основа мобильного клиента

Основа включает общий AppShell, PKCE/native HTTP и защищённый мобильный сеанс, SQLite receipts/journals, GPS/добровольный фон, локальные таймеры и APNs/FCM для mail/checkin, память/lifecycle/safe-area/sharing. [Точное покрытие и установка](docs/development/native-mobile.md), [push](docs/operations/native-push.md), [privacy](docs/development/native-mobile-privacy.md).

Экономические правила на этом этапе не менялись. Канонический расчёт: 68 сценариев, 1 468 155 команд, 138 исходников; [свидетельство](docs/game/economy-v15-final-simulation.md). Повторный расчёт из-за смены языка Android не требуется.

## Внешние условия и ручная приёмка

1. Для полного входа нужны совместимые web/API из ветки с V83/V84, развёртывание выполняется отдельно. Затем `npm ci`, `npm run mobile:sync`, `npm run mobile:ios` или `npm run mobile:android`.
2. Реальные APNs/FCM требуют Apple/Firebase credentials и соответствующей сборки. Старому мобильному сеансу до V84 нужен новый вход. Реальные push не отправлялись, TestFlight/Google Play не настроены.
3. На физических iPhone/Android проверить обновление без удаления, вход/смену аккаунта, SQLite-восстановление, GPS/фон/отзыв/призрак, уведомления, память и батарею по матрице. Первую лабораторию пользователь проверял на iPhone; это не приёмка полной версии.
4. После принудительного закрытия непрерывная геопередача не обещается. Offline logout удаляет локальный доступ, но серверный отзыв может не завершиться. UI-кэши могут оставаться в WebView; неподтверждённые действия Safari/Chrome автоматически не импортируются.
