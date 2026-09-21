# Документация

## Начать участие в разработке

- [Путеводитель: что и где менять](repository-guide.md)
- [Правила небольших изменений](../CONTRIBUTING.md)
- [Текущая архитектура](architecture.md)

## Игра

- [Устройство мира и игровые правила](game/world-foundation.md)
- [Анимации, уборка кода и следующий этап мира](game/world-animation-audit.md)
- [Свет, маршруты и размещение календарных подарков](game/world-lighting.md)
- [Звуки окружения: запросы для подбора](game/sound-search.md)
- [Прогресс и награды](game/mochlik-progression.md)
- [Синхронизация тапов и восстановление после сбоя](game/game-sync-reliability.md)
- [План единой карты и отдельных построек](game/map-assets-plan.md)
- [Рабочие изображения](../public/world/README.md) и [все медали](../public/achievements/README.md)
- [Исходные художественные концепты](game/concepts/)

## Сервер и администрирование

- [Первичная настройка](operations/server-setup.md), [VPS](operations/vps.md)
- [Эксплуатация, резервные копии и восстановление](operations/operations.md)
- [Модерация игроков и анализ кликов](operations/player-moderation.md)
- [Админка](operations/admin-panel.md), [реагирование на сбои](operations/incident-response.md)
- [Вход через ВК и почту](operations/auth-0.5.0.md)
- [Управление аккаунтом](operations/account-0.5.1.md)
- [Ручной сброс БД](operations/reset-database.md), [сброс пользовательских данных](operations/reset-user-data.md)

## История

[Текущий релиз 0.6.3](releases/release-0.6.3.md) содержит изменения и порядок обновления.

Прежние релизы, планы и завершённые отчёты доступны в [архиве документации на коммите 5a117b2](https://github.com/NolReaction/zhiv-app/tree/5a117b2c233874a0362cdad11fef6a0308e622ff/docs). Команды в архиве могут быть устаревшими; для запуска и работы используйте инструкции выше.

[Восстановление checkout VPS после смены истории 0.5.1](history/vps-history-repair-0.5.1.md) сохранено для серверов со старой историей Git. Для обычного обновления используйте [эксплуатационные инструкции](operations/operations.md).
