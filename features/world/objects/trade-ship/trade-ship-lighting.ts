import { applyTradeShipSpriteTransform, TRADE_SHIP_SPRITE, tradeShipSpritePose, type TradeShipSpriteFrame } from "./trade-ship-sprite";

/** Native PNG glass. Individual panes keep the original wooden/gold mullions visible. */
export const TRADE_SHIP_LIGHT_RIG = {
  panes: [
    [[188, 429], [205, 432], [205, 450], [188, 447]],
    [[216, 433], [234, 436], [234, 455], [216, 452]],
    [[188, 460], [205, 463], [205, 481], [188, 478]],
    [[216, 464], [234, 467], [234, 484], [216, 482]],
    [[312, 452], [333, 455], [333, 474], [312, 471]],
    [[345, 457], [368, 461], [368, 480], [345, 477]],
    [[312, 485], [333, 488], [333, 502], [312, 499]],
    [[345, 490], [368, 493], [368, 508], [345, 504]],
    [[581, 488], [590, 487], [590, 504], [582, 504]],
    [[597, 487], [605, 487], [605, 501], [597, 504]],
    [[1303, 327], [1309, 329], [1309, 337], [1305, 336]],
    [[1331, 328], [1336, 325], [1335, 334], [1331, 337]],
  ],
  lamps: [{ x: 594, y: 495, radius: 46 }, { x: 1320, y: 332, radius: 32 }],
  deck: [[707, 357], [1070, 382], [1522, 472], [1602, 544], [1418, 646], [763, 611], [612, 573], [707, 512]],
  deckPools: [{ x: 655, y: 563, radius: 112 }, { x: 1320, y: 445, radius: 145 }],
  reflections: [{ x: 620, y: 775 }, { x: 1320, y: 825 }],
} as const;

export type TradeShipLightingFrame = TradeShipSpriteFrame & { enabled?: boolean };
const TAU = Math.PI * 2;
function polygon(ctx: CanvasRenderingContext2D, points: readonly (readonly [number, number])[]) {
  ctx.beginPath(); ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.closePath();
}

/** Emissive pass: call after the scene's common night shading, with the same placement/time as its PNG. */
export function drawTradeShipLighting(ctx: CanvasRenderingContext2D, frame: TradeShipLightingFrame) {
  const pose = tradeShipSpritePose(frame);
  if (!pose || !pose.night || frame.enabled === false) return;
  const { time, night } = pose, rig = TRADE_SHIP_LIGHT_RIG;
  const strength = night * night * (3 - 2 * night);
  const pulse = frame.still ? 1 : 1 + .018 * Math.sin(time * 3.1 + .7) + .009 * Math.sin(time * 5.7 + 2.4);
  const sprite = TRADE_SHIP_SPRITE, ratio = sprite.image.width / sprite.sourceWidth;
  ctx.save();
  try {
    applyTradeShipSpriteTransform(ctx, frame, false);
    ctx.translate(sprite.image.x, sprite.image.y); ctx.scale(ratio, ratio);
    ctx.filter = "none"; ctx.globalCompositeOperation = "screen";
    // Broken, tightly bounded surface reflections. They stay on the water while the PNG bobs.
    ctx.lineCap = "round";
    for (const [index, reflection] of rig.reflections.entries()) {
      for (let i = 0; i < 7; i++) {
        const phase = frame.still ? 0 : Math.sin(time * 1.1 + i * 2.399 + index);
        const width = (26 - i * 2.3) * (1 + phase * .12), y = reflection.y + i * 5;
        ctx.globalAlpha = strength * (.13 - i * .014) * pulse;
        ctx.strokeStyle = "#e7b570"; ctx.lineWidth = 2.8 - i * .2;
        ctx.beginPath(); ctx.moveTo(reflection.x - width / 2 + phase * 2, y);
        ctx.lineTo(reflection.x + width / 2 + phase * 2, y); ctx.stroke();
      }
    }
    ctx.translate(0, pose.bob / ratio);
    // Warm deck illumination is clipped to authored floor, preserving its painted texture.
    ctx.save();
    try {
      polygon(ctx, rig.deck); ctx.clip();
      for (const pool of rig.deckPools) {
        const glow = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, pool.radius);
        glow.addColorStop(0, "rgba(255,189,91,.21)"); glow.addColorStop(.45, "rgba(255,175,71,.09)");
        glow.addColorStop(1, "rgba(255,175,71,0)");
        ctx.globalAlpha = strength * pulse; ctx.fillStyle = glow;
        ctx.fillRect(pool.x - pool.radius, pool.y - pool.radius, pool.radius * 2, pool.radius * 2);
      }
    } finally { ctx.restore(); }
    for (const lamp of rig.lamps) {
      const glow = ctx.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, lamp.radius);
      glow.addColorStop(0, "rgba(255,202,119,.35)"); glow.addColorStop(.3, "rgba(255,186,81,.12)");
      glow.addColorStop(1, "rgba(255,186,81,0)");
      ctx.globalAlpha = strength * pulse; ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(lamp.x, lamp.y, lamp.radius, 0, TAU); ctx.fill();
    }
    // Screen keeps native glass shading; the frame and mullions are never filled.
    ctx.globalAlpha = strength * pulse; ctx.fillStyle = "rgba(255,210,126,.69)";
    for (const pane of rig.panes) { polygon(ctx, pane); ctx.fill(); }
  } finally { ctx.restore(); }
}
