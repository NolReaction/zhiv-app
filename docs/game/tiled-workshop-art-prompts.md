# Workshop forest patch artwork

Two locally generated workshop stages for the fixed forest clearing. These are full-resolution source assets, intended to be exported into the runtime patch size by the Tiled compiler/export workflow. The original map was not modified.

## Source and framing

- Source: `public/world/maps/forest-region-v3.png`, 1254 × 1254 pixels.
- Exact crop in source-pixel / world coordinates: `x=126`, `y=428`, `width=166`, `height=150` (Pillow exclusive box `(126,428,292,578)`).
- Generation input: that crop enlarged 6× with nearest-neighbor sampling to 996 × 900. This deterministic preparation adds no new art.
- Supporting style input for level 1: full original forest map, especially its central stump home.
- Level 1 output: `world/tiled/art/workshop-level-1.png`, 1319 × 1193 pixels.
- Level 2 output: `world/tiled/art/workshop-level-2.png`, 1319 × 1193 pixels.
- Both outputs represent the same full 166 × 150 world rectangle; resample the entire image to the export size. No secondary crop or camera adjustment is needed.
- Original crop is state 0 and is supplied separately by the runtime export workflow.

The generated doorway threshold is approximately local `(75,104)`, world `(201,532)`, for both states. A clear approach point is approximately world `(201,545)`. The originally proposed `(215,565)` approach is near original southern foliage, so use the clear approach point or adjust it in Tiled after collision review. Building anchor `(210,535)` remains within the building area.

## Provenance

Created with the built-in `image_gen.imagegen` tool in edit mode on 2026-09-21. One successful generation per stage; no corrective retry was needed. Level 2 directly references the selected level 1 output to preserve identity and entry position. Source outputs are delivered unchanged in `zhiv-tiled-world-art-originals.zip`. Extract into the repository root before regenerating runtime assets; see [source-art instructions](../../world/tiled/art/README.md).

Generated tool output names:

- Level 1: `exec-cb90423d-cb41-4c46-9d60-863cea79a009.png`
- Level 2: `exec-9aa24c01-2f78-48d2-94cb-3f456b257bb9.png`

## Level 1 prompt

Use case: precise-object-edit. Asset type: in-game environment patch, workshop level 1, a local piece of an existing forest map. Image1 is the EDIT TARGET, a 996x900 enlargement of an exact 166x150-pixel forest crop. Image2 is supporting style/context reference only: its small stump-home near center demonstrates the required cozy elevated top-down pixel-art architecture perspective. OUTPUT the exact same crop framing as Image1, width-to-height ratio 166:150 (996x900 preferred), not the whole forest map, no border. Replace the bush-and-rock clump near lower-left center of Image1 with a small handmade rustic timber workshop/tool shed, olive moss on an aged wooden pitched roof, warm dark wood plank front, a single visibly open dark doorway facing downward toward the viewer, a tiny warm amber window and a couple of understated tools by its wall. It is the first simple un-upgraded building stage. Keep it modest, compact and grounded in grass, not a giant cottage. Match the original forest's fine pixel clusters, muted moss/olive greens, dark teal shade, warm brown timber, gentle upper-left light, and elevated RPG camera. Crucial geometry expressed relative to the 166x150 crop: building including its roof mainly inside x38..130,y30..112; doorway bottom center x89,y107; reserve grass walking space from the doorway down to x89,y137. Remove the replaced bush/rock completely where the building stands. The building must fit comfortably inside the crop with no cropped roof, no extensions into outer edge foliage. Preserve all original neighboring forest tree/fern foliage, rock at extreme right edge, dirt path at far lower-left, ground and texture along the outer 12% frame. Do not recompose, zoom, shift, rotate, or change the camera. Outer edges must visually match input1 to join the forest seamlessly. Preserve existing bottom-edge tree foliage, while keeping the area immediately before the doorway walkable. No new unrelated path, no broad stone paving, no figures, no text, signs, lettering, labels, grid, UI, or watermark. This is a precise local replacement embedded in the existing grass clearing.

## Level 2 prompt

Use case: precise-object-edit. Asset type: in-game environment patch, workshop level2. The supplied image is the EDIT TARGET, an exact forest crop with a small wooden tool shed. Create the next upgraded stage of THIS SAME workshop, on the SAME spot, at the SAME camera and scale, while keeping all surrounding grass, tree foliage, far right rock, tiny flowers and lower-left dirt path unchanged. Output identical rectangular framing and aspect ratio 166:150, approximately1319x1193. No borders. Upgrade only the wooden building and its immediately adjacent equipment: a modestly larger, sturdier timber workshop with a wider olive-moss wooden roof, improved neat warm brown timber framing, two small amber windows, a compact covered workbench on its right side with a saw/tool and small stacked lumber/log pile. This remains a small rustic forest workshop at RPG map scale, NOT a mansion or town building. Preserve the left roof plane, chimney, warm tiny left window, dark front entry and visual identity of the level1 shed. Keep the front doorway at the EXACT SAME pixel location and same height as the input (its lower threshold centered about45% of imagewidth,70% of imageheight). Grow the building gently upward and toward the right, around20% wider, using the open grass immediately right of the shed; maintain clear grass directly in front of the door. The right covered workbench and lumber should be visibly legible upgrade features. Building and additions must fit within the interior of the crop and never touch outer10% border. Keep existing bottom-edge tree foliage and grass route before the doorway unchanged. Match the fine pixel-art texture, chunky readable pixel clusters, muted forest olive greens and dark teals, warm brown wood, elevated top-down perspective, original upper-left lighting and soft ground shadows. Absolutely preserve the outer forest/ground frame and crop alignment: no zooming, shifting, camera rotation, new paths, broad paving, characters, labels, words, signs, grid, UI, or watermark.

## Visual review and integration limits

Both stages have a compact readable silhouette, a consistent moss-and-timber palette, a stable front entrance, and a visibly larger second stage with sheltered workbench, saw, logs, and second lit window. Neither contains text, characters, labels, or UI. The building remains comfortably inside the crop. The generated source preserves recognizable framing but re-synthesizes ground and foliage pixels, especially in level 2; it must not be assumed to be pixel-identical to the source map along the border. Runtime export should preserve the exact original outer pixels and use a gentle blend into the interior. Check the resulting patch against the map at native world scale before shipping.
