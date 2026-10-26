import { mossPalette } from "./appearance-palette";
import { drawMiningPickaxe } from "./mining-pickaxe";
import { drawPremiumHead, drawPremiumNeck, drawPremiumTorso } from "./premium-wearables";
import { drawBerestBag, drawBerestHead, drawBerestNeck, drawBerestTorso } from "./berest-wearables";

/** Editable pixel rig. All shapes are rasterized on a fixed 48 × 48 grid. */
export type PixelPose = "idle" | "walk" | "blink" | "sleep" | "drowsy" | "stretch" | "crouch" | "jump" | "groom" | "greet" | "sniff" | "reach" | "hold" | "chew" | "swallow"
  | "scratch" | "yawn" | "shake" | "sneeze" | "wonder" | "carry" | "toss" | "present" | "fish" | "fishing-walk";
export type PixelDirection = "front" | "back" | "left" | "right";
/** Interaction painters own continuous arms outside the cached body sprite. */
export type PixelRigOptions = { gardening?: boolean; crouch?: number; lean?: number; fishingStance?: boolean; mining?: boolean };
const colors = {
  outline: "#514d32", cream: "#f4e4ae", light: "#fff1c9", shade: "#d8bf83",
  moss: "#7c8845", mossLight: "#a5ad58", mossDark: "#58683b", eye: "#30291d",
};
const cache = new Map<string, HTMLCanvasElement>();
const CACHE_LIMIT = 384;
export type PixelSpriteContact = { bottom: number; left: number; right: number };
const contacts = new WeakMap<HTMLCanvasElement, PixelSpriteContact>();

/** The rig paints opaque integer rectangles, so its sole can be recorded while
 * drawing. Reading the finished GPU canvas would stall every new pose/frame. */
export const pixelSpriteContact = (sprite: HTMLCanvasElement) => contacts.get(sprite);

export function pixelSprite(pose: PixelPose, direction: PixelDirection, frame: number, appearance?: { palette: string; head: string | null; neck: string | null }, rig?: PixelRigOptions): HTMLCanvasElement {
  frame = Number.isFinite(frame) ? ((Math.trunc(frame) % 4) + 4) % 4 : 0;
  const rigCrouch = Number.isFinite(rig?.crouch) ? Math.max(0, Math.min(6, Math.round(rig!.crouch!))) : undefined;
  const rigLean = Number.isFinite(rig?.lean) ? Math.max(-3, Math.min(3, Math.round(rig!.lean!))) : 0;
  const key = `${pose}:${direction}:${frame % 4}:${appearance?.palette ?? "moss"}:${appearance?.head ?? ""}:${appearance?.neck ?? ""}:${Boolean(rig?.gardening)}:${rigCrouch ?? "pose"}:${rigLean}:${Boolean(rig?.fishingStance)}:${Boolean(rig?.mining)}`;
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const rowLeft = new Int16Array(48).fill(48), rowRight = new Int16Array(48);
  let leanOffset = rigLean;
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    const left = Math.round(x + leanOffset), top = Math.round(y);
    ctx.fillStyle = color; ctx.fillRect(left, top, w, h);
    const clippedLeft = Math.max(0, left), clippedRight = Math.min(48, left + w);
    if (clippedRight <= clippedLeft) return;
    for (let row = Math.max(0, top); row < Math.min(48, top + h); row++) {
      rowLeft[row] = Math.min(rowLeft[row], clippedLeft); rowRight[row] = Math.max(rowRight[row], clippedRight);
    }
  };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    for (let row = -ry; row <= ry; row++) {
      const half = Math.floor(rx * Math.sqrt(Math.max(0, 1 - row * row / (ry * ry))));
      rect(x - half, y + row, half * 2 + 1, 1, color);
    }
  };
  const walking = pose === "walk" || pose === "carry" || pose === "fishing-walk";
  const c = { ...colors, ...mossPalette(appearance?.palette) };
  const step = walking ? [0, -1, 0, 1][frame % 4] : 0;
  const bob = walking && frame % 2 === 1 ? -1 : pose === "chew" ? [0, 1, 0, 1][frame % 4] : 0;
  const mining = Boolean(rig?.mining) && (pose === "idle" || pose === "walk");
  const drawMiningTool = () => {
    const left = direction === "left";
    drawMiningPickaxe(ctx, left ? 14 : 34, 34 + bob + (left ? -step : step), 48 * .36, left ? -.5 : .5);
  };
  // A tool held in front of the miner belongs behind the back-facing body.
  if (mining && direction === "back") drawMiningTool();
  let headOffset = bob;
  if (pose === "sleep" || pose === "drowsy") {
    const breath = frame === 1 ? -1 : 0;
    // A rounded curl: raised back, folded ears, cheek on paws and tail around the feet.
    // Only the back expands; the face and floor contact never bob up and down.
    oval(27, 30 + breath, 14, 14, c.outline); oval(27, 29 + breath, 13, 13, c.mossDark);
    oval(26, 28 + breath, 12, 12, c.moss); oval(28, 22 + breath, 7, 4, c.mossLight);
    rect(25, 18 + breath, 4, 2, c.mossLight); rect(32, 23 + breath, 3, 3, c.mossDark);
    const earLift = pose === "drowsy" ? -1 : 0;
    oval(12, 27 + earLift, 5, 7, c.shade); oval(12, 26 + earLift, 4, 6, c.cream);
    oval(11, 27 + earLift, 2, 4, c.moss);
    oval(21, 33, 11, 10, c.shade); oval(20, 31, 10, 9, c.cream);
    oval(20, 30, 8, 7, c.light); rect(19, 22, 5, 3, c.moss); rect(22, 24, 3, 2, c.mossLight);
    rect(14, 31, 4, 1, c.eye); rect(23, 31, 4, 1, c.eye);
    if (pose === "drowsy") { rect(16, 32, 1, 1, c.eye); rect(25, 32, 1, 1, c.eye); }
    rect(20, 34, 2, 2, c.outline); rect(21, 36, 2, 1, c.outline);
    oval(21, 41, 7, 3, c.shade); oval(20, 40, 6, 2, c.cream); rect(17, 39, 5, 1, c.light);
    oval(33, 38, 7, 6, c.mossDark); oval(33, 37, 6, 5, c.moss); rect(32, 34, 4, 2, c.mossLight);
  } else {
    const crouch = rigCrouch ?? (pose === "crouch" ? 4 : pose === "sniff" || pose === "fish" ? 2 : pose === "reach" ? [1, 3, 5, 6][frame % 4] : pose === "hold" ? [6, 4, 2, 0][frame % 4] : 0);
    const stretch = pose === "stretch" ? -3 : pose === "yawn" ? [0, -2, -3, 0][frame % 4]
      : pose === "sneeze" ? [-2, -1, 4, 1][frame % 4] : pose === "wonder" ? -2 : 0;
    const faceY = 20 + bob + crouch + stretch;
    headOffset = faceY - 20;
    const side = direction === "left" ? -1 : direction === "right" ? 1 : 0;
    const wag = walking || pose === "greet" ? [0, -1, 0, 1][frame] : 0;
    const tailX = (direction === "back" ? 24 : direction === "right" ? 12 : 36) + wag;
    const tailY = (direction === "back" ? 36 : 34) + bob;
    const drawTail = () => {
      oval(tailX, tailY + 1, 7, 6, c.mossDark); oval(tailX, tailY, 6, 5, c.moss);
      rect(tailX - 2, tailY - 3, 4, 2, c.mossLight);
    };
    // The rear-facing tail is on the visible rump; side tails are behind the body.
    if (direction !== "back") drawTail();
    oval(24, 32 + bob, 13, 11, c.outline); oval(24, 31 + bob, 12, 11, c.shade);
    oval(direction === "back" ? 24 : side > 0 ? 21 : 28, 29 + bob, 10, 9, c.moss);
    if (direction !== "back") oval(side > 0 ? 26 : side < 0 ? 20 : 22, 32 + bob, 9, 9, c.cream);
    drawPremiumTorso(appearance?.palette, direction, bob, { rect, oval });
    drawBerestTorso(appearance?.palette, direction, bob, { rect });
    leanOffset = 0;
    for (const [x, offset] of [[17, step], [31, -step]]) {
      oval(x, 42 + offset, 5, 2, c.outline); oval(x, 41 + offset, 4, 2, c.shade);
      rect(x - 2, 40 + offset, 5, 1, c.light);
    }
    leanOffset = rigLean;
    const earOffset = walking ? (frame % 2 ? 1 : 0) : pose === "greet" ? (frame % 2 ? -1 : 0)
      : pose === "shake" ? [-3, 2, 3, -2][frame % 4] : pose === "scratch" ? [0, 1, 2, 1][frame % 4] : 0;
    oval(9, faceY + 1 + earOffset, 7, 10, c.shade); oval(9, faceY + earOffset, 6, 9, c.cream);
    oval(8, faceY + 2 + earOffset, 4, 6, c.moss); rect(5, faceY + 2 + earOffset, 2, 4, c.mossLight);
    oval(37, faceY - 3 - earOffset, 7, 10, c.shade); oval(37, faceY - 4 - earOffset, 6, 9, c.cream);
    oval(38, faceY - 2 - earOffset, 4, 6, c.moss); rect(39, faceY - 3 - earOffset, 2, 4, c.mossLight);
    // Opaque lining seals the gap above the head without painting over the face.
    if (appearance?.head === "rain_hood" && direction !== "back") rect(13, 7 + headOffset, 23, 7, "#3c5668");
    oval(24, faceY, 13, 12, c.shade); oval(24, faceY - 1, 12, 11, direction === "back" ? c.moss : c.cream);
    if (direction === "back") {
      rect(20, faceY - 8, 6, 3, c.mossLight); rect(17, faceY - 3, 3, 3, c.mossLight);
    } else {
      oval(22 + side * 2, faceY - 1, 9, 8, c.light);
      rect(19, faceY - 12, 9, 5, c.moss); rect(17, faceY - 10, 12, 3, c.moss);
      rect(21, faceY - 13, 3, 2, c.mossLight); rect(24, faceY - 8, 3, 2, c.moss);
      const look = direction === "left" ? rig?.fishingStance ? -2 : -3 : direction === "right" ? rig?.fishingStance ? 2 : 3 : pose === "wonder" ? [-1, 0, 1, 0][frame % 4] : 0;
      for (const x of [19 + look, 29 + look]) {
        if (["blink", "groom", "yawn", "sneeze", "shake"].includes(pose) || (pose === "chew" && frame % 2 === 1 || pose === "swallow")) rect(x - 1, faceY, 3, 1, c.eye);
        else {
          // Use the same compact glyph for both eyes in every rig. A narrow
          // ellipse leaves single-pixel tips which resample unevenly at camera zoom.
          const top = pose === "wonder" ? faceY - 3 : faceY - 2;
          const height = pose === "wonder" ? 6 : 5;
          rect(x - 1, top + 1, 3, height - 2, c.eye);
          rect(x - 1, top, 2, 1, c.eye); rect(x - 1, top + height - 1, 2, 1, c.eye);
          rect(x - 1, top + 1, 1, 1, "#fff8e8");
        }
      }
      rect(23 + look, faceY + 3, 3, 2, c.outline); rect(24 + look, faceY + 5, 1, 2, c.outline);
      if (pose === "yawn") {
        const opening = [1, 3, 4, 1][frame % 4];
        oval(24 + look, faceY + 7, 3, opening, c.eye); rect(23 + look, faceY + 7 + opening - 1, 3, 1, c.shade);
      } else if (pose === "sneeze" && frame === 2) {
        oval(24 + look, faceY + 7, 4, 2, c.eye);
      } else if (pose === "chew" && frame % 2 === 0) {
        oval(24 + look, faceY + 7, 3, 2, c.eye); rect(23 + look, faceY + 6, 3, 1, c.cream);
      } else {
        rect(21 + look, faceY + 6, 3, 1, c.outline); rect(25 + look, faceY + 6, 2, 1, c.outline);
      }
      if (pose === "chew" || pose === "swallow") {
        rect(15 + look, faceY + 4, 3, 2, c.shade); rect(30 + look, faceY + 4, 3, 2, c.shade);
      }
    }
    const fishing = pose === "fish" || pose === "fishing-walk";
    const feeding = fishing || ["reach", "hold", "chew", "carry", "toss", "present"].includes(pose);
    const armY = pose === "stretch" || pose === "jump" ? 23 : pose === "reach" ? 35 + frame % 4
      : pose === "hold" ? [37, 34, 31, 29][frame % 4] : pose === "chew" ? 29 + frame % 2
        : pose === "carry" ? 30 + bob : pose === "toss" ? [28, 17, 21, 29][frame % 4]
          : pose === "present" ? 22 + frame % 2 : pose === "groom" || pose === "yawn" ? faceY + 5 : 32 + bob;
    if (direction === "back") drawTail();
    // Hands holding an object cannot show through the back either.
    const frontHands = feeding && direction !== "back";
    const leftHand = fishing && direction === "left" ? 12 : frontHands ? 19 : 14;
    const rightHand = fishing && direction !== "left" ? 36 : frontHands ? 29 : 34;
    const swing = pose === "walk" ? step : 0;
    const armShade = direction === "back" ? c.mossDark : c.shade;
    const armLight = direction === "back" ? c.moss : c.cream;
    // The pickaxe hangs from the lower paw, below the eyes. Paint the existing
    // paw over its shaft instead of adding an arm across the torso.
    if (mining && direction !== "back") drawMiningTool();
    if (!rig?.gardening) { oval(leftHand, armY - swing, 3, 5, armShade); oval(leftHand, armY - 1 - swing, 2, 4, armLight); }
    const wave = pose === "greet" ? -5 + (frame % 2) * 2 : pose === "scratch" ? -17 + (frame % 2) * 3 : 0;
    if (!rig?.gardening) { oval(rightHand, armY + wave + swing, 3, 5, armShade); oval(rightHand, armY - 1 + wave + swing, 2, 4, armLight); }
  }
  // Wearables share the rig's pose anchors and depth rules in every direction.
  if (appearance && pose !== "sleep" && pose !== "drowsy") {
    drawBerestBag(appearance.palette, direction, bob, { rect });
    if (appearance.neck && !drawBerestNeck(appearance.neck, direction, 31 + bob + Math.round((headOffset - bob) / 3), walking ? frame % 2 : 0, { rect })
      && !drawPremiumNeck(appearance.neck, direction, 31 + bob + Math.round((headOffset - bob) / 3), walking ? frame % 2 : 0, { rect, oval })) {
      const scarf = appearance.neck === "berry_scarf" ? "#b96374" : appearance.neck === "river_scarf" ? "#6299b1"
        : appearance.neck === "forest_bandana" ? "#77905f" : appearance.neck === "moon_scarf" ? "#b7afd7"
          : appearance.neck === "sea_neckerchief" ? "#4d91a4" : appearance.neck === "sunset_scarf" ? "#cd7652" : "#e2a44d";
      const neckY = 31 + bob + Math.round((headOffset - bob) / 3);
      const knotX = direction === "left" ? 18 : 28;
      rect(14, neckY, 21, 3, "#65492f"); rect(15, neckY, 19, 2, scarf);
      if (appearance.neck === "sea_neckerchief") {
        // The sailor's white piping and short double knot remain readable at map zoom.
        rect(15, neckY, 19, 1, "#dce6d0");
        if (direction === "back") { rect(20, neckY + 2, 9, 2, scarf); rect(22, neckY + 4, 5, 2, "#dce6d0"); }
        else { rect(knotX - 2, neckY + 2, 3, 4, scarf); rect(knotX + 2, neckY + 2, 3, 5, scarf); rect(knotX, neckY + 1, 2, 2, "#e7d3a0"); }
      } else if (appearance.neck === "forest_bandana") {
        if (direction === "back") { rect(28, neckY + 2, 4, 2, "#aaba80"); rect(30, neckY + 3, 2, 2, scarf); }
        else { rect(19, neckY + 2, 11, 2, scarf); rect(21, neckY + 4, 7, 2, scarf); rect(23, neckY + 6, 3, 1, "#aaba80"); }
      } else if (direction !== "back") {
        rect(knotX, neckY + 2, 4, 6 + (walking ? frame % 2 : 0), scarf);
        if (appearance.neck === "river_scarf") rect(knotX, neckY + 5, 4, 1, "#c1e0dd");
        if (appearance.neck === "moon_scarf") { rect(knotX + 1, neckY + 4, 2, 2, "#f2e5ba"); rect(17, neckY, 4, 1, "#ddd4ee"); }
        if (appearance.neck === "sunset_scarf") { rect(16, neckY, 17, 1, "#efba79"); rect(knotX, neckY + 4, 4, 1, "#efba79"); rect(knotX, neckY + 6, 1, 2, "#894e47"); rect(knotX + 3, neckY + 6, 1, 2, "#894e47"); }
      }
    }
    if (appearance.head && !drawBerestHead(appearance.head, direction, headOffset, { rect })
      && !drawPremiumHead(appearance.head, direction, headOffset, { rect, oval })) {
      const hatY = headOffset;
      if (appearance.head === "trail_hat") {
        // A low weathered crown and broad brim, distinct from the collection hat.
        rect(12, 8 + hatY, 26, 3, "#69583c"); rect(13, 8 + hatY, 24, 2, "#c8b17c");
        rect(17, 3 + hatY, 16, 5, "#a98a56"); rect(20, 1 + hatY, 10, 3, "#c8b17c");
        rect(17, 6 + hatY, 16, 2, "#69583c");
        if (direction !== "back") { rect(direction === "left" ? 17 : 29, 6 + hatY, 3, 2, "#d7c584"); }
      } else if (appearance.head === "rain_hood") {
        const hood = "#55788b", fold = "#3c5668", edge = "#90a9ad", light = "#7294a0";
        if (direction === "back") {
          // A rounded, gathered hood drapes onto the shoulders rather than ending
          // as a straight helmet. Its seam bends with the fabric's soft folds.
          oval(24, 15 + hatY, 14, 14, fold); oval(24, 14 + hatY, 13, 13, hood);
          oval(21, 9 + hatY, 7, 6, light); oval(23, 11 + hatY, 8, 6, hood);
          rect(26, 4 + hatY, 1, 7, edge); rect(27, 11 + hatY, 1, 7, light);
          rect(26, 18 + hatY, 1, 6, edge); rect(25, 24 + hatY, 1, 3, fold);
          rect(12, 20 + hatY, 2, 4, fold); rect(14, 24 + hatY, 3, 3, fold);
          rect(34, 16 + hatY, 2, 6, fold); rect(32, 22 + hatY, 3, 3, fold);
          rect(17, 27 + hatY, 14, 2, fold); rect(19, 28 + hatY, 10, 2, hood);
          rect(19, 27 + hatY, 5, 1, edge);
        } else {
          // Rasterize the open arch directly: no face repaint/readback, and the
          // opening stays outside both eye glyphs even in a turning fishing rig.
          const openingX = direction === "left" ? 23 : direction === "right" ? 25 : 24;
          for (let row = 1; row <= 26; row++) {
            const outer = Math.floor(14 * Math.sqrt(Math.max(0, 1 - ((row - 15) / 14) ** 2)));
            const inner = row < 7 ? -1 : Math.floor(12 * Math.sqrt(Math.max(0, 1 - ((row - 20) / 14) ** 2)));
            const left = 24 - outer, right = 24 + outer;
            if (inner < 0) {
              rect(left, row + hatY, outer * 2 + 1, 1, fold);
              if (outer > 1) rect(left + 1, row + hatY, outer * 2 - 1, 1, row < 5 ? light : hood);
            } else {
              const leftWidth = Math.max(0, Math.min(right + 1, openingX - inner) - left);
              const rightX = Math.max(left, openingX + inner + 1), rightWidth = right - rightX + 1;
              if (leftWidth > 0) {
                rect(left, row + hatY, leftWidth, 1, fold);
                if (leftWidth > 1) rect(left + 1, row + hatY, leftWidth - 1, 1, hood);
                rect(left + leftWidth - 1, row + hatY, 1, 1, edge);
              }
              if (rightWidth > 0) {
                rect(rightX, row + hatY, rightWidth, 1, fold);
                if (rightWidth > 2) rect(rightX + 1, row + hatY, rightWidth - 2, 1, hood);
                rect(rightX, row + hatY, 1, 1, light);
              }
            }
          }
          rect(18, 5 + hatY, 7, 1, edge); rect(27, 5 + hatY, 4, 1, light);
          rect(12, 25 + hatY, 4, 3, fold); rect(13, 26 + hatY, 5, 3, hood);
          rect(33, 24 + hatY, 4, 3, fold); rect(31, 26 + hatY, 5, 3, hood);
          rect(16, 28 + hatY, 4, 2, edge); rect(29, 28 + hatY, 5, 2, light);
          rect(19, 30 + hatY, 1, 4, "#d1c79a"); rect(28, 30 + hatY, 1, 3, "#d1c79a");
          rect(18, 33 + hatY, 2, 1, fold); rect(28, 32 + hatY, 2, 1, fold);
        }
      } else if (appearance.head === "acorn_cap") {
        // Low rounded acorn cup; the stem follows the crown while bending.
        rect(14, 7 + hatY, 22, 3, "#654b36"); rect(16, 4 + hatY, 18, 4, "#996743");
        rect(20, 2 + hatY, 10, 3, "#bb8652"); rect(24, Math.max(0, hatY), 3, 3, "#654b36");
        rect(16, 7 + hatY, 18, 2, "#c5955e");
        for (const x of [18, 23, 28, 32]) rect(x, 7 + hatY, 2, 1, "#795336");
      } else if (appearance.head === "knitted_cap") {
        rect(16, 4 + hatY, 18, 6, "#536384"); rect(19, 2 + hatY, 12, 5, "#697caa");
        rect(23, Math.max(0, hatY), 5, 3, "#c6ccdf");
        rect(14, 8 + hatY, 22, 3, "#697caa"); rect(16, 8 + hatY, 18, 1, "#a6b4d1");
        for (const x of [20, 24, 28]) rect(x, 4 + hatY, 1, 3, "#8b9bbd");
      } else if (appearance.head === "moon_crown") {
        // A fine silver wreath, not a tall crown: the face and ears stay clear.
        rect(13, 8 + hatY, 24, 2, "#766987"); rect(15, 8 + hatY, 20, 1, "#c3c1e4");
        for (const x of [15, 20, 28, 33]) { rect(x, 6 + hatY, 2, 2, "#c3c1e4"); rect(x + 1, 5 + hatY, 1, 1, "#e2ddef"); }
        if (direction !== "back") { rect(24, 3 + hatY, 2, 5, "#eee0ad"); rect(26, 3 + hatY, 2, 1, "#eee0ad"); rect(26, 7 + hatY, 2, 1, "#eee0ad"); }
      } else {
        const cap = appearance.head === "mining_helmet" ? "#d6b456" : appearance.head === "leaf_cap" ? "#9cb764" : "#c29a61";
        // Keep the cap attached while bending down, yawning and stretching.
        const capTop = Math.max(0, 1 + headOffset);
        rect(14, 7 + headOffset, 22, 3, "#514d32"); rect(16, 5 + headOffset, 18, 4, cap);
        rect(20, capTop, 11, 5 + headOffset - capTop + 1, cap); rect(20, 5 + headOffset, 11, 1, "#78613b");
        if (appearance.head === "mining_helmet") {
          rect(17, 5 + headOffset, 16, 1, "#f2d789");
          if (direction !== "back") { rect(24, 4 + headOffset, 4, 4, "#6a674f"); rect(25, 5 + headOffset, 2, 2, "#fff0ae"); }
        }
      }
    }
  }
  let bottom = 48;
  while (bottom > 0 && rowRight[bottom - 1] === 0) bottom--;
  if (bottom > 0) {
    let left = 48, right = 0;
    for (let row = Math.max(0, bottom - 3); row < bottom; row++) {
      left = Math.min(left, rowLeft[row]); right = Math.max(right, rowRight[row]);
    }
    contacts.set(canvas, { bottom, left, right });
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, canvas);
  return canvas;
}
