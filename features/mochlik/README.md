# Графика Мохлика и прежний runtime

Эта папка содержит общие модули, которые продолжает использовать текущий лес, и сохранённые части прежней домашней сцены. Она не является единственным местом логики персонажа.

- [pixel-sprite.ts](pixel-sprite.ts) рисует Мохлика; [lighting.ts](lighting.ts) задаёт расписание освещения.
- [scene.ts](scene.ts) выбирает рендер; текущая Tiled-сцена собирается в [world/scene/new-map-scene.ts](../world/scene/new-map-scene.ts).
- Потребности и выбор занятия находятся в [world/simulation/](../world/simulation/), занятия — в [world/activities/](../world/activities/), общий сеанс — в [world/state/forest-session.ts](../world/state/forest-session.ts).
- `home-layout.ts`, `lantern-light.ts` и другие сохранённые части прежней сцены нельзя удалять только по возрасту или названию. Сначала проверьте зависимости и оба контура сборки.

Новый свет и дождь текущей карты меняйте в `features/world/environment/`. Игровой профиль находится в `features/world/ui/profile/`, его не нужно искать среди функций рисования героя.

[Полная карта исходников](../../docs/repository-guide.md) · [Организация кода](../../docs/development/code-organization.md).
