/** Editable pixel rig. All shapes are rasterized on a fixed 48 × 48 grid. */
export type PixelPose = "idle" | "walk" | "blink" | "sleep" | "drowsy" | "stretch" | "crouch" | "jump" | "groom" | "greet" | "sniff" | "reach" | "hold" | "chew" | "swallow"
  | "scratch" | "yawn" | "shake" | "sneeze" | "wonder" | "carry" | "toss" | "present";
export type PixelDirection = "front" | "back" | "left" | "right";
const colors = {
  outline: "#514d32", cream: "#f4e4ae", light: "#fff1c9", shade: "#d8bf83",
  moss: "#7c8845", mossLight: "#a5ad58", mossDark: "#58683b", eye: "#30291d",
};
const cache = new Map<string, HTMLCanvasElement>();
const CACHE_LIMIT = 384;

export function pixelSprite(pose: PixelPose, direction: PixelDirection, frame: number, appearance?: { palette: string; head: string | null; neck: string | null }): HTMLCanvasElement {
  frame = Number.isFinite(frame) ? ((Math.trunc(frame) % 4) + 4) % 4 : 0;
  const key = `${pose}:${direction}:${frame % 4}:${appearance?.palette ?? "moss"}:${appearance?.head ?? ""}:${appearance?.neck ?? ""}`;
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    for (let row = -ry; row <= ry; row++) {
      const half = Math.floor(rx * Math.sqrt(Math.max(0, 1 - row * row / (ry * ry))));
      rect(x - half, y + row, half * 2 + 1, 1, color);
    }
  };
  const walking = pose === "walk" || pose === "carry";
  const c = appearance?.palette === "fern" ? { ...colors, moss: "#49816b", mossLight: "#7fb99a", mossDark: "#345649" }
    : appearance?.palette === "autumn" ? { ...colors, moss: "#b27b42", mossLight: "#d8ae63", mossDark: "#7a5637" } : colors;
  const step = walking ? [0, -1, 0, 1][frame % 4] : 0;
  const bob = walking && frame % 2 === 1 ? -1 : pose === "chew" ? [0, 1, 0, 1][frame % 4] : 0;
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
    const crouch = pose === "crouch" ? 4 : pose === "sniff" ? 2 : pose === "reach" ? [1, 3, 5, 6][frame % 4] : pose === "hold" ? [6, 4, 2, 0][frame % 4] : 0;
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
    for (const [x, offset] of [[17, step], [31, -step]]) {
      oval(x, 42 + offset, 5, 2, c.outline); oval(x, 41 + offset, 4, 2, c.shade);
      rect(x - 2, 40 + offset, 5, 1, c.light);
    }
    const earOffset = walking ? (frame % 2 ? 1 : 0) : pose === "greet" ? (frame % 2 ? -1 : 0)
      : pose === "shake" ? [-3, 2, 3, -2][frame % 4] : pose === "scratch" ? [0, 1, 2, 1][frame % 4] : 0;
    oval(9, faceY + 1 + earOffset, 7, 10, c.shade); oval(9, faceY + earOffset, 6, 9, c.cream);
    oval(8, faceY + 2 + earOffset, 4, 6, c.moss); rect(5, faceY + 2 + earOffset, 2, 4, c.mossLight);
    oval(37, faceY - 3 - earOffset, 7, 10, c.shade); oval(37, faceY - 4 - earOffset, 6, 9, c.cream);
    oval(38, faceY - 2 - earOffset, 4, 6, c.moss); rect(39, faceY - 3 - earOffset, 2, 4, c.mossLight);
    oval(24, faceY, 13, 12, c.shade); oval(24, faceY - 1, 12, 11, direction === "back" ? c.moss : c.cream);
    if (direction === "back") {
      rect(20, faceY - 8, 6, 3, c.mossLight); rect(17, faceY - 3, 3, 3, c.mossLight);
    } else {
      oval(22 + side * 2, faceY - 1, 9, 8, c.light);
      rect(19, faceY - 12, 9, 5, c.moss); rect(17, faceY - 10, 12, 3, c.moss);
      rect(21, faceY - 13, 3, 2, c.mossLight); rect(24, faceY - 8, 3, 2, c.moss);
      const look = direction === "left" ? -3 : direction === "right" ? 3 : pose === "wonder" ? [-1, 0, 1, 0][frame % 4] : 0;
      for (const x of [19 + look, 29 + look]) {
        if (["blink", "groom", "yawn", "sneeze", "shake"].includes(pose) || (pose === "chew" && frame % 2 === 1 || pose === "swallow")) rect(x - 1, faceY, 3, 1, c.eye);
        else { oval(x, faceY, 2, pose === "wonder" ? 4 : 3, c.eye); rect(x, faceY - 2, 1, 1, "#fff8e8"); }
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
    const feeding = ["reach", "hold", "chew", "carry", "toss", "present"].includes(pose);
    const armY = pose === "stretch" || pose === "jump" ? 23 : pose === "reach" ? 35 + frame % 4
      : pose === "hold" ? [37, 34, 31, 29][frame % 4] : pose === "chew" ? 29 + frame % 2
        : pose === "carry" ? 30 + bob : pose === "toss" ? [28, 17, 21, 29][frame % 4]
          : pose === "present" ? 22 + frame % 2 : pose === "groom" || pose === "yawn" ? faceY + 5 : 32 + bob;
    if (direction === "back") drawTail();
    // Hands holding an object cannot show through the back either.
    const frontHands = feeding && direction !== "back";
    const leftHand = frontHands ? 19 : 14, rightHand = frontHands ? 29 : 34;
    const swing = pose === "walk" ? step : 0;
    const armShade = direction === "back" ? c.mossDark : c.shade;
    const armLight = direction === "back" ? c.moss : c.cream;
    oval(leftHand, armY - swing, 3, 5, armShade); oval(leftHand, armY - 1 - swing, 2, 4, armLight);
    const wave = pose === "greet" ? -5 + (frame % 2) * 2 : pose === "scratch" ? -17 + (frame % 2) * 3 : 0;
    oval(rightHand, armY + wave + swing, 3, 5, armShade); oval(rightHand, armY - 1 + wave + swing, 2, 4, armLight);
  }
  // Wearables share the rig's pose anchors and depth rules in every direction.
  if (appearance && pose !== "sleep" && pose !== "drowsy") {
    if (appearance.neck) {
      const scarf = appearance.neck === "berry_scarf" ? "#b96374" : "#e2a44d";
      const neckY = 31 + bob + Math.round((headOffset - bob) / 3);
      rect(14, neckY, 21, 3, "#65492f"); rect(15, neckY, 19, 2, scarf);
      if (direction !== "back") { rect(direction === "left" ? 18 : 28, neckY + 2, 4, 6 + (walking ? frame % 2 : 0), scarf); }
    }
    if (appearance.head) {
      const cap = appearance.head === "leaf_cap" ? "#9cb764" : "#c29a61";
      // Keep the cap attached while bending down, yawning and stretching.
      const capTop = Math.max(0, 1 + headOffset);
      rect(14, 7 + headOffset, 22, 3, "#514d32"); rect(16, 5 + headOffset, 18, 4, cap);
      rect(20, capTop, 11, 5 + headOffset - capTop + 1, cap); rect(20, 5 + headOffset, 11, 1, "#78613b");
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, canvas);
  return canvas;
}
