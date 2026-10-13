import type { WaterDynamicsLeaf } from "./water-dynamics-leaves";

const palette = [
  { body: "#9baf57", fold: "#c2c675", edge: "#526d43", vein: "#d2d29a" },
  { body: "#bf9f53", fold: "#d3b873", edge: "#7b7547", vein: "#e0cca0" },
  { body: "#829c61", fold: "#acb57a", edge: "#4c694b", vein: "#c6caa0" },
] as const;

/** A leaf has a pointed blade, uneven lobes, curled side and a separate stem.
 * Shapes stay inside the physics footprint; projection compresses the world Y
 * axis before rotation so every orientation lies on the same water plane. */
function blade(ctx: CanvasRenderingContext2D, shape: number) {
  ctx.beginPath(); ctx.moveTo(-.72, .03);
  if (shape === 1) {
    ctx.bezierCurveTo(-.62, -.26, -.41, -.55, -.2, -.47);
    ctx.quadraticCurveTo(-.11, -.7, .13, -.51);
    ctx.quadraticCurveTo(.36, -.58, .45, -.29);
    ctx.quadraticCurveTo(.73, -.2, .98, -.08);
    ctx.quadraticCurveTo(.72, .06, .6, .29);
    ctx.quadraticCurveTo(.27, .22, .19, .49);
    ctx.quadraticCurveTo(-.01, .39, -.21, .48);
    ctx.bezierCurveTo(-.47, .42, -.53, .17, -.72, .03);
  } else if (shape === 2) {
    ctx.bezierCurveTo(-.62, -.4, -.16, -.62, .17, -.42);
    ctx.bezierCurveTo(.55, -.36, .64, -.19, .98, -.13);
    ctx.bezierCurveTo(.64, .06, .52, .25, .19, .32);
    ctx.bezierCurveTo(-.22, .54, -.58, .39, -.72, .03);
  } else {
    ctx.bezierCurveTo(-.54, -.33, -.15, -.46, .2, -.32);
    ctx.bezierCurveTo(.55, -.25, .76, -.15, .98, -.04);
    ctx.bezierCurveTo(.61, .12, .4, .33, .07, .38);
    ctx.bezierCurveTo(-.24, .41, -.51, .23, -.72, .03);
  }
  ctx.closePath();
}

/** Read only: bob and submersion come from the shared solver, never from paint time. */
export function drawForestWaterLeaf(ctx: CanvasRenderingContext2D, leaf: WaterDynamicsLeaf, dusk: number) {
  const shape = leaf.shape % palette.length, colour = palette[shape];
  const submersion = Math.max(0, Math.min(1, leaf.submersion));
  const opacity = leaf.opacity * (1 - dusk * .34), bodyY = leaf.y - leaf.bob + submersion * leaf.size * .25;
  ctx.save();
  ctx.translate(leaf.x + leaf.size * .06, leaf.y + leaf.size * .19);
  ctx.scale(leaf.size, leaf.size * .68); ctx.rotate(leaf.rotation);
  ctx.globalAlpha *= opacity * .19 * (1 - submersion * .6);
  ctx.fillStyle = "#204f4c"; blade(ctx, shape); ctx.fill(); ctx.restore();

  ctx.save(); ctx.translate(leaf.x, bodyY);
  ctx.scale(leaf.size * (1 - submersion * .09), leaf.size * (.7 - submersion * .09)); ctx.rotate(leaf.rotation);
  ctx.globalAlpha *= opacity * (1 - submersion * .68);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = colour.edge; ctx.lineWidth = .085;
  ctx.beginPath(); ctx.moveTo(-1.12, .18); ctx.quadraticCurveTo(-.91, .19, -.59, .01); ctx.stroke();
  blade(ctx, shape); ctx.fillStyle = colour.body; ctx.fill();
  ctx.lineWidth = .047; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-.64, .025);
  ctx.quadraticCurveTo(.09, -.12, .98, shape === 2 ? -.13 : -.04);
  ctx.quadraticCurveTo(.34, .33, .07, .38);
  ctx.quadraticCurveTo(-.3, .28, -.64, .025);
  ctx.fillStyle = colour.fold; ctx.fill();
  ctx.strokeStyle = colour.vein; ctx.lineWidth = .043;
  ctx.beginPath(); ctx.moveTo(-.69, .035); ctx.quadraticCurveTo(.07, -.08, .8, -.06);
  for (let i = 0; i < 3; i++) {
    const x = -.4 + i * .29, width = (shape === 1 ? .34 : .27) * (1 - i * .14);
    ctx.moveTo(x, 0); ctx.quadraticCurveTo(x + .03, -width * .54, x + .14, -width);
    ctx.moveTo(x + .045, 0); ctx.quadraticCurveTo(x + .13, width * .54, x + .22, width);
  }
  ctx.stroke(); ctx.restore();
}
