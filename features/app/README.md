# Оболочка приложения

[app-shell.tsx](app-shell.tsx) — общая точка сборки, которую открывает [app/page.tsx](../../app/page.tsx). Она соединяет аккаунт, отметки, людей, игровой прогресс, экономику, стартовую загрузку и большой мир. Общая разметка находится в [app-shell.module.css](app-shell.module.css), навигация — в [navigation.tsx](navigation.tsx).

`identity-recovery.ts` обслуживает восстановление идентичности оболочки; `use-simple-view.ts` — настройку простого вида. Компоненты отметки и календаря остаются в `features/check-in/`, профиль аккаунта — в `features/account/`, новости — в `features/updates/`.

Добавляйте сюда только соединение областей и общий жизненный цикл. Экран, экономическое правило или сетевой протокол принадлежит своей feature. Обратный импорт `AppShell` из feature запрещён: передавайте данные и callbacks.

[Организация кода](../../docs/development/code-organization.md) · [Поиск по задаче](../../docs/repository-guide.md).
