# World art

Generated for this project, September 2026; final assets are WebP, quality 88. The base terrain intentionally contains no house or workshop: interactive buildings are drawn once by the renderer.

- `forest-map-v2.webp`: 1254 × 1254 terrain, displayed in a 1536 × 1536 world.
- `house-accessories-v2.webp`: 1254 × 1254 atlas, four 627 × 627 cells: window, chimney, porch awning, round window with flowers. The original door and dynamic lantern are preserved.
- `workshop-levels-v2.webp`: 2172 × 724 atlas, three 716 × 724 cells at x = 0, 716, 1432; the final 24 columns are unused. Levels add shelves and tools, then a stone hearth/chimney and window. The bench belongs inside this one building.

Neutral atlas matte is removed once at load time by `lib/mochlik/assets.ts`. Extracted sprites and decoded source images are cached; no pixel extraction happens in animation frames. Building levels come from the account's world state, including legacy `workshop: true` states treated as level 1.
