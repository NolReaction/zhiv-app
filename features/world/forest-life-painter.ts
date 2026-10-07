import type { ForestLifeFrame, ForestLifeState } from "./forest-life";
import { drawForestButterfly, drawForestFirefly } from "./forest-wildlife";

/** Small warm caps with pale stems, distinct from the insect silhouettes. */
function drawMushroom(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, bite = 0) {
  const u = size / 9, remaining = Math.max(.15, 1 - bite * .8);
  const scale = u * remaining;
  const rect = (dx: number, dy: number, width: number, height: number) => ctx.fillRect(x + dx * scale, y + dy * scale, width * scale, height * scale);
  ctx.save();
  ctx.fillStyle = "#d9ce9e"; rect(-1, -4, 2, 4);
  ctx.fillStyle = "#89724d"; rect(1, -3, 1, 3);
  ctx.fillStyle = "#704b35"; rect(-4, -5, 8, 2);
  ctx.fillStyle = "#bd8350"; rect(-4, -6, 8, 1); rect(-3, -8, 6, 2);
  ctx.fillStyle = "#deb06a"; rect(-2, -8, 4, 1); rect(-3, -6, 2, 1);
  ctx.fillStyle = "#ead6a1"; rect(1, -7, 1, 1); rect(-2, -6, 1, 1);
  ctx.restore();
}

/** A small fallen leaf: warm outline, visible midrib and a short stem. */
function drawLeaf(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  const u = size / 11;
  ctx.fillStyle = "#5b5833";
  ctx.fillRect(-5 * u, -u, 9 * u, 3 * u); ctx.fillRect(-3 * u, -3 * u, 6 * u, 6 * u);
  ctx.fillRect(3 * u, 0, 3 * u, u);
  ctx.fillStyle = "#bca253"; ctx.fillRect(-4 * u, -u, 7 * u, 2 * u); ctx.fillRect(-2 * u, -2 * u, 4 * u, 4 * u);
  ctx.fillStyle = "#e0c97a"; ctx.fillRect(-3 * u, 0, 6 * u, u); ctx.fillRect(-u, -u, u, u);
  ctx.fillStyle = "#8e8544"; ctx.fillRect(-u, u, 2 * u, u);
  ctx.restore();
}

/** Tiled mushroom points remain exact; both cameras share their growth and pickup state. */
export function drawForestMushrooms(ctx: CanvasRenderingContext2D, life: ForestLifeState, size: number) {
  ctx.save(); ctx.imageSmoothingEnabled = false;
  for (const mushroom of life.mushrooms) {
    if (mushroom.growth <= .02) continue;
    const scale = .25 + mushroom.growth * .75;
    ctx.fillStyle = "rgba(27,46,25,.17)";
    ctx.beginPath(); ctx.ellipse(mushroom.x, mushroom.y, size * .085 * scale, size * .027 * scale, 0, 0, Math.PI * 2); ctx.fill();
    drawMushroom(ctx, mushroom.x, mushroom.y, size * .19 * scale);
  }
  if (life.leaf && !(life.routine?.kind === "leaf" && life.routine.picked)) {
    const leaf = life.leaf;
    ctx.fillStyle = "rgba(27,46,25,.16)";
    ctx.beginPath(); ctx.ellipse(leaf.x, leaf.y + size * .02, size * .09, size * .035, leaf.angle, 0, Math.PI * 2); ctx.fill();
    drawLeaf(ctx, leaf.x, leaf.y, size * .18, leaf.angle);
  }
  ctx.restore();
}
function drawPropArms(ctx: CanvasRenderingContext2D, frame: ForestLifeFrame, fingertips = false) {
  const unit = frame.unit;
  if (!unit || !frame.arms) return;
  ctx.save();
  for (const arm of frame.arms) {
    if (!fingertips) {
      for (const [color, width] of [["#d8bf83", 4], ["#f4e4ae", 2.5]] as const) {
        ctx.fillStyle = color;
        for (const [from, to] of [[arm.shoulder, arm.elbow], [arm.elbow, arm.hand]]) {
          const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / unit));
          for (let step = 0; step <= steps; step++) {
            const x = from.x + (to.x - from.x) * step / steps;
            const y = from.y + (to.y - from.y) * step / steps;
            ctx.fillRect(x - width * unit / 2, y - width * unit / 2, width * unit, width * unit);
          }
        }
      }
      ctx.fillStyle = "#d8bf83";
      ctx.fillRect(arm.hand.x - unit * 2, arm.hand.y - unit * 1.5, unit * 4, unit * 3);
      ctx.fillStyle = "#f4e4ae";
      ctx.fillRect(arm.hand.x - unit * 1.5, arm.hand.y - unit * 1.5, unit * 3, unit * 2);
    } else {
      // A tiny finger edge remains in front of the stem; the cap/leaf stays readable.
      ctx.fillStyle = "#f4e4ae";
      ctx.fillRect(arm.hand.x - unit, arm.hand.y + unit * .6, unit * 2, unit);
    }
  }
  ctx.restore();
}
export function drawForestLifePartner(ctx: CanvasRenderingContext2D, frame: ForestLifeFrame, elapsed: number) {
  drawPropArms(ctx, frame);
  if (frame.heldMushroom) {
    const food = frame.heldMushroom;
    drawMushroom(ctx, food.x, food.y + food.size * .38, food.size, food.bite);
  }
  if (frame.heldLeaf) {
    const leaf = frame.heldLeaf;
    drawLeaf(ctx, leaf.x, leaf.y, leaf.size, leaf.angle);
  }
  if (frame.heldMushroom || frame.heldLeaf) drawPropArms(ctx, frame, true);
  if (frame.insect) {
    if (frame.insect.kind === "butterfly") drawForestButterfly(ctx, frame.insect, elapsed);
    else drawForestFirefly(ctx, { ...frame.insect, resting: frame.stage === "perch" }, elapsed);
  }
}
