# Рабочее состояние - work/0.7.1

## Посещение мира друга и личная лавка

2026-10-19 (Москва), продолжение `4c5f4bb`. Пользователь попросил переходить из друзей игрового профиля в настоящий мир друга, видеть его прогресс и одежду, покупать товары из его лавки. Публикация рабочей ветки разрешена. Master, earth, деплой и БД вне задачи.

- Вход: AppShell хранит привязанный к аккаунту/связи target; карточка «В гости», OFF/offline недоступны. WorldPortal переключает собственный WorldView и GuestWorldVisit; стрелка/Escape возвращают домой. Смена аккаунта/отзыв связи/offline очищают выбор.
- GET `/api/v1/people/{circleId}/world`: принятая прямая связь, effective outgoing sharing != OFF; безопасная проекция зданий, одежды, декора и часов работ + до 10 настоящих активных лотов продавца. Ktor repeatable-read/no-init; DEV повторяет контракт. Кошелёк/склад/будущие награды/seed/память/lease хозяина не передаются. Родитель отменяет поздний ответ, скрытую вкладку/offline и не хранит guest snapshot на устройстве; опрос 15 секунд, focus и manual refresh.
- Сцена: настоящий WorldScene/readOnly, отдельная изолированная ForestSession без owner persistence/sync/DEV-подмен. Костюмы, уровни, урожай/стройки/работы из snapshot. Бытовые движения остаются локальной косметикой, не сетевой трансляцией положения хозяина.
- Лавка: отдельная витрина + подтверждение всей партии, реальные монеты/место покупателя, понятные блокировки. POST `/people/{circleId}/world/market/commands` только buy_listing, seller binding до receipt и повторная проверка доступа под account locks. Общий market pipeline сохраняет revision, ограничения цен/открытий/уровней, деньги, комиссию, оборот, вместимость и рыбный escrow. Обходит только случайный общий подбор. Receipt scope `friend:${circleId}:` одинаков в Ktor/DEV. Client actFriendMarket использует общую сессию/mutex/retry и сохраняет circleId при перезагрузке.
- Документация и справка обновлены; устаревшее обещание «посещение позже» заменено.

## Проверки и следующий шаг

- Ранние целевые: entry/profile 28/28; session+регрессия 45/45; DEV+market regression 35/35; scene/isolation+смежные 13/13; root API/profile/help 25/25; UI 5/5 (21 взаимодействие). Это пересекающиеся наборы, их не суммировать.
- Typecheck первого прохода, architecture-check (866 модулей), world:check прошли. Финальные targeted/typecheck/lint ещё завершаются: `/tmp/zhiv-friend-world-*.log`.
- Backend с готовым JDK25/Gradle из `/tmp/geo-env` скомпилирован; targeted Gradle tests прошли: 12/12 (4 projection, 4 HTTP, 4 existing market); 7 новых PG integration tests скомпилированы, но skipped из-за отсутствия Docker (`/tmp/zhiv-guestworld-kotlin-final-tests.log`). Новый suite включён в обязательный PG guard CI. Локальный PostgreSQL нельзя запустить от root, Docker отсутствует; PG integration suite добавлен для CI и локально не подтверждён.
- Browser QA настоящий canvas/320/390/1280 выполняет friend_world_entry: `/tmp/zhiv-friend-world-browser-qa.mjs`; storefront отдельный визуальный QA у friend_market_ui. Server/browser перед финальными сборками остановить.
- Осталось: исправить конкретные findings, завершить browser QA и финальные sourcechecks; последовательно `npm test`, затем `npm run build:vps`; обновить результат здесь и обычным коммитом опубликовать work/0.7.1. GitHub Git Data connector с expected parent и force=false, обычный git push без auth недоступен. Не выдавать ранее выполненные сборки за новые.

Предыдущий финал/титры и проверки сохранены в `4c5f4bb:WORK_STATE.md`. Серверный Ktor-контур и обязательный PG guard публикуются первым проверенным этапом. Клиент, DEV, сцена, интерфейс и документация ещё остаются локальными до завершения общего прогона.
