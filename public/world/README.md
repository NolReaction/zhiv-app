# World art

Generated for this project, September 2026; final assets are WebP, quality 88. The base terrain intentionally contains no house or workshop: interactive buildings are drawn once by the renderer.

- `forest-map-v2.webp`: 1254 × 1254 terrain, displayed in a 1536 × 1536 world.
- `stump-homes-v3.webp`: 1536 × 1024 atlas, six 512 × 512 cells. Five complete aligned stump houses, then one bush. Levels add a round window, chimney, entrance canopy, then a second window and doorstep. Generated with the built-in image tool from the original forest reference; the neutral matte is removed at load. Full house cells retain padding so doors and lanterns do not shift. The lamp glass is replaced by the shared day/night renderer.
- `workshop-levels-v2.webp`: 2172 × 724 atlas, three 716 × 724 cells at x = 0, 716, 1432; the final 24 columns are unused. Levels add shelves and tools, then a stone hearth/chimney and window. The bench belongs inside this one building.

Neutral atlas matte is removed once at load time by `lib/mochlik/assets.ts`. Extracted sprites and decoded source images are cached; no pixel extraction happens in animation frames. Building levels come from the account's world state, including legacy `workshop: true` states treated as level 1.

The circle is a crop of the same cached terrain used by the world camera. `terrain.ts` composites structures once per house/workshop level; the world adds only the transparent animated habitat layer. There is no blended inset or second clearing.
