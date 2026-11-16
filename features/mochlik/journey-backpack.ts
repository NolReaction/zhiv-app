import type { PixelDirection } from "./pixel-sprite";

type Painter = { rect: (x: number, y: number, width: number, height: number, color: string) => void };
const outline = "#435344", canvas = "#819986", shade = "#607763", light = "#abc296";
const leather = "#806849", flap = "#bca474", brass = "#d6b36b";

/** Worn expedition gear on the 48px body rig. The bag shares its shoulder bob;
 * only the existing arms/feet swing. It never creates a hand-held basket. */
export function drawJourneyBackpack(direction: PixelDirection, bob: number, layer: "behind" | "front", { rect }: Painter) {
  const r = (x: number, y: number, width: number, height: number, color: string) => rect(x, y + bob, width, height, color);
  const side = direction === "left" || direction === "right";
  if (layer === "behind") {
    if (!side) return;
    // A right-facing body carries its pack to the left. Mirroring the complete
    // silhouette (including width) keeps both turns attached to the same back.
    const p = (x: number, y: number, width: number, height: number, color: string) =>
      r(direction === "left" ? 48 - x - width : x, y, width, height, color);
    p(7, 26, 11, 13, outline); p(6, 29, 2, 8, outline);
    p(8, 27, 9, 11, canvas); p(8, 31, 3, 6, shade);
    p(7, 26, 10, 4, leather); p(8, 26, 9, 3, flap);
    p(7, 32, 3, 5, light); p(8, 33, 1, 2, brass);
    p(12, 28, 2, 9, leather); p(12, 32, 2, 2, brass);
    return;
  }
  if (direction === "back") {
    // The main pack is in front of the visible back/tail, below the head. The
    // original paws and tail tip remain outside its 17×12px footprint.
    r(16, 28, 17, 12, outline); r(17, 29, 15, 10, canvas);
    r(17, 34, 3, 5, shade); r(20, 35, 10, 3, light);
    r(15, 28, 19, 4, leather); r(16, 28, 17, 3, flap);
    r(18, 29, 2, 9, leather); r(29, 29, 2, 9, leather);
    r(23, 30, 3, 5, leather); r(23, 32, 3, 2, brass);
    r(18, 36, 2, 2, brass); r(29, 36, 2, 2, brass);
  } else if (side) {
    const x = direction === "left" ? 28 : 18;
    r(x, 31, 3, 7, leather); r(x + 1, 31, 1, 5, flap);
    r(x, 36, 3, 2, brass);
  } else {
    // From the front the bag is hidden by the body; only two shoulder straps
    // show below the cheeks. Eyes, mouth and the free swinging paws stay clear.
    for (const x of [16, 30]) {
      r(x, 31, 3, 8, leather); r(x + 1, 31, 1, 6, flap); r(x, 36, 3, 2, brass);
    }
  }
}
