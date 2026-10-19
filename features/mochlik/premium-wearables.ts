import type { PixelDirection } from "./pixel-sprite";

type Rect = (x: number, y: number, width: number, height: number, color: string) => void;
type Oval = (x: number, y: number, radiusX: number, radiusY: number, color: string) => void;
type Painter = { rect: Rect; oval: Oval };
const gold = "#e6c66c", goldLight = "#fff0ae";

/** Small body details are behind the face and hands, so every work pose stays readable. */
export function drawPremiumTorso(palette: string | undefined, direction: PixelDirection, bob: number, { rect }: Painter) {
  const back = direction === "back";
  if (palette === "premium_stargazer_moss") {
    rect(17, 32 + bob, 15, 7, "#525984"); rect(16, 33 + bob, 17, 4, "#525984");
    rect(16, 33 + bob, 3, 5, "#353955"); rect(30, 33 + bob, 3, 5, "#353955");
    rect(17, 37 + bob, 15, 1, gold);
    if (back) { rect(22, 30 + bob, 2, 5, gold); rect(24, 30 + bob, 2, 1, gold); rect(24, 34 + bob, 2, 1, gold); }
    else { rect(22, 34 + bob, 2, 2, gold); rect(27, 36 + bob, 1, 1, goldLight); }
  } else if (palette === "premium_ember_moss") {
    rect(17, 32 + bob, 15, 7, "#ad6048"); rect(16, 33 + bob, 17, 4, "#ad6048");
    rect(16, 33 + bob, 3, 5, "#733f3a"); rect(30, 33 + bob, 3, 5, "#733f3a");
    rect(18, 37 + bob, 13, 1, "#eda773");
    if (back) { rect(23, 29 + bob, 2, 6, "#eda773"); rect(21, 32 + bob, 6, 3, "#eda773"); rect(23, 33 + bob, 2, 2, goldLight); }
    else { rect(23, 34 + bob, 2, 4, "#434858"); rect(23, 35 + bob, 2, 1, gold); }
  } else if (palette === "premium_explorer_moss") {
    rect(17, 32 + bob, 15, 7, "#638879"); rect(16, 33 + bob, 17, 4, "#638879");
    rect(16, 34 + bob, 5, 4, "#3a5d55"); rect(28, 34 + bob, 5, 4, "#3a5d55");
    rect(17, 34 + bob, 3, 1, "#d2bc84"); rect(29, 34 + bob, 3, 1, "#d2bc84");
    if (back) { rect(20, 29 + bob, 9, 8, "#a47e50"); rect(21, 30 + bob, 7, 2, "#d2bc84"); rect(23, 33 + bob, 3, 2, "#638879"); }
    else { rect(23, 33 + bob, 2, 5, "#a47e50"); rect(23, 36 + bob, 2, 1, gold); }
  }
}

export function drawPremiumNeck(id: string, direction: PixelDirection, y: number, swing: number, { rect }: Painter): boolean {
  if (id === "premium_stargazer_scarf") {
    rect(14, y, 21, 3, "#8c703f"); rect(15, y, 19, 2, gold);
    if (direction === "back") { rect(21, y + 2, 7, 2, gold); rect(23, y + 4, 3, 2, goldLight); }
    else { const x = direction === "left" ? 17 : 29; rect(x, y + 2, 4, 6 + swing, gold); rect(x, y + 4, 4, 1, goldLight); rect(x + 1, y + 6 + swing, 2, 1, "#8c703f"); }
  } else if (id === "premium_ember_scarf") {
    rect(14, y, 21, 3, "#303443"); rect(15, y, 19, 2, "#596174");
    const x = direction === "left" ? 16 : 30;
    rect(x, y + 2, 4, 6 + swing, "#434858"); rect(x, y + 5, 4, 1, "#eda773");
    if (direction !== "back") { rect(23, y, 3, 3, "#c2874d"); rect(24, y, 1, 2, goldLight); }
  } else if (id === "premium_explorer_scarf") {
    rect(14, y, 21, 3, "#346b73"); rect(15, y, 19, 2, "#55a4ab");
    rect(16, y, 17, 1, "#b3dbcd");
    if (direction === "back") { rect(21, y + 2, 8, 2, "#55a4ab"); rect(23, y + 4, 4, 2, "#55a4ab"); }
    else { rect(19, y + 2, 11, 2, "#55a4ab"); rect(21, y + 4, 7, 2, "#55a4ab"); rect(23, y + 6, 3, 1, "#b3dbcd"); }
  } else return false;
  return true;
}

export function drawPremiumHead(id: string, direction: PixelDirection, y: number, { rect, oval }: Painter): boolean {
  if (id === "premium_stargazer_hat") {
    rect(12, 8 + y, 26, 3, "#353955"); rect(13, 8 + y, 24, 2, "#7279ab");
    rect(17, 5 + y, 17, 3, "#525984"); rect(20, 2 + y, 13, 4, "#525984");
    rect(24, y, 7, 3, "#7279ab"); rect(29, y, 5, 1, gold);
    rect(18, 7 + y, 15, 1, gold);
    if (direction !== "back") { rect(25, 3 + y, 1, 3, goldLight); rect(24, 4 + y, 3, 1, goldLight); }
    else { rect(21, 4 + y, 2, 1, "#9b9ed1"); rect(29, 6 + y, 1, 1, gold); }
  } else if (id === "premium_ember_hat") {
    oval(25, 6 + y, 10, 5, "#733f3a"); oval(24, 5 + y, 9, 4, "#b86748");
    rect(15, 8 + y, 22, 3, "#733f3a"); rect(16, 8 + y, 20, 2, "#eda773");
    oval(31, 1 + y, 3, 2, "#eda773"); rect(19, 4 + y, 1, 3, "#eda773"); rect(23, 3 + y, 1, 3, "#eda773");
    if (direction !== "back") { rect(27, 7 + y, 3, 3, gold); rect(28, 7 + y, 1, 2, goldLight); }
    else { rect(28, 3 + y, 1, 3, "#733f3a"); }
  } else if (id === "premium_explorer_hat") {
    rect(9, 8 + y, 30, 3, "#604e37"); rect(10, 8 + y, 28, 2, "#d2bc84");
    rect(16, 3 + y, 18, 5, "#a47e50"); rect(19, 2 + y, 12, 2, "#d2bc84");
    rect(16, 6 + y, 18, 2, "#3a5d55");
    const featherX = direction === "left" ? 16 : 32;
    rect(featherX, 2 + y, 2, 5, "#55a4ab"); rect(featherX + 1, y, 2, 4, "#b3dbcd");
    if (direction !== "back") { rect(direction === "left" ? 18 : 28, 6 + y, 3, 2, gold); }
  } else return false;
  return true;
}
