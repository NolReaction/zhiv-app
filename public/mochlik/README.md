# Рисунки Мохлика

Авторские изображения созданы встроенным ImageGen для экспериментальной ветки `feature/mochlik-terrarium`. Внешних моделей, платных наборов или сторонних текстур нет.

## Рисованная полянка

- `forest-day.webp` — 1254×1254, подробный лес с домиком справа. Вход не содержит горящей лампы или искусственного свечения: свет добавляется отдельно в сцене. Изображение используется в Canvas 2D-сцене и как фон при загрузке/ошибке.
- `forest-foreground.webp` — 1254×1254, отдельные корни, мох и папоротники с настоящим alpha-каналом. Слой расположен ниже и сжат по вертикали при отображении, чтобы сохранить свободную середину круга. Alpha-канал сохраняется при загрузке.

Оба изображения получены через built-in image_gen, по одному запросу на файл. Затем преобразованы в WebP без изменения композиции; alpha переднего плана сохранён. Рисованные слои показывают окружающий лес, а Мохлик, куст и фонарь отрисовываются кадрами атласов на Canvas 2D.

### Запрос фона

```text
Use case: precise-object-edit.
Asset type: square fixed-camera painterly forest background for a 2.5D game.
Input image 1 is the EDIT TARGET. Preserve its exact full square framing, camera, composition, woodland, foliage, roots, moss textures, sunlit clearing, stump silhouette, mushrooms, and doorway position.
Primary request: change ONLY the illumination inside the stump doorway: REMOVE the little lit flame/lamp and all artificial golden light emanating from the doorway. Make the doorway interior unlit and dark warm brown, with readable wood floor and curved wooden inner wall under faint ambient daylight, no glow. The exterior sunny clearing must remain daytime and naturally sunlit as it is. Do not dim the forest, do not change the foreground, do not add any objects. Preserve the detailed soft painterly fairytale realism.
Constraints: exact same forest scene and square framing, no character or animal, no text, no border, no glass, no flame, no artificial warm light from the door.
```

### Запрос переднего плана

```text
Use case: stylized-concept.
Asset type: square foreground vegetation overlay for a fixed-camera 2.5D fairytale forest game. This is an isolated overlay layer, NOT a full forest scene.
Primary request: generate ONLY a narrow band of low lush moss, tiny clover leaves, soft woody roots, and restrained ferns at the very bottom edge and lower left/right corners. Painterly detailed naturalistic fairytale game art, deep woodland olive greens and soft warm yellow-green highlights, intricately textured moss and bark. The layer adds foreground depth across the very bottom of a forest clearing.
Composition: full square canvas. All vegetation confined to the bottom 15-20% of the image; a few small fern tips may extend up to y=72% only at the extreme left and right edges. Top 70% and all central play area MUST be completely empty. Keep center vegetation extremely low. No large plant, rock, or root blocks the middle. No tree trunk, no forest background, no horizon, no house or stump, no animal, no mushroom, no glass, no border, no text.
Background: actual transparent alpha everywhere outside isolated vegetation, clean transparent cutout edges. If actual transparent alpha is impossible, use one perfectly uniform flat PURE MAGENTA (#ff00ff) background across the entire empty area, with no shading or gradient. Never depict or bake in a checkerboard pattern. Transparency preferred. Output one square asset.
```

## Кадры персонажа и объекты

- `mochlik-motion-key.webp` — 1254×1254, 16 новых кадров: 4 ходьбы боком, 4 от зрителя, 4 к зрителю, затем приседание, прыжок, приземление и потягивание. Последний ряд начинается на 72.5% высоты, чтобы не обрезать поднятые уши. При загрузке кадры выравниваются по нижней границе непрозрачного силуэта.
- `habitat-objects-key.webp` — 1774×887, куст и фонарь. Граница областей проходит по x=1000, чтобы сохранить края листвы. Масштаб каждого объекта считается по собственному силуэту.

Новые атласы получены встроенным ImageGen по исходному Мохлику и лесу. Первоначально инструмент нарисовал шахматный фон вместо alpha, поэтому выполнено по одному корректирующему редактированию на изображение: фон заменён пурпурным. В браузере используется мягкий цветовой ключ с подавлением пурпурной каймы, как у первого 2D-прототипа. Преобразование PNG в WebP выполнялось через Sharp, качество 95. Варианты внешности не генерировались.

## Исходные изображения

- `forest.webp` — 1024×1024, исходный лес до отделения света фонаря; сохранён как художественный референс.
- `mochlik-atlas-key.webp` — атлас 1600×800 из восьми поз, вновь используется для покоя, мимики, умывания и сна. Пурпурный фон предназначался для цветового ключа первого 2D-прототипа. Он сохраняет узнаваемый первоначальный образ.

Выбранный образ Мохлика: кремовый пухлый лесной зверёк с широкими мягкими ушами, зелёной спинкой и короткими лапами. Программная 3D-модель удалена; все изображения персонажа в текущей сцене двумерные.

## Запросы новых атласов

```text
CHARACTER ATLAS

Use case: illustration-story.
Asset type: production 2D game sprite animation atlas.
Reference image 1 is the approved character identity ONLY. Preserve exactly this same Mochlik: cream chubby fluffy forest creature with velvety fur, a moss olive green patch across forehead and rounded back, giant soft floppy ears with olive inner ears, tiny gray-brown paws, small nose, round warm black eyes, plush painted storybook appearance. Reference image 2 supplies forest illustration lighting and color style only.
Create one 2048 x 2048 square transparent PNG animation atlas, precisely FOUR equal columns and FOUR equal rows (16 cells, each 512 square). Each cell holds one distinct chronological animation pose of the SAME Mochlik character, at the SAME scale, centered horizontally. Full body and entire ears must remain inside every cell, generous transparent margins, no overlap into adjacent cells. Grounded paws use consistent baseline at 90% cell height. Character head/body size identical between frames and rows; movement is pose and paw movement, never camera zoom. True transparent alpha everywhere outside character; no background, no magenta, no white rectangle, no checkerboard image, no shadows or floor, no grid, no borders, no labels, no text.

TOP ROW cells left to right: four chronological frames of one complete WALKING TO SCREEN RIGHT cycle, clear RIGHT-FACING SIDE VIEW throughout. Frame 1 right-side lead paw reaches forward; frame 2 passing pose with near hind paw under body; frame 3 opposite paws reach forward; frame 4 other passing pose. Walk with tiny alternating paws, soft body bounce and ear sway. All four point right.
SECOND ROW: four chronological frames of one complete walking AWAY TO UPPER RIGHT cycle, REAR THREE-QUARTER view, green moss back visible prominently, face mostly hidden; alternating tiny hind paws and gently swaying ears.
THIRD ROW: four chronological frames of one complete walking TOWARD VIEWER cycle, FRONT VIEW, alternating left and right tiny feet and gentle ears sway. All four face the viewer.
BOTTOM ROW left to right: (1) crouch and coil before a playful jump; (2) airborne jump with tucked paws and both floppy ears raised, full body still inside cell; (3) landing with paws planted and round body softly crouched; (4) standing sleepy stretch with eyes closed, small forepaws stretching upward and floppy ears relaxed.
Art: polished detailed painted plush illustration, soft fur strands and natural warm top-left light, rich but gentle material detail matching reference identity. This is fully 2D illustrated sprite art. No polygons, no low-poly surfaces, no 3D scene or props. Exactly sixteen distinct poses in a strict aligned 4 x 4 atlas.

OBJECT ATLAS

Use case: illustration-story.
Asset type: production 2D forest game object atlas.
Reference image is forest style and lighting reference only.
Create one transparent PNG landscape image, 2048 x 1024 preferred, exactly TWO equal square cells side by side (2 columns, 1 row), no visible divider. Each cell has one isolated object. True transparent alpha everywhere outside the objects, generous transparent margins, clean detailed edges. Never include a painted background, white rectangle, checkerboard pattern, text, labels, numbers, grids, watermark, or scene.
LEFT CELL: one lush rounded low bush, a broad gently domed mound of overlapping clover leaves, delicate fern fronds and soft mossy foliage. An opaque leafy center suitable to hide a small pet behind it in a 2D game. Rich forest olive and yellow-green palette, layered foliage, lighter leaves on top-left, slightly darker base. Low and wide silhouette. Only bush foliage and a few short visible stems: no pot, no rocks, no terrain, no ground patch, no baked shadow. Whole bush inside left cell.
RIGHT CELL: one small rustic brass hanging lantern suspended from the curled top of a short wooden stake. Warm aged brass housing with an arched handle, pale cream UNLIT glass, no candle flame, no emitted light and NO BAKED GLOW. Handcrafted short slender wood stake with a gently curving upper hook, nice quiet woodland object. Entire lantern and entire stake visible inside right cell. Object must read clearly at small on-screen size.
Style: detailed hand-painted storybook forest illustration matching the provided reference, softly brushed wood texture and plant detail, warm natural light from upper left, soft edges with crisp silhouette, earthy greens and brass. The two objects share the same illustrated forest world, light and detail level. Fully 2D painted assets, not low-poly. Center each object within its half and keep all details away from borders.


```

## Исправление фона атласов

```text
CHARACTER REPAIR

Use case: precise-object-edit.
This is a technical chroma-key background repair, not a redraw or style variant.
Edit the supplied atlas image. Replace ALL of the baked white/gray checkerboard background everywhere with one perfectly FLAT, SOLID, PURE MAGENTA color: RGB (255, 0, 255), hexadecimal #ff00ff. This includes every empty margin, every gap between subjects, and every visible empty hole between ears, arms, paws, foliage, lantern and stake. The entire background must be identical pure #ff00ff with no checkerboard, no pattern, no texture, no gradient, no shadow and no white or gray residue.
IMPORTANT: Deliver an OPAQUE RGB image with pure magenta chroma-key background. DO NOT make a transparent image and DO NOT simulate transparency. Preserve every existing character or object pixel silhouette, interior colors, painted texture, lighting, proportions, positions, scale, framing, pose, and cell layout exactly. No added elements, no labels, no grid, no text. Change only the background.
Atlas to preserve: exactly sixteen Mochlik character animation poses in four equal columns and four rows. Preserve all sixteen poses and their ordered layout, facial features, eyes, fluffy cream fur, olive moss patches, feet, ears, and all edge details. Same square canvas size as input.

OBJECT REPAIR

Use case: precise-object-edit.
This is a technical chroma-key background repair, not a redraw or style variant.
Edit the supplied atlas image. Replace ALL of the baked white/gray checkerboard background everywhere with one perfectly FLAT, SOLID, PURE MAGENTA color: RGB (255, 0, 255), hexadecimal #ff00ff. This includes every empty margin, every gap between subjects, and every visible empty hole between ears, arms, paws, foliage, lantern and stake. The entire background must be identical pure #ff00ff with no checkerboard, no pattern, no texture, no gradient, no shadow and no white or gray residue.
IMPORTANT: Deliver an OPAQUE RGB image with pure magenta chroma-key background. DO NOT make a transparent image and DO NOT simulate transparency. Preserve every existing character or object pixel silhouette, interior colors, painted texture, lighting, proportions, positions, scale, framing, pose, and cell layout exactly. No added elements, no labels, no grid, no text. Change only the background.
Atlas to preserve: one leafy clover/fern bush on the left and one brass lantern on curved wooden stake on the right. Preserve both objects exactly, including individual leaf edges and the open space inside the curved stake and lantern handle. Same landscape canvas dimensions as input.


```
