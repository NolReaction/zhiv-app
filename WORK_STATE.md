# Рабочее состояние - work/0.7.1

## Одноразовые семь подарков

2026-10-19. Продолжение fd63128/65a17e4 (рынок и каталог v12). Дима попросил сделать семь подарков за вход одноразовыми на аккаунт вместо повторения каждую неделю. Публикация в work/0.7.1 разрешена; master, earth, деплой и production DB вне задачи. Изначально дерево чистое.

- Суммы каталога v4 сохранены: 40/50/60/70/80/90/110 видимых жемчужин, всего500, с реликвией в финале. После седьмого completed=true, step7, claimable=false, nextClaimAt=null; новый запрос DAILY_REWARD_COMPLETED. Старый requestUUID воспроизводит неизменяемую квитанцию без начисления. Пропуски, UTC и минимум20h прежние.
- V64__one_time_seven_day_gifts.sql восстанавливает завершение по исторической ступени7 либо прежнему wrap step1+lastClaimAt; учитывает max paid step и missing daily row. Кошельки/ревизии/ledger/старые квитанции не меняются. Слияние: completion OR, максимальная ступень, cooldown по последней дате. DEV переводит живое старое состояние по receipts. Native startup whitelist обновлён доV64.
- UI: «Все подарки получены»,7/7, без таймера/красного бейджа/автопоказа; ручной просмотр и recovery последнего lostACK сохранены. Справка, /branch и текущие экономические документы исправлены. Разовый стандартный максимум2200видимых:100обучение+100welcome+1500достижения+500подарки, безpromos/events/DEV. Цены слотов/реликвий/ускорений не менялись.
- Симуляции перестают планировать подарки после7, продолжают хозяйство; unreachable slot thresholds отмечаются явно. Старый before-сценарий намеренно повторяемый и изолирован. Исторические research-отчёты не пересчитывались.
- Operational game reset сохраняет game_daily_rewards/game_reward_claims/game_achievement_reward_claims как одноразовые payout fences; имущество очищается по прежним правилам. Полное удаление аккаунтов сохраняет прежнюю семантику. Guards скриптов/CI verifier/schema tests обновлены доV64. Никакие команды сброса или деплоя не выполнялись. Native reset fixture уведомлений перенесена после welcome claim: раньше trigger удалял synthetic checkin:test ещё до проверяемого reset.

## Проверки текущей задачи

- Source TS/domain/HTTP/reset43, UI/lifecycle/onboarding59, help/graph56, симуляции16: все174 уникальных целевых теста прошли,0skip. UI browser actualDialog/Button+useGameRewards+DEV:320/390/1280, реальный финальный claim/reload/manual reopen/keyboard, повторных записей0, overflow/JSerrors0; скрины просмотрены. Логи /tmp/zhiv-onetime-rewards-*, /tmp/zhiv-onetime-gifts-qa, /tmp/zhiv-one-time-gift-*.
- Full typecheck, ESLint, architecture880modules, world:check, tracked securityscan findings0, diffcheck прошли. Sites и VPS builds прошли последовательно. У VPS очищен повреждённый generated Turbopack cache (invalid digit persistence), после этого exit0. Native main/все testKotlin скомпилированы, unit10/10,0failures/errors;42PGtests skipped локально безDocker, не PG pass. Лог /tmp/one-time-rewards-native-verified.log.
- Новый CI job one-time-rewards требует реальные PostgreSQL suites: progression claims, V64 migration оба пути, onboarding migration, baseline, release upgrade, actual game reset плюс Kotlin units. Нужны публикация и проверка этогоjob на GitHub.

## Следующий шаг и ограничения

Локальные проверки завершены; опубликовать обычным новым коммитом. Проверить focused PostgreSQL job; записать SHA/результат. Полный npm test (~40мин) ради этой задачи не запускался. У прежнего общего CI были несвязанные mail/fishing failures и history-scan размера earth GLB; не менять earth ради них и не объявлять весь CI зелёным. Предыдущая рыночная проверка65a17e4:66/66 realPG+units, job https://github.com/NolReaction/zhiv-app/actions/runs/39249372385/job/118049098883 .
