import type { PixelDirection } from "./pixel-sprite";

type Rect = (x: number, y: number, width: number, height: number, color: string) => void;
type Painter = { rect: Rect };
const bark = "#e1d1a6", light = "#f7edc8", line = "#725c44";
const teal = "#3f8585", tealDark = "#28585d", amber = "#e6b45e";

/** Uses the regular rig anchors: clothes bend with the hero and never cover his eyes. */
export function drawBerestTorso(palette: string | undefined, direction: PixelDirection, bob: number, { rect }: Painter) {
  if (palette !== "berest_birch_moss") return;
  rect(16, 32 + bob, 17, 7, "#5b6951"); rect(16, 33 + bob, 4, 5, "#3b4c3f");
  rect(29, 33 + bob, 4, 5, "#3b4c3f"); rect(17, 38 + bob, 15, 1, bark);
  if (direction === "back") {
    rect(17, 34 + bob, 15, 1, bark);
  } else {
    rect(23, 33 + bob, 2, 5, line); rect(23, 34 + bob, 2, 1, bark); rect(23, 37 + bob, 2, 1, bark);
    rect(direction === "left" ? 18 : 28, 35 + bob, 3, 2, "#899279");
  }
}

/** The shoulder bag is outside the back-facing tail, with its own foreground depth. */
export function drawBerestBag(palette: string | undefined, direction: PixelDirection, bob: number, { rect }: Painter) {
  if (palette !== "berest_birch_moss" || direction !== "back") return;
  rect(29, 30 + bob, 7, 9, line); rect(30, 30 + bob, 5, 8, bark);
  rect(30, 30 + bob, 5, 2, light); rect(31, 33 + bob, 3, 1, line); rect(32, 36 + bob, 3, 1, line);
  rect(32, 31 + bob, 2, 4, tealDark); rect(32, 34 + bob, 2, 1, amber);
}

export function drawBerestHead(id: string, direction: PixelDirection, y: number, { rect }: Painter): boolean {
  if (id !== "berest_trail_hat") return false;
  rect(9, 8 + y, 30, 3, line); rect(10, 8 + y, 28, 2, bark);
  rect(15, 3 + y, 19, 5, line); rect(16, 3 + y, 17, 4, bark);
  rect(19, 1 + y, 12, 3, bark); rect(20, 1 + y, 9, 1, light);
  rect(16, 6 + y, 17, 2, tealDark); rect(17, 6 + y, 15, 1, teal);
  rect(18, 4 + y, 3, 1, line); rect(27, 3 + y, 3, 1, line);
  const fernX = direction === "left" ? 15 : 32;
  rect(fernX, 1 + y, 1, 7, "#365b4f"); rect(fernX - 2, 2 + y, 2, 1, "#92ac73");
  rect(fernX + 1, 3 + y, 2, 1, "#b6c88d"); rect(fernX - 3, 4 + y, 3, 1, "#92ac73");
  if (direction !== "back") rect(direction === "left" ? 18 : 28, 6 + y, 3, 2, amber);
  return true;
}

export function drawBerestNeck(id: string, direction: PixelDirection, y: number, swing: number, { rect }: Painter): boolean {
  if (id !== "berest_lantern_scarf") return false;
  rect(14, y, 21, 3, tealDark); rect(15, y, 19, 2, teal); rect(16, y, 17, 1, "#94c0af");
  if (direction === "back") {
    rect(20, y + 2, 10, 2, teal); rect(22, y + 4, 6, 2, teal); rect(24, y + 6, 2, 1, amber);
  } else {
    const tailX = direction === "left" ? 17 : 29;
    rect(tailX, y + 2, 4, 6 + swing, tealDark); rect(tailX, y + 2, 3, 6 + swing, teal);
    rect(tailX, y + 6 + swing, 3, 1, amber);
    // An amber clasp shaped like a little lantern; this is cloth detail, not a world light.
    const claspX = direction === "left" ? 22 : direction === "right" ? 25 : 24;
    rect(claspX, y + 1, 3, 1, line); rect(claspX - 1, y + 2, 5, 4, line);
    rect(claspX, y + 2, 3, 3, amber); rect(claspX + 1, y + 2, 1, 2, light);
    rect(claspX, y + 5, 3, 1, bark);
  }
  return true;
}
