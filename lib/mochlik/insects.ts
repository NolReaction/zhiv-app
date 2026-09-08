import type { HabitatState } from "./habitat";

/** Small animated visitors on the same logical pixel grid as the existing rig. */
export function drawInsects(ctx: CanvasRenderingContext2D, state: HabitatState, dusk: number, reducedMotion: boolean) {
  const time = reducedMotion ? 0 : state.elapsed;
  const perching = state.playing && state.activity === "balance";
  const anchors = [[.35, .59], [.68, .58], [.47, .77], [.55, .40], [.30, .69], [.70, .70], [.41, .44]];
  const colors = [["#edb259", "#ffe9aa"], ["#bd9be2", "#ecd6ff"], ["#eed88e", "#fff0c8"], ["#e2a3a7", "#ffe3c4"]];
  ctx.save();
  for (let i = 0; i < 8; i++) {
    const anchor = anchors[(i + anchors.length - 1) % anchors.length];
    const px = i === 0 ? state.insectPosition.x : anchor[0] + Math.sin(time * .53 + i * 2.4) * .026;
    const py = i === 0 ? state.insectPosition.y : anchor[1] + Math.cos(time * .71 + i * 1.7) * .023;
    const angle = time * .75 + i * Math.PI / 4;
    const ringX = state.position.x + Math.cos(angle) * .12;
    const ringY = state.position.y - state.size * .63 + Math.sin(angle) * .06;
    const gathering = reducedMotion ? 0 : state.gathering * dusk;
    const x = Math.round((px + (ringX - px) * gathering) * 256), y = Math.round((py + (ringY - py) * gathering) * 256);
    if (i < 4 && dusk < .99) {
      ctx.globalAlpha = (1 - dusk) * (i === 0 ? 1 : .85) * (1 - state.rain * .75);
      const open = reducedMotion || i === 0 && perching || Math.sin(time * 15 + i * 2) > -.15;
      const span = open ? 3 : 1;
      const [wing, highlight] = colors[i];
      ctx.fillStyle = "#51473b";
      ctx.fillRect(x - span - 1, y - 3, span + 1, 4); ctx.fillRect(x + 1, y - 3, span + 1, 4);
      ctx.fillStyle = wing;
      ctx.fillRect(x - span, y - 3, span, 3); ctx.fillRect(x + 1, y - 3, span, 3);
      ctx.fillRect(x - span, y + 1, span, 2); ctx.fillRect(x + 1, y + 1, span, 2);
      ctx.fillStyle = highlight; ctx.fillRect(x - span, y - 2, 1, 1); ctx.fillRect(x + span, y - 2, 1, 1);
      ctx.fillStyle = "#443e30"; ctx.fillRect(x, y - 2, 1, 5);
    }
    if (dusk > .01) {
      const glow = reducedMotion ? .7 : .58 + .42 * Math.sin(time * 2.2 + i * 1.8) ** 2;
      ctx.globalAlpha = dusk * glow;
      ctx.fillStyle = "#d9ed6920"; ctx.fillRect(x - 4, y - 3, 9, 7); ctx.fillRect(x - 3, y - 4, 7, 9);
      ctx.fillStyle = "#e5ed7355"; ctx.fillRect(x - 2, y - 1, 5, 3); ctx.fillRect(x - 1, y - 2, 3, 5);
      ctx.fillStyle = "#effab7"; ctx.fillRect(x, y - 1, 1, 2);
      ctx.fillStyle = "#fffce0"; ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}
