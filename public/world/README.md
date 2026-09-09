# World art

Map and interior artwork restored byte-for-byte from `915cbcdb673ba98ff58616fb43d29ca39ad8ed22`. The rollback changes presentation only; account progression, workshop upgrades and shared character state remain current.

- `forest-expanded.webp`: outer forest, drawn over the 1536 × 1536 world.
- `forest-world.webp`: historical inner-forest reference, retained as an art source and not loaded by the renderer. Its landmarks already exist in the expanded forest.
- `../mochlik-pixel/forest.webp`: original home clearing with the house, bush, stones and paths together; shown in the circle and the central 384 × 384 world area.
- `house-details.webp`: original four-cell atlas of small additions for house levels 2–5. Patches leave the doorway and dynamic lantern glass untouched.
- `buildings-v1.webp`: original workshop art. The workshop uses its original appearance at all three upgrade levels; upgrade costs, levels and saved progress are retained.

The expanded forest is drawn once. The original rectangular edge feather joins only the home clearing into it; drawing the old inner forest again caused doubled landmarks along its edges. The circle keeps its construction-dependent bench. In the full map that extra sprite is omitted; the workshop marker and hit area point to the single workshop already drawn on the expanded background. River and trail markers follow that background too.

Image downloads retain the shared 15-second timeout, retry after failure and readiness reporting. Atlas extraction happens once during loading. Night lighting, whole-map rain, character departure and circle/world continuity remain in the current renderer.
