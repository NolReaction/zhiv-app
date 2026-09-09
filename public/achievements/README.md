# Все шесть достижений

Каждая медаль теперь хранится отдельным SVG. Открывайте или заменяйте нужный файл здесь. Не меняйте ID в имени: на него ссылается состояние аккаунта.

| Медаль | Файл | Условие |
|---|---|---|
| ![В ритме](seven_day_streak.svg) | [seven_day_streak.svg](seven_day_streak.svg) | Серия отметок 7 дней |
| ![Тысяча искр](thousand_taps.svg) | [thousand_taps.svg](thousand_taps.svg) | 1 000 принятых игровых тапов суммарно |
| ![Свой круг](five_friends.svg) | [five_friends.svg](five_friends.svg) | 5 принятых связей одновременно |
| ![На одном дыхании](ten_thousand_series.svg) | [ten_thousand_series.svg](ten_thousand_series.svg) | 10 000 принятых тапов за одну игру |
| ![На связи](linked_email.svg) | [linked_email.svg](linked_email.svg) | Подтверждённая почта |
| ![Запасной ключ](saved_recovery_code.svg) | [saved_recovery_code.svg](saved_recovery_code.svg) | Сохранённый и активированный резервный код |

Названия, цели, описания и подсказки собраны в [game-rewards.ts](../../features/game/game-rewards.ts). Компонент [achievement-medal.tsx](../../features/game/achievement-medal.tsx) загружает SVG по ID. Серый вид до получения и цветной после него задаёт [game-achievements.module.css](../../features/game/game-achievements.module.css).

Три новых файла извлечены из прежних встроенных SVG без перерисовки. Для изменения размера сохраняйте `viewBox`, внутренние пропорции и прозрачный фон.
