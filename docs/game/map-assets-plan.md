# Единая карта Мохлика

## Реализовано в forest-region-v3

По просьбе пользователя тесная поляна переработана в большой лесной регион. Новый рисунок 1254 × 1254 создан встроенным imagegen на основе предыдущей карты; размер объектов уменьшен, добавлены естественные поляны, тропинки и широкий берег. Дом первого уровня остаётся частью PNG. Внешний мир и кнопка показывают одну сцену с общим детальным домашним участком; правила его подготовки описаны в `public/world/README.md`.

`features/world/map-manifest.ts` — источник геометрии в пикселях изображения. Кнопка показывает квадрат `(486,514)` размером `256 × 256`. Её анимационные координаты тоже 256 × 256, независимо от разрешения текстуры и canvas. Полная карта помещает этот же квадрат точно обратно; персонаж, листва и фонарь не зависят от масштаба камеры.

В `camera.ts` разделены `worldCamera` (широкий начальный обзор), `homeCamera` (дом крупно) и `overviewCamera` (вся карта). Начальная целевая ширина — пять домашних участков, с ограничением по краям карты; фактически отношение увеличений равно примерно 4,9. Минимальный масштаб использует короткую сторону экрана вместо длинной. Если карта целиком помещается по оси, камера центрируется по этой оси; на большом увеличении края ограничивают перетаскивание. Выбранный режим обзора пересчитывается при изменении размеров экрана, а вручную выбранное положение сохраняется.

| Объект | Закреплённые данные |
|---|---|
| Дом `home` | Вход, подход, полигон двери, фонарь, область нажатия, опора, участок улучшений |
| Куст `bush` | Центр, подход, область листьев для перекрытия персонажа и нажатия |
| Пещера `cave` | Контур входа, точка подхода и метка |
| Вода `water` | Полигон по всему берегу до границ карты, метка рыбалки |
| Поляна | Начальная позиция, приветствие, находки и выпуклая безопасная область ходьбы |

Пещера и рыбалка открывают самостоятельные панели-заготовки. Они не отправляют персонажа через непроходимый лес, не создают поход и ничего не списывают. Возврат закрывает панель, сохраняя камеру и общий экземпляр поведения персонажа. Старые экспедиции доступны через «В путь».

## Как добавить новый уровень дома

1. Использовать участок `house.upgradeSlot`: `(610,536)`, размер `132 × 112` пикселей исходной карты. Опора остаётся `(665,615)`, дверь и фонарь сохраняют координаты из манифеста.
2. Подготовить PNG/WebP ровно такого размера. Поскольку первый дом нарисован в фоне, вариант должен полностью закрывать заменяемые части исходного дома. Маленький прозрачный спрайт не уберёт старую крышу; нужен согласованный участок или добавление, которое действительно совместимо с основой.
3. Сохранять границу участка по исходным пикселям и прозрачности. Не рассчитывать на размытие для исправления другой травы или сдвинутых деревьев.
4. Добавить вариант в `features/mochlik/house-variants.ts`: ревизия карты, уровень, путь, тот же участок и опора. Рендер загружает вариант отдельно, проверяет размеры и сохраняет отверстия двери/фонаря. Устаревший ответ загрузки не заменит более новый вариант.
5. До готовности совместимого изображения остаётся утверждённый дом. Все сохранённые уровни, ресурсы, гардероб и постройка мастерской сохраняются; старые атласы не накладываются поверх новой графики. Интерфейс прямо сообщает, что новый внешний вид уровней ещё в разработке.

## Проверки при изменении рисунка

- Новая ревизия и размеры манифеста; исходный PNG проверяется контрольной суммой.
- Один и тот же дом, куст и герой в кнопке и мире; никаких прямоугольных стыков.
- Вход/выход и сон внутри двери; прыжок, выглядывание и выход из куста.
- Попадание в пещеру и разные части воды, включая крайние пиксели; соседняя земля не открывает рыбалку.
- В портретном, горизонтальном и настольном окне начальный обзор примерно в пять раз шире домашнего. Все четыре угла карты доступны при минимальном увеличении; «Вся карта» работает после приближения. Метка куста не перекрывает дом на общем виде.
- Перетаскивание и увеличение не превращаются в нажатия. После смены размеров экрана и обратного преобразования клики остаются на тех же объектах.
- Переход между кнопкой и миром не создаёт второго таймера; скрытая сцена останавливает кадры. Сохраняются reduced motion, дневное/ночное освещение и восстановление после отсутствия.

## Основание решения

Это применение обычной схемы «изображение + точки/полигоны объектов + камера». [Tiled: работа с объектами](https://doc.mapeditor.org/en/stable/manual/objects/) описывает точки привязки и произвольные полигоны; [пользовательские свойства](https://doc.mapeditor.org/en/stable/manual/custom-properties/) — отдельные игровые метаданные. [Phaser: камеры](https://docs.phaser.io/phaser/concepts/cameras) различает координаты мира и окна и описывает обратное преобразование точки экрана. Эти инструменты не добавлены в зависимости: для текущей карты достаточно существующего Canvas-рендера.

## Происхождение рисунка v3

Один вызов встроенного imagegen, без повторных вариантов. В качестве референса использована присланная пользователем карта. Запрошено 3072 × 3072 либо максимальное поддерживаемое разрешение; фактически получен PNG 1254 × 1254. Файл сохранён без дополнительной обработки в `public/world/maps/forest-region-v3.png`. Для домашней поляны теперь добавлен отдельно прорисованный детальный участок `home-detail-v1.png` с сохранением масштаба и проверкой привязок. Сам обзорный файл региона не растягивался и не заменялся.

Точный запрос:

> Use case: stylized-concept. Asset type: ONE square, high-resolution, opaque, seamless-in-feel pixel-art forest region background for an exploration game. Request 3072x3072 pixels or the highest supported square resolution, highest detail. Input image 1 is a style, palette, and stump-home identity reference. Redesign the whole layout and zoom the WORLD scale out dramatically, about five times wider physical coverage than the reference: distant orthographic topdown RPG REGION map, not close-up vignette. Preserve the cozy detailed sharp pixelart language: deep teal-green tree shadows, layered olive/lime leaves, mossy boulders, ochre earth paths, grassy clearings, brown trunks. One consistent small object scale across every part of the map; all trees roughly same physical size, many dozens of individual trees, forest continues outside image edges. The moss-covered stump home with dark arched doorway, tiny warm amber lantern, stepstones and mushrooms stays recognizable, but is TINY: only about 5 percent of full canvas width. Place it in a small central home clearing only 18–22 percent of the full canvas width. One distinctive round leafy bush sits to the left of the home. Home and bush have the same unified small distant scale as all other trees. Create a convincingly expansive region: dense wooded areas interspersed with several natural grassy clearings of varied irregular shape, separated by stretches of woodland, giving a lot of room to explore. Narrow dirt paths form a visibly CONNECTED wandering network linking the home clearing to other clearings and continuing naturally off multiple canvas edges; avoid symmetric geometric road patterns. Include a distinct dark cave entrance inside mossy stones in the upper-left region with a clear path reaching its mouth. Include a broad blue-teal lake or slow river shoreline occupying around 20 percent of the map in the lower-right, extending out the right and bottom edges, with grass banks, reeds and a generous reachable shoreline clearing suitable for future fishing gameplay. Continuous natural paths connect home, cave, water and other clearings. Broad world-map framing with detail spread throughout; no giant empty central lawn. Keep all paths and walkable clearings visually readable among dense foliage. Sharp carefully clustered pixels and crisp edges at highest detail, no blur, no tilt-shift. No UI, text, labels, numbers, characters, grid, icons, watermarks, decorative border, settlements, extra buildings, docks, fences, signs, bridges or arbitrary architecture. No perspective horizon and no 3D rendering. Deliver just the pure square game background image.
