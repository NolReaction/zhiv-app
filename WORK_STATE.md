# Рабочее состояние — work/0.7.1

## Camera drag checkpoint: остановлено по просьбе пользователя

Пользователь попросил немедленно закончить и push как есть из-за оставшегося лимита. Это сохранение незавершённой работы в work/0.7.1, не готовый релиз. Master и деплой не затрагивать. Полного CI не ждать.

База: 86f45faa88ca1315599631a54e117f653ce5ebfb. Локальная ветка: work/camera-drag-performance-071.

### Что сохранено

- Перетягивание запускало полный world paint каждый input RAF (60/120 Гц), хотя симуляция работает около 30 Гц.
- Новый map-pan-surface.ts расширяет ИСХОДНЫЙ main canvas на 32 CSS px с каждой стороны при прежнем физическом DPR, до 4 Мп. Между world paint камера перемещает этот canvas через CSS. Второго canvas/копирования кадра нет. Маркеры и отдельные реплики обновляются каждый input RAF.
- Интеграция в map-engine.ts/world-scene.tsx: неподвижный root для размеров/input, отдельные растровые часы, прямой путь для zoom/release/editor/guide/reduced motion/resize/скрытия. При несовместимости масок обычная поверхность рисуется повторно в том же кадре, pan блокируется до нового жеста.
- canvas-viewport-compatibility.ts и вызов в forest-occlusion.ts защищают выбор мягкой маски от смены 1 Мп/2048 px fallback. Проверяется весь диапазон возможных crop, включая вход из border. Последнее уточнение этого guard ещё не прогонялось.
- CSS анимация входа освобождает fullscreen transform после завершения: backwards, конечный transform:none. Прежде навсегда сохранялся scale(1) на всей сцене.
- Вспомогательные изменения: камера обновляет точный spatial audio mix без повторного чтения контактов того же тика; пустой speechCanvas не очищается каждый кадр, исчезнувшая реплика очищается один раз.
- Ассеты, Tiled, экономика и игровые часы не изменены.

### Что действительно проверено

- Audio: 58/58 профильных тестов, отдельно water 8/8; две speech overlay проверки прошли; scoped ESLint audio/speech прошёл ДО последней pan-интеграции.
- Guard первого варианта + существующие forest-occlusion: 25/25. После уточнения guard на все возможные crop повторного прогона НЕ было.
- tests/map-pan-surface.test.mjs: 4 новых unit-теста сохранены, ещё НЕ запускались. Новых engine integration тестов pan нет.
- Финальный npm run typecheck прошёл (exit 0). Лог: /tmp/zhiv-drag-final-typecheck.log.
- Финальные сборки, общий lint/architecture/world checks и финальный native A/B НЕ выполнены.

### Профилирование: не путать прототип с production

Стенд теперь монтирует настоящий WorldScene, HUD, production/construction markers и portal, ввод генерируется внутри браузера через RAF. Старый harness без DOM/React и paintCPU-only недостаточен.

Прототип CSS pan БЕЗ overscan дал center 38.5→55.2 и water 38.4→59.4 updates/s; RAF-интервалы >25 мс за 3.2 с: center 66→15, water 69→0. Это НЕ замер текущего production checkpoint. Chromium работает через SwiftShader/software compositing: абсолютные FPS не переносить на iPhone/физический GPU.

Освобождение portal scene transform проверено в двух порядках: modest улучшение presentation. Обычные полнокадровые и background-only canvas caches, source crop, desynchronized context, materialization shadows/masks/mips не помогли/регрессировали и в production НЕ внесены. Дорогой участок на market grounding был точкой оплаты накопленных Canvas-команд, а не причиной тени.

### Следующему ассистенту — порядок продолжения

1. Известный незакрытый край: observeMapGuideInset пока измеряет canvas. При первом появлении обучения во время расширенного drag возможен неверный inset на один кадр. Перевести surface parameter в map-guide-inset.ts на HTMLElement и передать стабильный root из WorldScene; затем проверить обучение.
2. Проверить pan-интеграцию: 60/120 Гц, дробная камера/DPR, быстрые движения за border, pinch/zoom, resize, hidden/resume, editor/guide/reduced motion, прямые API draw, выбор/маркеры/реплики и fallback масок. Добавить engine integration тесты. Запустить оба новых unit-файла и профильные scene/camera/occlusion/audio тесты.
3. Native A/B конечной production версии с overscan/guard против exact86: mobile/desktop, center/water, screenshot во время дробного drag и после release, ночь/дождь/края. Проверить отсутствие пустых краёв, заметного временного размытия, смены soft masks. Guard может отключать pan на части масштабов — измерить, не ослаблять ради цифр.
4. Обновить docs/game/world-foundation.md. Выполнить typecheck/lint/architecture/world/security checks, сборки Sites и VPS последовательно. Тесты, читающие dist, также последовательно со сборками. Полную тяжёлую npm test suite не выдавать за пройденную.

Артефакты окружения: /tmp/zhiv-css-pan-prototype.mjs, /tmp/zhiv-drag-native-portal.mjs; frozen source /tmp/zhiv-drag-final-current-source.json; отчёты /tmp/zhiv-drag-portal-baseline,released-current-0-summary.json и /tmp/zhiv-drag-portal-released,baseline,csspan-current-1-summary.json. Эти временные файлы в Git не входят. Production-код и этот handoff сохранены в коммите.
