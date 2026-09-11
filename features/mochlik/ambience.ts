import { HOUSE_ANCHORS, HOME_DECOR } from "./home-layout";
import { pointInPolygon } from "@/features/world/map-layout";
import { depositedPosition, type HabitatState, type PropKind } from "./habitat";

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
export function drawOwnedDecor(ctx: CanvasRenderingContext2D, items: readonly string[], t = 0, lighting = true) {
  if (items.includes("flower")) {
    const { x, y } = HOME_DECOR.flower;
    rect(ctx, "#23382488", x - 8, y, 17, 3);
    rect(ctx, "#60412c", x - 6, y - 9, 13, 8);
    rect(ctx, "#ad7049", x - 5, y - 8, 11, 7);
    rect(ctx, "#d19765", x - 4, y - 7, 3, 5);
    rect(ctx, "#774c34", x + 3, y - 7, 3, 6);
    rect(ctx, "#533c29", x - 7, y - 11, 15, 3);
    rect(ctx, "#c49160", x - 7, y - 10, 15, 2);
    for (let i = 0; i < 3; i++) {
      const fx = x - 5 + i * 5, fy = y - 19 - (i === 1 ? 4 : 0);
      rect(ctx, "#405f32", fx, fy + 2, 1, y - 10 - fy);
      rect(ctx, "#8da956", fx - 3, fy + 6, 3, 2);
      rect(ctx, "#668a43", fx + 1, fy + 4, 3, 2);
      rect(ctx, "#e8d6a6", fx - 3, fy - 1, 7, 3);
      rect(ctx, "#f8ecc4", fx - 1, fy - 3, 3, 7);
      rect(ctx, "#b6853d", fx - 1, fy - 1, 3, 3);
      rect(ctx, "#e5b85d", fx, fy - 1, 2, 2);
    }
  }
  if (items.includes("leaf_bed")) {
    const { x, y } = HOME_DECOR.bed;
    // A visible woven mat lies on the ground outside the doorway.
    for (let row = 0; row < 8; row++) {
      const left = x - 10 - Math.floor(row / 3), width = 21 + Math.floor(row / 3) * 2;
      rect(ctx, row === 0 || row === 7 ? "#645330" : "#bba56c", left, y - 5 + row, width, 1);
      if (row > 0 && row < 7) for (let col = 2; col < width - 2; col += 3) {
        rect(ctx, row % 2 ? "#8a824a" : "#d6c087", left + col + row % 2, y - 5 + row, 1, 1);
      }
    }
    for (let i = -10; i <= 10; i += 3) rect(ctx, "#caba7c", x + i, y + 3, 1, 2);
  }
  if (items.includes("keepsakes")) {
    const { x, y } = HOME_DECOR.keepsakes;
    rect(ctx, "#24332677", x - 11, y, 24, 3);
    rect(ctx, "#4b3827", x - 11, y - 12, 23, 13);
    rect(ctx, "#7c5839", x - 10, y - 11, 21, 10);
    rect(ctx, "#3b3827", x - 8, y - 10, 17, 5);
    rect(ctx, "#a6804e", x - 7, y - 15, 5, 8);
    rect(ctx, "#d0b174", x - 6, y - 14, 2, 2);
    rect(ctx, "#638c86", x + 1, y - 14, 6, 7);
    rect(ctx, "#b0d1b5", x + 2, y - 15, 3, 3);
    rect(ctx, "#d7cb9a", x - 1, y - 11, 4, 4);
    for (let row = 0; row < 3; row++) {
      rect(ctx, row % 2 ? "#a07a4d" : "#b58a56", x - 10, y - 7 + row * 3, 21, 2);
      rect(ctx, "#755230", x - 3 + row * 2, y - 6 + row * 3, 7, 1);
    }
    for (const side of [-9, 8]) { rect(ctx, "#694d32", x + side, y - 10, 2, 11); rect(ctx, "#d1bb7e", x + side, y - 6, 1, 1); }
  }
  if (items.includes("leaf_garland")) {
    const { left, right, sag } = HOME_DECOR.garland;
    for (let i = 0; i < 8; i++) {
      const p = i / 7, x = left.x + (right.x - left.x) * p;
      const y = left.y + (right.y - left.y) * p + Math.sin(p * Math.PI) * sag;
      rect(ctx, "#6c7141", x, y, 4, 1);
      rect(ctx, i % 2 ? "#adb861" : "#7f9950", x, y + 1, 3, 2);
      rect(ctx, i % 2 ? "#8f9e4a" : "#637e41", x + 1, y + 3, 2, 1);
      rect(ctx, "#d9d68b", x + 1, y + 2, 1, 1);
    }
    if (lighting) drawGarlandLights(ctx, t);
  }
}

/** Light is composited after the night shade; only tiny bulbs illuminate the leaves. */
export function drawGarlandLights(ctx: CanvasRenderingContext2D, t = 0, dusk = 0) {
  const { left, right, sag } = HOME_DECOR.garland;
  for (let i = 0; i < 8; i++) {
    const p = i / 7, x = left.x + (right.x - left.x) * p + 1.5;
    const y = left.y + (right.y - left.y) * p + Math.sin(p * Math.PI) * sag + 3;
    const pulse = .78 + Math.sin(t * .9 + i * .8) * .12;
    const color = ["#fff0b0", "#c6e9b0", "#f0bca1"][i % 3];
    ctx.save();
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 4.5);
    glow.addColorStop(0, `${color}a0`); glow.addColorStop(.35, `${color}44`); glow.addColorStop(1, `${color}00`);
    ctx.globalAlpha *= pulse * (.55 + dusk * .4); ctx.fillStyle = glow; ctx.fillRect(x - 5, y - 5, 10, 10);
    ctx.globalAlpha = pulse; ctx.fillStyle = color; ctx.fillRect(Math.round(x - .5), Math.round(y), 1.4, 1.4);
    ctx.fillStyle = "#fff9db"; ctx.fillRect(Math.round(x), Math.round(y), .65, .65);
    ctx.restore();
  }
}

export function drawDecor(ctx: CanvasRenderingContext2D, state: HabitatState, reducedMotion: boolean, hidden: readonly string[] = []) {
  const t = reducedMotion ? 0 : state.elapsed;
  ctx.save(); ctx.globalAlpha = reducedMotion ? 1 : .35 + state.decorReveal * .65;
  drawOwnedDecor(ctx, state.decorItems.filter(item => !hidden.includes(item)), t, false);
  ctx.restore();
  if (state.leafDelivered) { const at = depositedPosition("leaf"); prop(ctx, "leaf", at.x * 256, at.y * 256); }
  if (state.keepsake) { const at = depositedPosition(state.keepsake); prop(ctx, state.keepsake, at.x * 256, at.y * 256); }
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
  const count = Math.min(reducedMotion ? 40 : 150, Math.ceil((reducedMotion ? 10 : 38) * field.width * field.height / 65536));
  for (let i = 0; i < count; i++) {
    const y = field.y + (i * 61 + time * 118) % (field.height + 14) - 7;
    const x = field.x + ((i * 47 - time * 20) % field.width + field.width) % field.width;
    // The existing doorway is a real dry recess, including the bottom of each drop.
    if (pointInPolygon({ x, y }, HOUSE_ANCHORS.doorway)
      || pointInPolygon({ x: x - 1, y: y + 6 }, HOUSE_ANCHORS.doorway)) continue;
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
