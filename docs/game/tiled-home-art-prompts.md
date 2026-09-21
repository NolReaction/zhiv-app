# Fixed-site home art edits

## Source and production method

- Original, unchanged level 1: `public/world/maps/home-detail-v1.png`.
- Source image: 1254 × 1254 RGB PNG; SHA-256 `f14fba0d71b976ed63530726e3b4a86241ab72a409e8e837a7a5b36fae5ef8bd`.
- Production: built-in `image_gen.imagegen`, precise-object-edit workflow. No CLI/API fallback and no model-name inference.
- Every variant independently referenced the original level 1 image through `referenced_image_paths`. The local original was inspected with `view_image` before edits.
- Each requested variant was accepted after one generation and visual inspection; no regeneration was needed.
- Files are unchanged full-size generated PNG source plates, delivered separately in `zhiv-tiled-world-art-originals.zip` at the project owner’s request. Extract into the repository root before regenerating runtime assets; see [source-art instructions](../../world/tiled/art/README.md). Original source assets were not overwritten.
- These are opaque regional state plates, not transparent object sprites.

## Outputs and tool provenance

| Source plate | Dimensions / mode | Built-in generated filename | SHA-256 |
| --- | --- | --- | --- |
| `world/tiled/art/clean-home.png` | 1254 × 1254 RGB | `exec-f10c84bf-c12a-4ce9-bceb-b00da9f0d44d.png` | `e825819676ed2afd57b3538bf8b859ed8d6a6c81ced17289f9509fdde78fc4e4` |
| `world/tiled/art/home-level-2.png` | 1254 × 1254 RGB | `exec-6be798a6-0158-4e86-a4ac-00c77d520b28.png` | `0d48c29d773fdc21aad1dedad4d84b631336d1b86c3b9e7cdbf5ed2a3311a625` |
| `world/tiled/art/home-level-3.png` | 1254 × 1254 RGB | `exec-228891a4-503f-42d8-b82c-57e2a5cf765b.png` | `7798d5c5c665bd9c8a6ffb2b590d616a4610336832e7e788f3e5238dc51fe899` |

The tool returned `image_url` and `output_hint`; its output hint reported the generated files in `/workspace/scratch/68e22ea9b07e/generated_images/`. It did not expose a model version, seed, or masking controls.

## Runtime framing contract and limitations

The full home image maps to world rectangle `x=486,y=514,width=256,height=256`. Runtime should consume only the designated home patch `x=600,y=526,width=142,height=134`, corresponding to source coordinates approximately `x=558.422,y=58.781,width=695.578,height=656.391`. Keep crop conversion deterministic in the asset pipeline.

Visual inspection found the same camera and scene composition, aligned entrance and three doorstep stones, and house changes within the designated patch. The clean plate removes the stump, roots, lantern, attached mushrooms, sprout, and house shadow and continues the grass/forest texture. Level 2 has doorway reinforcement, a wooden awning, and one warm round window. Level 3 adds a shallow porch structure, two windows, shingles, and a small leaf motif while keeping the stump silhouette and footprint.

Generative editing preserves composition but does not guarantee identical pixels outside the requested edit. The outputs show slight image-wide texture differences, especially in the grass. **Do not replace the full home scene with these plates.** Use only the bounded regional crop; visually check its borders when composited with the original map. The source plates preserve the original approximate entrance anchor `(877,494)` and route reference `(877,642)`; these are visual anchors rather than machine-measured guarantees.

## Exact prompts

### Clean ground

Use case: precise-object-edit. Asset type: fixed-camera pixel-art game map clean ground plate. EDIT THE REFERENCE IMAGE. Preserve its exact square composition, camera, scale, pixel-art texture, colors, and every unrelated object. Remove ONLY the stump-house in the upper right, its spreading roots, attached brass lantern, attached three mushrooms, house sprout, and house cast shadow. Replace that house area with plausible grassy ground continuing the same clearing; where the uppermost house overlaps the dark background, continue the existing forest undergrowth. KEEP the three gray doorstep stones in their exact original positions, KEEP the large left bush, the diagonal dirt path at upper left, all surrounding trees, rocks, flowers, grass tufts, lower and side edge composition unchanged. Do not move the camera, crop, zoom, repaint the whole scene, or introduce objects. At original 1254x1254 coordinates all removal/new paint must stay inside x558..1254,y59..715, especially house footprint x590..1254,y90..610. The reference is the sole edit target, not a suggestion. Deliver one full square same-framing image, ideally 1254x1254 or 1024x1024, with only that house removal. No labels or borders.

### Level 2

Use case: precise-object-edit. Asset type: fixed-camera pixel-art game map, home upgrade level 2. EDIT THE REFERENCE IMAGE, which is level 1. Preserve its exact full square composition, camera angle, scale, pixel-art texture, colors, and every unrelated object. Upgrade ONLY the existing stump-house in the upper right into a modestly improved crafted stump home. Keep the exact same stump silhouette, grassy roof height, sprout, roots and footprint; keep the open arched entrance and its floor/threshold anchored at original coordinate approximately (877,494). Add a small warm-lit round wooden-framed window on the upper right front of the stump, simple neat wooden reinforcement around the doorway, and a small crafted wooden awning immediately over the entrance. Keep its original lantern and attached mushrooms in place. This is a modest first upgrade, clearly nicer but still a simple stump shelter. NO added story, no tower, no large extension, no garden, no fence. Preserve the three gray doorstep stones exactly, and the ground path below unchanged. KEEP all surrounding trees, bushes, rocks, flowers, path, grass, lighting, and image edges identical. Do not move or zoom camera or repaint the whole scene. At original 1254x1254 coordinates all changed pixels must stay inside x558..1254,y59..715; doorway ground anchor stays at (877,494). Deliver one full square same-framing image, ideally same 1254x1254 reference size, no labels, no borders.

### Level 3

Use case: precise-object-edit. Asset type: fixed-camera pixel-art game map, home upgrade level 3. EDIT THE ORIGINAL REFERENCE IMAGE. Preserve its exact full square composition, camera angle, scale, detailed pixel-art texture, colors, and every unrelated object. Upgrade ONLY the stump-house in upper right into a noticeably more finished, cozy crafted stump cottage, still approximately the same size and footprint. Keep the recognizable living stump, roots, mossy grassy top with sprout, and the open arched front entrance. Keep doorway threshold and ground anchor at original approximately (877,494), and keep the three gray doorstep stones exactly unmoved. Add a carefully crafted shallow wooden porch canopy with small side supports, a narrow warm wood porch floor confined to the original entrance platform, neat carved door trim, two small glowing amber round or arched windows in the stump front/flank, and a modest warm brown shingled roof detail laid over the front part of the existing stump roof, with the original moss and sprout still visible above. A small decorative leaf carving can distinguish this polished final upgrade. Keep original lantern and mushrooms. Visibly more upgraded than a simple awning and single round window, but NO second storey, no castle, no large extension, no giant roof, no new yard objects or fencing. The porch must not cover or move the gray doorstep stones. The house cannot spread left beyond existing roots or downward beyond original mushrooms. KEEP surrounding trees, bush at left, rocks, flowers, diagonal path, grass and image edges unchanged. No camera movement or zoom. At reference 1254x1254 coordinates confine all structural changes inside x558..1254,y59..715; doorway ground anchor fixed at (877,494). Deliver one full square same-framing image, ideally same 1254x1254 reference size, no labels, no border.
