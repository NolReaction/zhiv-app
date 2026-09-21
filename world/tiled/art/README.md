# Оригиналы рисунков Tiled

Пять новых PNG передаются отдельно в архиве **zhiv-tiled-world-art-originals.zip** по просьбе владельца проекта. Распакуйте его в корень репозитория, сохраняя папки. Файлы ниже должны оказаться в `world/tiled/art/`. Их можно затем добавить в эту ветку обычным Git.

Все PNG в архиве сохранены побайтно, без уменьшения и перекодирования. Архив также содержит неизменённые копии `public/world/maps/forest-region-v3.png` и `public/world/maps/home-detail-v1.png`, которые уже есть в репозитории.

Для просмотра `/prototype/tiled-world`, работы с `forest.tmj`, проверки `npm run world:check`, сборки приложения и веб-тестов архив **не требуется**: семь рабочих WebP уже включены в ветку. Распакуйте оригиналы перед `npm run world:assets` или `node scripts/prepare-tiled-assets.mjs --check`.

| Файл | Байты | SHA-256 |
| --- | ---: | --- |
| `clean-home.png` | 2545138 | `e825819676ed2afd57b3538bf8b859ed8d6a6c81ced17289f9509fdde78fc4e4` |
| `home-level-2.png` | 2501729 | `0d48c29d773fdc21aad1dedad4d84b631336d1b86c3b9e7cdbf5ed2a3311a625` |
| `home-level-3.png` | 2526043 | `7798d5c5c665bd9c8a6ffb2b590d616a4610336832e7e788f3e5238dc51fe899` |
| `workshop-level-1.png` | 1613239 | `dac9e69ba128a5ff496478a141aea4eef2d6f31db0ead78b725314f12e626891` |
| `workshop-level-2.png` | 1853775 | `a44d08bdc5ed9f9d207e0effba72b53fcaea41c7cbcbb249a96e59eb6e11cf7a` |

[Порядок работы в Tiled](../../../docs/game/tiled-editor.md) · [Исходные запросы для дома](../../../docs/game/tiled-home-art-prompts.md) · [Мастерская](../../../docs/game/tiled-workshop-art-prompts.md).
