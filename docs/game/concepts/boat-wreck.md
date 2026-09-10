# Разбитая лодка у северной кромки бухты

Самостоятельный PNG с прозрачностью: `public/world/objects/boat-wreck-v1.png`, 1619×971. Создан одним запросом встроенного imagegen; исходный файл сохранён вместе с alpha. Фон леса использован только как визуальный ориентир и не изменялся. При загрузке Canvas один раз делает спрайт 76×47 для той же плотности пикселей, что у карты. Мировая опора `(898,956)`; корма касается берега, нос направлен вправо-вниз.

## Запрос

```text
Use case: stylized-concept.
Asset type: standalone transparent PNG game object sprite for a detailed cozy forest Canvas map.
Primary request: generate ONE small wrecked wooden rowboat, repairable in the future, isolated on a genuinely transparent background with an actual alpha channel.
Style reference interpreted from the previously viewed forest map: artisan pixel-art with warm olive and moss greens, dull tawny browns, deep desaturated green-brown shaded crevices, hand-placed chunky shaded texture, crisp stepped pixel edges, cozy classic top-down adventure-game scenery. Match that map's high oblique top-down camera: clearly see inside the hull and see the lower-facing exterior hull side. Do not reproduce or alter the map.
Composition: one rowboat centered, entire silhouette visible with generous transparent padding. The boat's long axis runs from left to right and slopes gently down toward the right, roughly 15 degrees clockwise. Pointed bow at RIGHT. Broken square stern at LEFT. A recognizable narrow rowboat shape, wider at the stern and middle then tapering to the pointed bow. High oblique view, not side-on, not direct overhead.
Materials and details: weathered dull brown planks, cracked ribs, a few missing planks revealing a dark interior, small muted moss touches on the rim, exactly one broken oar lying inside. Wrecked but still coherent and recognizable, not shattered debris. Coherent chunky detail intended to read at about 50 by 30 map pixels after integration; restrained contrast and no excessive microscopic detail.
Lighting: warm daylight from upper left, subdued highlights, darker lower hull side.
Background: TRUE TRANSPARENCY. No checkerboard drawn into image, no solid colored or rectangular backdrop.
Avoid: shore, water, water patch, ground, surrounding objects, external debris, other boats, characters, text, UI, labels, border, heavy drop shadow, dramatic glow, glossy 3D, vector flatness, photorealism.
Return one image only, no variants.
```
