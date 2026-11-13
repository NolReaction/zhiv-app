# Privacy manifest мобильного клиента

Состояние исходников: 13 ноября 2026. Это описание реализованных потоков данных, а не подтверждение готовности App Store Connect, политики конфиденциальности или сторонних служб к публикации.

[`PrivacyInfo.xcprivacy`](../../apps/mobile/ios/App/App/PrivacyInfo.xcprivacy) больше не объявляет отсутствие сбора данных лабораторного стенда. Полный клиент входит в аккаунт, отправляет игровые действия и при отдельном согласии публикует геопозицию. В таблице перечислены суффиксы официальных `NSPrivacyCollectedDataType…`; во всех строках `Linked = true`, `Tracking = false`.

| Категория | Подтверждённый поток | Назначение |
| --- | --- | --- |
| `Name` | Имя профиля в [IdentityRoutes](../../apps/api/src/main/kotlin/ru/zhiv/identity/IdentityRoutes.kt), именованные записи административной аналитики | AppFunctionality, Analytics |
| `EmailAddress` | Вход и управление почтой своего сервиса через браузерный [AuthRoutes](../../apps/api/src/main/kotlin/ru/zhiv/auth/AuthRoutes.kt) | AppFunctionality |
| `UserID` | Сеанс и публичный ID аккаунта в игровых запросах; ID игрока в аналитике | AppFunctionality, Analytics |
| `Contacts` | Друзья, связи и участники групп в [RelationshipRoutes](../../apps/api/src/main/kotlin/ru/zhiv/relationships/RelationshipRoutes.kt) и [GroupRoutes](../../apps/api/src/main/kotlin/ru/zhiv/groups/GroupRoutes.kt) | AppFunctionality |
| `PreciseLocation` | Передача точной точки при разрешении ОС и согласии на обмен | AppFunctionality |
| `CoarseLocation` | Примерная точка: publisher округляет координаты до двух знаков, указывает погрешность не менее 1500 м | AppFunctionality |
| `GameplayContent` | Серверное сохранение игрового прогресса, экономики, построек; аналитика ресурсов и прохождения | AppFunctionality, Analytics |
| `OtherUserContent` | Статус профиля, названия групп, пользовательские подписи | AppFunctionality |
| `ProductInteraction` | Нажатия, отметки и игровое присутствие; статистика активности | AppFunctionality, Analytics |
| `CustomerSupport` | Отправленное пользователем сообщение об ошибке или предложение через [FeedbackRoutes](../../apps/api/src/main/kotlin/ru/zhiv/feedback/FeedbackRoutes.kt) | AppFunctionality |
| `OtherDiagnosticData` | [Client incidents](../../lib/client-incidents.ts): код операции/сбоя, время, HTTP-статус, requestId и счётчики с ID владельца | AppFunctionality |

`Contacts` здесь означает социальные связи внутри сервиса, а не чтение телефонной книги. Apple включает social graph в эту категорию; разрешение на доступ к адресной книге приложению не добавляется. Почта передаётся своему сервису во время входа в системном браузере; сама смена окна не делает эти данные несобираемыми. Передача координат реализована в [MobileLocationPublisher](../../apps/mobile/ios/App/App/MobileLocationPublisher.swift), серверные правила — в [EarthLocationRoutes](../../apps/api/src/main/kotlin/ru/zhiv/earth/EarthLocationRoutes.kt).

Цель Analytics указана для имени/ID, игрового содержания и взаимодействий из-за уже существующей [AdminAnalytics](../../apps/api/src/main/kotlin/ru/zhiv/admin/AdminAnalytics.kt): активные игроки, действия, расходы ресурсов, прогресс и длительность присутствия. Диагностические коды используются для исправления сбоев; в manifest они относятся к AppFunctionality. Наличие административной аналитики не означает рекламное отслеживание. В исходниках этого клиента нет ATT/IDFA, рекламных SDK или передачи данных для рекламы; `NSPrivacyTracking` остаётся `false`, список tracking domains пуст.

Локальные настройки, SQLite-журнал ожидающих команд и очередь уведомлений сами по себе не добавлены как отдельный серверный сбор. Неподтверждённые категории (например, фотографии, микрофон, аппаратный ID, медицинские данные или платёжные реквизиты) не объявлены. При добавлении новых потоков эту инвентаризацию нужно пересмотреть.

## Required reason APIs

| API | Причина | Использование |
| --- | --- | --- |
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | Свои настройки Preferences, маркеры установки/отзыва сеанса, выбор фонового обмена |
| `NSPrivacyAccessedAPICategorySystemBootTime` | `35F9.1` | `ProcessInfo.systemUptime`: монотонное локальное время для срока согласия, интервала отправки и длительности запроса настроек |

Значение uptime и момент загрузки устройства не передаются на сервер и не применяются для идентификации. Геопубликация отправляет время измерения Core Location, а не системный uptime.

Перед публикацией требуется собрать Xcode Privacy Report для конечного архива с manifest всех подключённых SDK, сверить App Store Connect App Privacy и Google Play Data safety с реальной конфигурацией сервера, политикой хранения, OAuth-провайдерами и внешними источниками карт. Этот файл не заменяет эти проверки. Опциональная передача геопозиции всё равно раскрывается в manifest; системное разрешение не заменяет согласие на обмен.

## Проверенные определения Apple

- [Поля и формат manifest](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)
- [Категории собранных данных](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)
- [Назначения обработки](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatypepurposes)
- [Required reason APIs и коды причин](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)
