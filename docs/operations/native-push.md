# Native push: APNs и FCM

Серверный контур отправляет **новые административные письма и напоминание об отметке** в установленное приложение iOS/Android. Он использует существующие настройки аккаунта, тихие часы, дневной лимит, интервал и outbox Web Push. Таймеры строительства, производства и путешествий остаются локальными уведомлениями телефона: сервер не отправляет их в APNs/FCM. Web Push для сайта сохраняется.

Код не включает провайдеров автоматически. Без credentials snapshot возвращает `delivery.configured=false`, регистрация отвечает `503 NATIVE_PUSH_NOT_CONFIGURED`. Пустые переменные безопасны; частично заданные или неверные credentials останавливают запуск API с короткой ошибкой без содержимого ключей. Пока сборка или сервер не готовы, клиент не предлагает включение remote push и не вызывает системный запрос разрешения для него. Фальшивой успешной доставки нет. Реальная доставка, фон, разрешения и tap-переходы должны проверяться на телефонах с настроенными провайдерами.

## Перед включением

1. Применить V84 штатным `migrate` перед запуском новой версии API. Новая таблица привязок и `app_sessions.mobile_platform` добавлены отдельной миграцией; B49 и V1–V83 не изменены.
2. Обновить мобильное приложение с реализацией remote push и настройками соответствующей платформы. Сессии, выданные до V84, не имеют доверенной платформы: один раз отключить аккаунт в приложении и войти заново. Переименование устройства не заменяет этот шаг.
3. Настроить один или оба провайдера ниже. На одном экземпляре API выбран **один APNs environment и один bundle ID**. Xcode development и TestFlight используют разные среды: для одновременной проверки нужны отдельные окружения API/БД и соответствующие сборки. Токен sandbox нельзя отправлять в production.
4. После настройки серверов перезапустить API штатным способом. В приложении пользователь отдельно включает удалённые уведомления и разрешает их в ОС. Сохранение категорий само по себе не даёт разрешения устройству.

## Настройка мобильной сборки

После обновления ветки выполнить из корня `npm ci`, затем `npm run mobile:sync`. Эта команда собирает мобильные web-ресурсы и подключает `@capacitor/push-notifications` к Android Gradle и iOS Swift Package Manager. Не заменять её одним `cap open`: открытие IDE не обновляет ресурсы/плагины.

**iPhone.** Обычная тестовая сборка остаётся доступной Personal Team: по умолчанию `CODE_SIGN_ENTITLEMENTS = App/App.entitlements` (пустой файл) и `MOCHLIK_PUSH_ENABLED = NO`. Она не запрашивает remote push. Для отдельной подписанной сборки с push выбрать платную Apple Developer Team, включить capability Push Notifications для App ID `ru.zhiv.mochlik.lab` и соответствующий provisioning profile. В Build Settings **target App**, для нужной конфигурации, указать:

| Build Setting | Development на iPhone | TestFlight / App Store |
|---|---|---|
| `CODE_SIGN_ENTITLEMENTS` | `App/AppPush.entitlements` | `App/AppPush.entitlements` |
| `MOCHLIK_PUSH_ENABLED` | `YES` | `YES` |
| `MOCHLIK_APNS_ENVIRONMENT` | `development` | `production` |
| Серверный `NATIVE_PUSH_APNS_ENVIRONMENT` | `sandbox` | `production` |

`MOCHLIK_PUSH_ENABLED` — явный флаг подготовленной сборки, а не обход подписи или проверка entitlement через закрытые API. Успех появляется в интерфейсе только после выдачи токена APNs и подтверждения сервера. При неправильном профиле подписи регистрация завершится ошибкой. Бесплатную лабораторную конфигурацию не переводить на APNs автоматически. Simulator в этой реализации показывает, что требуется настоящий iPhone. `.p8` ключ остаётся исключительно на API-сервере; `GoogleService-Info.plist` для прямого APNs здесь не нужен.

**Android.** Скачать `google-services.json` именно для Firebase Android-приложения с package `ru.zhiv.mochlik.lab`; положить локально в `apps/mobile/android/app/google-services.json`, затем повторить `npm run mobile:sync` и собрать приложение. Этот файл игнорируется Git. При его отсутствии Google Services plugin не применяется, обычная сборка работает, а сообщения сервера помечены недоступными. Service-account JSON сервера нельзя подменять этим файлом или класть в APK. Нужен телефон/эмулятор с работающими Google Play services; реальную доставку и энергосбережение проверять на телефоне. Автоматическая FCM-регистрация по умолчанию выключена — подключение начинается только после пользовательского согласия.

На Android удаление старого FCM-токена выполняется асинхронно. До завершения этой операции нативный модуль не разрешает получать/активировать новый токен: это исключает удаление нового подключения отложенным logout. Отключение показа на телефоне не ждёт сети; повторное подключение при незавершённом удалении показывает предложение повторить позже. Неуспешная операция не оставляет постоянный флаг запрета, новый запрос возможен после её завершения.

Android получает data-only push. В merged manifest единственный `com.google.firebase.MESSAGING_EVENT` сервис приложения — `MochlikMessagingService`; стандартный сервис Capacitor явно удалён. Служба до показа сверяет сохранённое согласие, владельца, текущий защищённый сеанс и его срок. Нажатия допускают только почту или экран отметки после загрузки текущего аккаунта. На iOS холодный запуск через уведомление передаёт `UIScene.ConnectionOptions.notificationResponse` в официальный обработчик; повторные callback одного события подавляются.

Согласие хранится отдельно для текущего аккаунта, APNs/FCM token не сохраняется в JS Preferences. После запуска/возврата приложение получает актуальный токен; изменение native session generation сбрасывает результаты старых асинхронных запросов. `generation` — локальный счётчик экземпляра нативного модуля, не долговечный секрет и не идентификатор серверной сессии. При выходе/отключении native показ останавливается сразу; недоступный сервер получает повторное отключение после восстановления связи. Уже принятый системой APNs alert может появиться позднее с общим текстом, но не открывает другой аккаунт.

Клиентские проверки: `tests/mobile-remote-push.test.mjs` проверяет согласие, недоступный сервер/сборку, ошибки записи, переключение аккаунта/сеанса, запоздалые ответы, ротацию и отключение без сети; `NativePushPayloadTest` проверяет Android payload/маршруты/общий текст. После Gradle CI запускает `scripts/check-mobile-push-manifest.py` по фактически слитому debug manifest: проверяет единственный обработчик приложения, удаление стандартного сервиса Capacitor, низкий приоритет SDK fallback, `exported=false` и необходимые разрешения. Проверка останавливается, если manifest отсутствует или найдено несколько результатов. Эти проверки не подтверждают доставку на физическом телефоне.

## Серверные секреты

`deploy/compose.yml` передаёт переменные из `deploy/.env`. Приватные файлы лежат в существующем `deploy/.secrets/auth/` и доступны API только для чтения как `/run/auth-secrets/`. Использовать приватный каталог и права файлов, позволяющие чтение непривилегированному пользователю контейнера, по существующей схеме auth secrets. Не помещать credentials в Git, web/mobile bundle, `NEXT_PUBLIC_*`, скриншоты или логи. Путь в переменной — **внутри контейнера**, не путь Mac/Windows.

| Переменная | Значение |
|---|---|
| `NATIVE_PUSH_APNS_KEY_FILE` | `/run/auth-secrets/apns.p8`: Apple APNs Auth Key в PKCS8/P-256 |
| `NATIVE_PUSH_APNS_KEY_ID` | Key ID из Apple Developer |
| `NATIVE_PUSH_APNS_TEAM_ID` | Team ID Apple Developer |
| `NATIVE_PUSH_APNS_TOPIC` | Точный bundle ID подписанной iOS-сборки |
| `NATIVE_PUSH_APNS_ENVIRONMENT` | `sandbox` для development или `production` для TestFlight/App Store |
| `NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE` | `/run/auth-secrets/fcm-service-account.json` |
| `NATIVE_PUSH_FCM_ANDROID_PACKAGE` | Точный applicationId Android-сборки |

APNs требует все пять своих переменных, FCM — обе. Можно включить только iOS или только Android. Отсутствие одного провайдера не отключает другой. Чтобы остановить отправку платформы, очистить всю её группу и перезапустить API; привязки сохранятся, пользователь сможет отключить их через API. Пока провайдер выключен, ожидающие события откладываются без расходования попыток и затем устаревают по общему лимиту 24 часа.

**Apple:** включить Push Notifications для App ID и подписанной сборки; получить APNs Auth Key с подходящим доступом к этой теме/среде. Секрет `.p8` используется только API. Сервер отправляет alert по HTTP/2 непосредственно в APNs, подпись ES256 и bearer JWT обновляются автоматически. Использовать платную Apple Developer команду с нужными capabilities для распространения; прежний запуск тестового приложения по кабелю сам по себе не подтверждает доступность remote push.

**Firebase:** создать/выбрать Firebase-проект Android-приложения, включить Firebase Cloud Messaging API (HTTP v1), создать service account с правом `cloudmessaging.messages.create` в этом проекте и скачать его JSON на сервер. Android-сборке нужен её `google-services.json` и настройка Firebase; **service-account JSON туда не кладётся**. Сервер использует OAuth2 JWT bearer (RS256) и scope `https://www.googleapis.com/auth/firebase.messaging`, кеширует access token до безопасного обновления. Для этой реализации `project_id` credentials является проектом отправки. GMS/FCM должны быть доступны на устройстве; это не реализация Huawei Push.

## Привязка устройства и смена аккаунта

Регистрация требует проверенный bearer `m1_` текущего мобильного сеанса. Cookie-only запрос не подходит. Сервер сравнивает реального владельца сеанса, `expectedOwnerPublicId` и платформу, записанную при PKCE-обмене. Токен устройства не является доказательством права на чужой аккаунт.

Один сеанс имеет одну текущую привязку своей платформы. Повторная регистрация обновляет её, новый APNs/FCM токен заменяет прежний. APNs token получают от ОС заново при регистрации приложения, а не восстанавливают из JS Preferences. Совокупный лимит — пять активных сеансов с web/native подписками на аккаунт.

Если тот же токен ещё связан с **другим владельцем**, API отвечает `409 NATIVE_PUSH_SUBSCRIPTION_CONFLICT`. Нужно отключить уведомления в старом сеансе либо отозвать его в разделе «Устройства», затем повторить подключение нового. Сервер не переносит чужую привязку молча. Для одного владельца новый сеанс может забрать токен у более старого; отложенный запрос старого сеанса не может забрать его обратно. DELETE старого сеанса не удаляет привязку нового.

Выход/отзыв сеанса, его перенос между владельцами, смена bearer, блокировка/удаление аккаунта очищают привязки через триггеры. Истёкшие сеансы проверяются перед каждой отправкой и убираются обслуживанием. **Выход без сети не может мгновенно сообщить серверу об отзыве**: приложение убирает локальное согласие/доставленные уведомления, а серверная привязка может жить до успешного отзыва/истечения. До нового подключения другой владелец получает конфликт; это намеренно безопаснее автоматического переприсвоения. Уже принятый APNs alert нельзя отозвать с сервера; его текст общий, а переход дополнительно проверяет владельца на телефоне. Android data-only сообщение проверяется нативной службой перед показом.

## Очередь и доставляемые данные

Worker работает каждые 30 секунд. Перед сетью он повторно проверяет аккаунт, категорию, видимость приложения, живой сеанс и источник. Прочитанное письмо, новая отметка, блокировка, отзыв сеанса между резервированием и отправкой отменяют устаревшее сообщение. Новое подключение не рассылает старую почту; текущее просроченное напоминание об отметке может быть создано.

Одна согласованная сводка отправляется на последнее подключённое подходящее устройство. Если в сводке есть игровой таймер, её может получить только Web Push. Для mail/checkin подходит web или native, выбор один, а лимиты и history общие. Доставка на все устройства сразу не производится.

В payload отсутствуют текст письма, суммы, координаты и произвольные URL. Передаются фиксированные generic title/body (APNs) и метаданные:

```json
{"source":"mochlik-remote","target":"mailbox","ownerPublicId":"XXXX-XXXX-XXXX","eventId":"UUID"}
```

`target` разрешён только `mailbox`/`checkin`; `eventId` — UUID попытки из outbox, пригодный для дедупликации на устройстве. Android получает data-only high-priority сообщение и формирует общий текст локально. APNs/FCM TTL составляет 30 минут, collapse key группирует ожидающие новости. Успех провайдера означает **принятие**, а не подтверждённый показ на экране.

Явный `Unregistered` APNs / `UNREGISTERED` FCM удаляет точный неработающий токен; `BadDeviceToken` APNs также требует новой регистрации (в том числе проверить environment). Ошибки прав/темы/credentials не удаляют остальные регистрации. 429/5xx и временный отказ OAuth дают максимум три попытки с задержками и учётом `Retry-After`. Таймаут после передачи push в сеть — `uncertain`, без повтора; зависшая резервация после аварии обрабатывается так же. Гарантии «ровно один раз» между сервером, провайдером и ОС нет. История хранится 32 дня.

Соединения разрешены только к фиксированным Apple/Google HTTPS адресам, redirects выключены, время и размер ответа ограничены. Ответы провайдера, token/key/payload не логируются. Перед production включением проверить сетевой доступ API к `api.push.apple.com` или `api.sandbox.push.apple.com`, `oauth2.googleapis.com`, `fcm.googleapis.com`.

## API

| Метод и путь | Поля |
|---|---|
| `GET /api/v1/notifications/native` | Query: `expectedOwnerPublicId`, `platform` |
| `POST /api/v1/notifications/native/subscriptions` | JSON: `expectedOwnerPublicId`, `platform`, `token` |
| `DELETE /api/v1/notifications/native/subscriptions` | JSON: `expectedOwnerPublicId`, `platform`; удаляет привязку текущего сеанса |

Ответ: `{ownerPublicId, preferences, delivery:{configured,platform,reason,categories:["mail","checkin"]}, subscription:{subscribed}}`. Токен и ключи не возвращаются, ответы `no-store`. Настройки/видимость используют существующие `/notifications/preferences` и `/notifications/presence`; согласие аккаунта и разрешение ОС остаются разными состояниями.

`NATIVE_PUSH_PLATFORM_MISMATCH` означает неподходящую/старую сессию, `NOTIFICATION_OWNER_CHANGED` — сменившийся аккаунт, `PUSH_DEVICE_LIMIT` — пять активных устройств. Доверие сертификату Xcode, разрешение показа в ОС, успешная регистрация токена и готовность серверного провайдера — отдельные этапы.

## Проверки и reset

- `NativePushConfigTest` / `NativePushSenderTest`: одноразовые EC/RSA ключи, подписи JWT, payload/endpoint allowlist, HTTP/error mapping, OAuth/cache/backoff, ограничение ответов. Transport подменён, отправок в интернет нет.
- `JdbcNativeNotificationRepositoryIntegrationTest`: PostgreSQL 18, владелец/платформа/cookie guard, ротация/конфликты, revoke/read/ban перед отправкой, общий budget/quiet/visibility, dead-token cleanup, retry/uncertain, отсутствие серверных таймеров native и replay старой почты.
- Baseline/full historical chain и populated-upgrade тесты проверяют V84; старые сеансы остаются `mobile_platform=NULL` до нового входа.
- `reset-game-progress.sql` сохраняет native-привязки и согласие с сеансами, удаляет старые игровые jobs/outbox по существующей политике. `reset-user-data.sql` и full database reset удаляют привязки; full-reset backup сохраняет их для восстановления. Строгие инвентари и psql integration fixtures обновлены до V84.

После зелёного CI нужны ручные проверки на реальных iPhone и Android: разрешение/запрет и настройки ОС, mail/checkin в фоне, возвращение по tap, смена аккаунта, отзыв сеанса со второго устройства, offline logout, обновление токена и подходящая APNs среда. Убийство приложения, энергосбережение и ограничения Google/Apple могут задерживать/подавлять доставку; прикладные тесты это не заменяют.

Первичные источники: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [Apple token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [Apple response handling](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns), [Apple registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [Apple scene notification response](https://developer.apple.com/documentation/uikit/uiscene/connectionoptions/notificationresponse), [Capacitor Push Notifications](https://capacitorjs.com/docs/apis/push-notifications), [Firebase HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [Firebase error codes](https://firebase.google.com/docs/cloud-messaging/error-codes), [Google OAuth service accounts](https://developers.google.com/identity/protocols/oauth2/service-account).
