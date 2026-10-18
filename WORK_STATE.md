# Рабочее состояние — work/0.7.1

## Camera drag: интеграция завершена

Продолжение `acc5fdb` поверх `86f45fa`, обычный коммит для `work/0.7.1`. Master, сервер и посторонние локальные правки не менялись. Ассеты, Tiled, экономика и игровые часы прежние.

### Исправлено

- `observeMapGuideInset` измеряет неподвижный root `WorldScene`, а не расширенный/сдвинутый canvas. Позднее появление обучения и масштаб предка проверены регрессией.
- Guard мягких масок учитывает смену floor/ceil на один физический пиксель при дробном движении. Проверены оба перехода soft/hard около 1 048 576 пикселей / 2048 px; независимый oracle охватывает 500 прямоугольников, пять DPR и до 64 crop.
- При suspension во время drag обычный canvas дорисовывается для видимой анимации выхода; любой уход в фон освобождает captures. Возврат не продолжает старое касание.
- Добавлены семь engine integration проверок: root/DPR, 120Hz input, маркеры/меню/реплики, border refresh, release/cancel/direct API, wheel/pinch, resize, guide, reduced motion, editor, suspension/resume; реальная несовместимость масок проверяет повтор normal paint в том же RAF и panBlocked до нового жеста.
- Canvas fixtures содержат style/context.canvas; performance.now и RAF используют одну шкалу. Premount-preview assertion сохранён. Старый speech-тест проверяет очистку всего физического backing при identity transform вместо прежних логических размеров.
- Сохранены оптимизации checkpoint: CSS pan исходного canvas с 32px запасом при прежнем DPR (до 4 194 304 пикселей), отдельные часы растрового кадра, spatial audio без повторного чтения контактов, однократная очистка опустевших реплик. Документация обновлена в `docs/game/world-foundation.md`.

### Проверки итогового кода

- Финальные TypeScript и полный ESLint прошли; architecture (853 modules), world export check, security (0 findings, включая новые staged-файлы) и audio catalog (111 ready) прошли.
- Широкий source-прогон всех shared scene-fixture consumers кроме отдельной группы residents/pan: **178/178**, без skipped. Часы fixture в этом прогоне уже исправлены.
- Residents + engine pan + pan surface: **57 passed**, затем исправленный устаревший physical-clear assertion отдельно **1/1**. Это покрытие 58 уникальных проверок, а не повторный полный прогон 58 после assertion-only правки.
- Guard/occlusion: **28/28**; audio/speech profile: **78/78**; camera/viewport/timing/options/guide: **15/15**. Группы не пересекаются с двумя предыдущими.
- Обе production-сборки прошли последовательно: `npm run build:vps`, затем `npm run build` (Sites). После них rendered HTML + portal + world UI: **16/16**. Всего покрыты **373 уникальные целевые проверки**; полный `npm test` здесь не запускался.
- Настоящий Next dev: начальный маршрут HTTP 200. Локальная ссылка node_modules заменена физическим каталогом для Turbopack; затронутые этим watcher-прогоны остановлены и не засчитаны. Финальные source-проверки выполнены после исправления окружения.

### Браузер

Стенд монтирует настоящий WorldScene, production/construction badges, speech overlay и portal CSS; верхний/нижний HUD и coach — представительные статические элементы с реальными refs. Production-файлы стендом не меняются.

- Mobile 393×852/DPR1.5 и desktop 1280×900/DPR1.25: pinch/release, guide во время drag, suspension/resume, speech, resize, reduced motion, ночь/ливень/края. Пустые края и заметная смена масок не обнаружены; desktop functional report без JS errors. Последний кадр выхода сохраняется, reduced motion отключает CSS pan.
- A/B против `86f45fa`: 16 motion-сценариев, mobile/desktop, requested input 60/120Hz — **0 coverage failures**, CSS reuse реально активен. Software renderer шумит, устойчивое улучшение FPS не доказано. 120Hz здесь — частота запрошенного ввода, не частота дисплея. Физического телефона/GPU в окружении нет; числа Chromium нельзя переносить на iPhone.

### Release gate и следующий шаг

[CI исходного `acc5fdb`](https://github.com/NolReaction/zhiv-app/actions/runs/39163275390): web 5751 pass / 71 fail, backend 922 tests / 7 fail. Из web 65 ошибок вызваны отсутствующим canvas.style: fixtures исправлены. Остальные 6 web связаны с meal-availability, pearl-spending UI, Plesk firefly, builder food, expeditions text и LeafTail shop text; эти файлы здесь не менялись. Backend: migration history count 13/14, merchant assortment fixture, reset mail event, isolation внутри welcome claim, даты expired session и welcome mail в broadcast fixture. Они не исправлялись в этой задаче; прохождение на родителе не проверено.

Перед выпуском нужны отдельный зелёный полный CI/API/PostgreSQL/Compose и проверка плавности/качества на физическом телефоне. Текущие целевые проверки их не подменяют. Новый CI оценивать по новому коммиту после push, не по прежнему результату.

Временные скрипты, скриншоты и отчёты: `/tmp/zhiv-browser-qa/`, логи: `/tmp/zhiv-finish-*` и `/tmp/zhiv-pan-residents-final.log`. Они не входят в Git.
