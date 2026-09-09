# World art

Map and interior artwork restored byte-for-byte from `915cbcdb673ba98ff58616fb43d29ca39ad8ed22`. The rollback changes presentation only; account progression, workshop upgrades and shared character state remain current.

- `forest-expanded.webp`: outer forest, drawn over the 1536 × 1536 world.
- `forest-world.webp`: inner forest, drawn in the central 768 × 768 area.
- `../mochlik-pixel/forest.webp`: original home clearing with the house, bush, stones and paths together; shown in the circle and the central 384 × 384 world area.
- `house-details.webp`: original four-cell atlas of small additions for house levels 2–5. Patches leave the doorway and dynamic lantern glass untouched.
- `buildings-v1.webp`: original workshop art. The workshop uses its original appearance at all three upgrade levels; upgrade costs, levels and saved progress are retained.

The original rectangular edge feather joins the home, inner forest and outer forest. The workshop returns to the lower-left home area. Small current interaction markers follow the restored building positions.

Image downloads retain the shared 15-second timeout, retry after failure and readiness reporting. Atlas extraction happens once during loading. Night lighting, whole-map rain, character departure and circle/world continuity remain in the current renderer.
