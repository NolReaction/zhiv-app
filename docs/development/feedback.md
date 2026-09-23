# Обратная связь

[Документация](../README.md) · [Админка](../operations/admin-panel.md) · [API и данные](backend-and-data.md)

Игрок открывает **beta-test → Написать разработчику**, выбирает «Ошибка», «Предложение» или «Другое» и отправляет текст. Все категории поступают во вкладку **«Обратная связь»** в `/admin`. Письма не отправляются, SMTP для этой функции не нужен.

## Где менять

| Задача | Источник |
|---|---|
| Форма, подсказки, состояние отправки | [feedback-dialog.tsx](../../features/feedback/feedback-dialog.tsx), [CSS](../../features/feedback/feedback-dialog.module.css) |
| Кнопка в beta-test | [beta-info.tsx](../../features/check-in/beta-info.tsx) |
| Клиентские контракты и HTTP | [feedback-api.ts](../../features/feedback/feedback-api.ts) |
| Сохранение черновика и повтор запроса | [feedback-draft.ts](../../features/feedback/feedback-draft.ts) |
| Вкладка администратора | [admin-feedback-panel.tsx](../../features/admin/admin-feedback-panel.tsx) |
| Авторизация, HTTP-параметры и лимит тела | [FeedbackRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/feedback/FeedbackRoutes.kt) |
| DTO, категории, статусы и правила текста | [FeedbackRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/feedback/FeedbackRepository.kt) |
| Транзакции, квитанции и лимит отправки | [JdbcFeedbackRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcFeedbackRepository.kt) |
| Схема PostgreSQL | [V29](../../apps/api/src/main/resources/db/migration/V29__player_feedback.sql) |

## Правила

- Один успешно принятый текст за **24 часа с момента отправки** на аккаунт, общий лимит для всех категорий и устройств. Полночь его не сбрасывает. Время следующей отправки возвращает сервер.
- Текст — от 10 до 3000 символов Unicode; вложений пока нет. Идентификатор автора берётся из действующей сессии, его нельзя выбрать в запросе. `expectedOwnerPublicId` только проверяет, что аккаунт не сменился в соседней вкладке; несовпадение даёт `409 FEEDBACK_ACCOUNT_CHANGED`.
- Ограничение проверяется внутри транзакции с блокировкой аккаунта: две вкладки или два устройства не обходят его одновременными запросами. Дополнительно действуют ограничения частоты HTTP-запросов.
- Повтор с прежним `clientRequestId` возвращает квитанцию уже принятого сообщения. После потери связи повторяйте **тот же** запрос, а не создавайте новый ID. Изменённый текст с прежним ID отклоняется.
- Текст — обычная строка. Не подставляйте его в HTML и не добавляйте секреты, токены или полные диагностические логи автоматически.
- Прочитать обращения и изменить статус может только разрешённый сервером администратор. Статусы: `new`, `reviewed`, `resolved`; это внутренние отметки, ответ игроку пока не отправляется.
- При объединении аккаунтов обращения переходят целевому аккаунту вместе с ограничением по последней отправке. При удалении аккаунта текст его обращений удаляется.

## HTTP

| Метод и путь | Назначение |
|---|---|
| `GET /api/v1/feedback?expectedOwnerPublicId=…` | `serverTime`, `canSubmit`, `nextAllowedAt` для текущего аккаунта |
| `POST /api/v1/feedback` | `{clientRequestId, expectedOwnerPublicId, category, message}` → квитанция и `nextAllowedAt` |
| `GET /api/v1/admin/feedback` | Фильтры `status`, `category`; страницы `offset`, `limit` |
| `POST /api/v1/admin/feedback/{id}/status` | `{requestId, status}`; повтор запроса не отменяет более позднюю смену статуса |

Для суточного ограничения возвращается `429 FEEDBACK_COOLDOWN`, `Retry-After` и `nextAllowedAt`. Ошибка доставки не означает, что сообщение не сохранилось: квитанция по тому же ID устраняет неоднозначность.

На VPS нужны новая версия Ktor и миграция V29 вместе с клиентом. Одного обновления frontend недостаточно. Локальная имитация хранит сообщения в памяти процесса, настоящая админка по-прежнему требует Ktor и `ADMIN_PUBLIC_IDS`.

Проверяйте отправку, повтор после потерянного ответа, параллельные запросы, границу 24 часов, запрет чужого origin, отсутствие прав администратора, смену аккаунта, фильтры/страницы и смену статусов. PostgreSQL-проверки — `JdbcFeedbackRepositoryIntegrationTest`; CI не допускает их пропуск.
