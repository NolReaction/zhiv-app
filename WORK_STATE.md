# 0.7.1v2 — мобильный атлас

2026-10-21. Основа `8790727ca87bc96e2e50d90c5b2d445b740b8b22`. Переработка атласа для телефона: большой каталог закрывал карту, последовательное листание не масштабировалось, достопримечательности показывались слишком далеко и сверху. Публикация проверенного этапа в `0.7.1v2` разрешена; master и deploy не меняем.

## Реализовано

- Каталог с поиском и разделами мест/биомов/маршрутов отделён от небольшой карточки просмотра. Выбор закрывает каталог; прямой список остановок заменяет обязательное листание. Состояние маршрута живёт вне каталога, повторяющиеся места используют настоящий индекс. Заметки раскрываются отдельно. Каталог до 45svh; короткий landscape совмещает поиск/фильтры, скрывает избыточные map-кнопки и возвращает фокус книге после commit. App nav остаётся на месте.
- Камера использует опубликованное размещение, объёмные границы, наклон и свободный viewport. Все 9 detail-моделей проверены настоящей проекцией/clipping на 5 размерах. Общий расчёт с редактором сохраняет его прежнюю симметрию. Широким комплексам доступен temporary selected-only detail preview от zoom 12 без изменения физических размеров, качества или saved3D preference. Минимальный масштаб сохранения привязан к fitted request; обзор башни не считается просмотром. Биомы получают обзор крупнейшей части региона.
- Сохранение явное: ID/номер запроса, foreground, завершённое движение, текущая готовая сетевая подложка без pending recovery и фактический видимый draw. Синхронный guard блокирует старые callbacks при движении/перекрытии/hidden/owner change. Ошибки обозначены; RAM-only сохранение показано явно. Формат ID v1 и свежие GPS-условия встречи сохранены.
- Native stability выявила feedback loop: blanket areTilesLoaded зависел от пустой earth-meet-line, preview-render снова отправлял пустой GeoJSON. Gate использует current mandatory vector/raster isSourceLoaded + recoveryidle, исключая локальную worker-работу. meet-map отправляет данные только при изменении геометрии/source; privacy clear, expiry, новый style и refocus сохранены. До исправления около 63 reload/s, после — 0 source events за 1.5s простоя.

## Проверки

- Полный Earth-прогон 754: 753 PASS, одна регрессия точного offsetX=0 в старом editor test (2.84e-14). Восстановлены literal квадратные углы без изменения тестов; повторный editor+обе native geometry группы 19/19 PASS. Остальных падений не было; все 754 второй раз не запускались. После финальных исправлений: lifecycle+meet/source recovery 21/21 и EarthView focus 16/16 PASS; scoped ESLint/diff-check чистые. Полные web/backend/Compose проверяет CI.
- Полные typecheck, ESLint, architecture 1012 модулей и world:check PASS. После последних runtime/CSS исправлений последовательный pipeline завершён: Sites exit0, postbuild PWA/production/assets/MapTiler 45/45 PASS, Next/VPS exit0 с повторной проверкой TypeScript. Generated dist/.next очищены перед сборками. Изображения/asset данные не менялись. Независимый review проверил owner/request/tiles/recovery/model/LOD/prefs, draft пробелы исправлены.
- Secret scan 2493 текстовых файлов: 0 находок. Фактически настроенный browser key отдельно отсутствует во всех 35 staged файлах; env/ключи не коммитятся.
- Native Chromium/SwiftShader: 58 основных checkpoints на 320×600, все 9 настоящих detail-моделей/GPUdraw/framebuffer в свободной области. Eiffel 103×180px, Giza 136×113, Wall 104×146. Drag/pinch, explicit Save/reload, 50 маршрутов/ 50 остановок с repeated IDs и прямой индекс PASS. Дополнительно 320/390/1280: 40 samples/1s непрерывного ready+enabled+baseLoaded+draw и обычный Save —6/6 PASS. После meet guard ещё 3/3 (stableSave+idle events). Landscape 844×390: 640×175.5px, results 62px, search/clear/directGiza/Close/Escape focus —4/4 PASS. Page exceptions/provider requests/GPS/реальные аккаунты:0. Портретные PNG просмотрены. Физический Safari не проверялся.

## Завершение

Этап завершён и проверен. Проверенное дерево готово к публикации в 0.7.1v2 по сохранённому разрешению пользователя; CI нового head проверяется отдельно. Деплой не выполнялся.
