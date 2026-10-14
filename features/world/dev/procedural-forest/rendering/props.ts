function polygon(ctx: CanvasRenderingContext2D, points: number[][], color: string) {
  ctx.fillStyle = color; ctx.beginPath();
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath(); ctx.fill();
}

export function drawRock(ctx: CanvasRenderingContext2D, variant: number) {
  const stretch = .8 + (variant % 5) * .09;
  ctx.save(); ctx.scale(stretch, stretch);
  polygon(ctx, [[-26, 0], [-24, -15], [-12, -27], [8, -30], [24, -15], [28, 1], [10, 7], [-14, 5]], "#34463c");
  polygon(ctx, [[-24, -15], [-12, -27], [8, -30], [16, -20], [-1, -9]], "#8b9980");
  polygon(ctx, [[-24, -15], [-1, -9], [-3, 3], [-26, 0]], "#637763");
  polygon(ctx, [[-1, -9], [16, -20], [24, -15], [28, 1], [10, 7], [-3, 3]], "#4a6153");
  polygon(ctx, [[-20, -16], [-12, -25], [7, -27], [5, -24], [-11, -20]], "#adba91");
  ctx.strokeStyle = "#34493d"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(13, -16); ctx.lineTo(8, -10); ctx.lineTo(10, -3); ctx.stroke();
  for (let i = 0; i < 15; i++) {
    const x = Math.sin(i * 73 + variant) * 15, y = -13 + Math.cos(i * 51) * 6;
    ctx.fillStyle = i % 3 ? "#74865a" : "#9ba36c";
    ctx.fillRect(x, y, 2.5, 1.3);
  }
  ctx.restore();
}

function block(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, depth = 10) {
  polygon(ctx, [[x, y], [x + w, y], [x + w, y - h], [x, y - h]], "#596657");
  polygon(ctx, [[x + w, y], [x + w + depth, y - depth * .5], [x + w + depth, y - h - depth * .5], [x + w, y - h]], "#3c5047");
  polygon(ctx, [[x, y - h], [x + depth, y - h - depth * .5], [x + w + depth, y - h - depth * .5], [x + w, y - h]], "#a2aa87");
  ctx.strokeStyle = "#b1b38b"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 2, y - h + 2); ctx.lineTo(x + w - 2, y - h + 2); ctx.stroke();
  ctx.fillStyle = "#6d7e45"; ctx.fillRect(x + 2, y - h + 3, w * .36, 3);
}

export function drawRuins(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = "#193a2c55"; ctx.beginPath(); ctx.ellipse(23, 20, 98, 35, -.1, 0, Math.PI * 2); ctx.fill();
  // Broken stone steps, two masonry piers and a half-fallen lintel.
  for (let row = 0; row < 3; row++) for (let i = 0; i < 5; i++) block(ctx, -67 + i * 26 - row * 2, 34 - row * 12, 24, 6, 13);
  for (let row = 0; row < 4; row++) {
    block(ctx, -64 + row % 2 * 2, 1 - row * 19, 28, 17);
    block(ctx, 33 - row % 2 * 2, 1 - row * 19, 30, 17);
  }
  block(ctx, -68, -77, 38, 13, 14); block(ctx, 28, -77, 39, 14, 14);
  block(ctx, -29, -77, 24, 12, 14);
  ctx.save(); ctx.translate(8, 11); ctx.rotate(-.32); block(ctx, 0, 0, 37, 17); ctx.restore();
  ctx.strokeStyle = "#294e31"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-52, -88); ctx.bezierCurveTo(-68, -60, -37, -42, -52, 5); ctx.stroke();
  for (let i = 0; i < 14; i++) { ctx.fillStyle = i % 2 ? "#6b893d" : "#456c36"; ctx.beginPath(); ctx.ellipse(-55 + Math.sin(i * 3) * 8, -81 + i * 6, 5, 2.5, i, 0, 7); ctx.fill(); }
  ctx.restore();
}

export function drawJetty(ctx: CanvasRenderingContext2D) {
  ctx.save(); ctx.rotate(.36);
  ctx.fillStyle = "#103c3f55"; ctx.fillRect(4, 13, 131, 59);
  for (const x of [0, 110]) for (const y of [0, 44]) {
    ctx.fillStyle = "#3f3324"; ctx.fillRect(x, y - 8, 8, 32);
    ctx.fillStyle = "#b7a474"; ctx.beginPath(); ctx.ellipse(x + 4, y - 8, 4, 2, 0, 0, 7); ctx.fill();
  }
  ctx.fillStyle = "#493d2c"; ctx.fillRect(-7, -3, 132, 50);
  for (let i = 0; i < 13; i++) {
    ctx.fillStyle = ["#9c8256", "#ad9567", "#8c7853"][i % 3]; ctx.fillRect(-5 + i * 10, -6 + (i % 4 === 0 ? 1 : 0), 9, 47);
    ctx.strokeStyle = "#665738"; ctx.lineWidth = .6; ctx.beginPath(); ctx.moveTo(-2 + i * 10, -2); ctx.bezierCurveTo(i * 10 + 2, 13, i * 10 - 3, 17, i * 10 + 1, 38); ctx.stroke();
    ctx.fillStyle = "#443f2d"; ctx.fillRect(i * 10, 0, 1.5, 1.5); ctx.fillRect(i * 10, 33, 1.5, 1.5);
  }
  ctx.restore();
}

export function drawBridge(ctx: CanvasRenderingContext2D) {
  ctx.save(); ctx.rotate(.22);
  ctx.fillStyle = "#132d2970"; ctx.fillRect(-61, 0, 137, 54);
  ctx.fillStyle = "#3d3325"; ctx.fillRect(-64, -16, 132, 44);
  for (let i = 0; i < 15; i++) {
    const x = -64 + i * 9;
    ctx.fillStyle = i % 3 === 0 ? "#988455" : "#b09a67"; ctx.fillRect(x, -20, 8, 44);
    ctx.strokeStyle = "#736345"; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(x + 3, -16); ctx.quadraticCurveTo(x + 6, 6, x + 3, 21); ctx.stroke();
  }
  for (const y of [-19, 24]) {
    for (const x of [-62, 0, 65]) { ctx.fillStyle = "#57472f"; ctx.fillRect(x - 2, y - 23, 5, 27); ctx.fillStyle = "#d0b57b"; ctx.fillRect(x - 2, y - 24, 5, 3); }
    ctx.strokeStyle = "#86714b"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-62, y - 19); ctx.quadraticCurveTo(0, y - 13, 66, y - 19); ctx.stroke();
  }
  ctx.restore();
}
