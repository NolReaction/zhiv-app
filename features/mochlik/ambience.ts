import { SHELTER_ART, depositedPosition, type HabitatState, type PropKind } from "./habitat";

const rect = (ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) => {
  ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h);
};

function prop(ctx: CanvasRenderingContext2D, kind: PropKind, x: number, y: number, turn = 0) {
  if (kind === "leaf") {
    const narrow = Math.abs(Math.cos(turn)) < .45;
    rect(ctx, "#694e32", x - 1, y - 6, 2, 8);
    rect(ctx, "#c49d4c", x - (narrow ? 1 : 4), y - 6, narrow ? 3 : 8, 3);
    rect(ctx, "#d9bd69", x - (narrow ? 0 : 2), y - 8, narrow ? 1 : 4, 2);
    rect(ctx, "#8b913e", x - (narrow ? 1 : 3), y - 3, narrow ? 2 : 6, 2);
    rect(ctx, "#f0d687", x, y - 7, 1, 6);
  } else if (kind === "cone") {
    rect(ctx, "#4e3d2b", x - 2, y - 10, 4, 2); rect(ctx, "#4e3d2b", x - 4, y - 8, 8, 7);
    rect(ctx, "#9c7849", x - 3, y - 8, 6, 7); rect(ctx, "#6f5337", x - 2, y - 1, 4, 2);
    for (let row = 0; row < 3; row++) {
      rect(ctx, "#c09b60", x - 3 + row % 2, y - 7 + row * 2, 2, 1);
      rect(ctx, "#4e3d2b", x + row % 2, y - 7 + row * 2, 2, 1);
    }
  } else {
    rect(ctx, "#45565a", x - 4, y - 4, 8, 4); rect(ctx, "#728e90", x - 3, y - 6, 6, 5);
    rect(ctx, "#b4d1c3", x - 2, y - 5, 3, 1); rect(ctx, "#91afb0", x + 1, y - 3, 2, 1);
  }
}

/** Shared retained gift artwork for the check-in habitat and personal world. */
export function drawOwnedDecor(ctx: CanvasRenderingContext2D, items: readonly string[], t = 0) {
  if (items.includes("flower")) {
    const bend = Math.round(Math.sin(t * 1.3));
    rect(ctx, "#647e3c", 160, 104, 2, 10); rect(ctx, "#a6af57", 157, 109, 4, 2);
    rect(ctx, "#e4c889", 158 + bend, 100, 5, 5); rect(ctx, "#fff0bc", 159 + bend, 98, 3, 8);
    rect(ctx, "#bd8440", 160 + bend, 101, 2, 2);
  }
  if (items.includes("leaf_bed")) for (let i = 0; i < 4; i++) prop(ctx, "leaf", 174 + i * 4, 109 - i % 2, i);
  if (items.includes("keepsakes")) { prop(ctx, "cone", 205, 120); prop(ctx, "stone", 200, 122); prop(ctx, "stone", 213, 122); }
  if (items.includes("leaf_garland")) {
    for (let i = 0; i < 8; i++) {
      const x = 168 + i * 4, y = 78 + Math.round(Math.sin(i / 7 * Math.PI) * 5);
      rect(ctx, "#6c7141", x, y, 4, 1);
      rect(ctx, i % 2 ? "#adb861" : "#7f9950", x, y + 1, 3, 3);
      rect(ctx, "#d9d68b", x + 1, y + 2, 1, 1);
    }
  }
}

export function drawDecor(ctx: CanvasRenderingContext2D, state: HabitatState, reducedMotion: boolean) {
  const t = reducedMotion ? 0 : state.elapsed;
  ctx.save(); ctx.globalAlpha = reducedMotion ? 1 : .35 + state.decorReveal * .65;
  drawOwnedDecor(ctx, state.decorItems, t);
  ctx.restore();
  if (state.leafDelivered) { const at = depositedPosition("leaf"); prop(ctx, "leaf", at.x * 256, at.y * 256); }
  if (state.keepsake) { const at = depositedPosition(state.keepsake); prop(ctx, state.keepsake, at.x * 256, at.y * 256); }
}

/** Reuse the existing textured mushroom, with a wide cap and a tall stem. It is never food. */
export function drawShelter(ctx: CanvasRenderingContext2D, art: HTMLCanvasElement, capOnly = false) {
  const { x, y, width, capHeight, ground } = SHELTER_ART;
  if (!capOnly) ctx.drawImage(art, 5, 11, 6, 9, x + width / 2 - 4, y + capHeight - 2, 9, ground - y - capHeight + 2);
  ctx.drawImage(art, 0, 0, 16, 11, x, y, width, capHeight);
}

/** Held objects are occluded by the body when it faces away; ground finds stay visible. */
export function propBehindBody(state: HabitatState) {
  return state.direction === "back" && ["carry", "catch", "pickup", "place", "show"].includes(state.activity);
}

export function drawProp(ctx: CanvasRenderingContext2D, state: HabitatState, reducedMotion: boolean) {
  if (!state.prop) return;
  ctx.save();
  if (state.activity === "leaf-drift") ctx.globalAlpha = Math.min(1, state.progress * 5);
  const spinning = state.activity === "toss" || state.activity === "leaf-drift";
  prop(ctx, state.prop, state.propPosition.x * 256, state.propPosition.y * 256,
    reducedMotion || !spinning ? 0 : state.progress * Math.PI * 4);
  ctx.restore();
}

export function drawWeather(ctx: CanvasRenderingContext2D, state: HabitatState, reducedMotion: boolean, tint = true,
  field = { x: 0, y: 0, width: 256, height: 256 }) {
  if (state.rain < .01) return;
  ctx.save();
  if (tint) { ctx.globalAlpha = state.rain * .12; rect(ctx, "#45697d", field.x, field.y, field.width, field.height); }
  const time = reducedMotion ? 0 : state.elapsed;
  const shelter = SHELTER_ART;
  const count = Math.min(reducedMotion ? 40 : 150, Math.ceil((reducedMotion ? 10 : 38) * field.width * field.height / 65536));
  for (let i = 0; i < count; i++) {
    const y = field.y + (i * 61 + time * 118) % (field.height + 14) - 7;
    const x = field.x + ((i * 47 - time * 20) % field.width + field.width) % field.width;
    // The cap actually shields the pet; drops stop above it.
    if (x > shelter.x && x < shelter.x + shelter.width
      && y > shelter.y + shelter.capHeight / 2 && y < shelter.ground + 3) continue;
    ctx.globalAlpha = state.rain * (.22 + i % 3 * .08);
    rect(ctx, "#c0d5d9", x, y, 1, 4); rect(ctx, "#c0d5d9", x - 1, y + 4, 1, 2);
  }
  if (!reducedMotion) for (let i = 0; i < 7; i++) {
    const phase = (time * 1.8 + i * .37) % 1, x = 102 + i * 12, y = 166 + i % 3 * 12;
    ctx.globalAlpha = state.rain * (1 - phase) * .45;
    rect(ctx, "#aec2b5", x - phase * 3, y - Math.sin(phase * Math.PI) * 2, 1, 1);
    rect(ctx, "#aec2b5", x + phase * 3, y - Math.sin(phase * Math.PI) * 2, 1, 1);
  }
  ctx.restore();
}

export function drawMomentAccents(ctx: CanvasRenderingContext2D, state: HabitatState, reducedMotion: boolean) {
  if (reducedMotion) return;
  const { activity: a, progress: p } = state;
  const x = state.position.x * 256, y = (state.position.y - state.size * .53) * 256;
  ctx.save();
  if (a === "sneeze" && p > .35 && p < .85 || a === "shake") {
    const phase = a === "sneeze" ? (p - .35) / .5 : p;
    ctx.globalAlpha = Math.sin(Math.PI * phase) * .8;
    for (let i = 0; i < 5; i++) {
      const dx = (i - 2) * (4 + phase * 11);
      rect(ctx, state.moment === "rain" ? "#bdd6d9" : "#ccd994", x + dx, y + i % 2 * 4 - Math.sin(phase * Math.PI) * 7, 1, 1);
    }
  }
  if (a === "discover" || a === "show" && state.prop === "stone") {
    const pulse = Math.sin(p * Math.PI);
    ctx.globalAlpha = pulse * .9;
    const px = a === "discover" ? state.propGround.x * 256 : state.propPosition.x * 256;
    const py = a === "discover" ? state.propGround.y * 256 - 13 : state.propPosition.y * 256 - 13;
    rect(ctx, "#e9efd1", px - 2, py, 5, 1); rect(ctx, "#e9efd1", px, py - 2, 1, 5);
  }
  ctx.restore();
}
