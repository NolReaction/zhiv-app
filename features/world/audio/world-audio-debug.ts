import type { AudioFrame } from "@/features/audio/domain/types";
import type { FixedWorldScene } from "@/features/world/tiled/types";

/** Visual diagnostic only; safe to paint any number of times. */
export function drawWorldAudioDebug(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, frame: AudioFrame | null) {
  if (!frame) return;
  ctx.save(); ctx.lineWidth = 1.4; ctx.font = "12px sans-serif";
  for (const source of scene.audio?.emitters ?? []) {
    const current = frame.sources?.find(item => item.id === source.id);
    ctx.strokeStyle = (current?.gain ?? 0) > .001 ? "#98f0ca" : "#baa5a1";
    for (const radius of [source.innerRadius, source.outerRadius]) {
      ctx.beginPath(); ctx.arc(source.position.x, source.position.y, radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = "#112a21"; ctx.fillRect(source.position.x - 3, source.position.y - 3, 6, 6);
    ctx.fillStyle = "#eaffef"; ctx.fillText(`${source.id} · ${current?.reason ?? "inactive"}`, source.position.x + 7, source.position.y - 7);
  }
  for (const zone of scene.audio?.zones ?? []) {
    ctx.strokeStyle = "#97c8ff"; ctx.beginPath();
    zone.points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath(); ctx.stroke();
  }
  const listener = frame.listener.position;
  ctx.strokeStyle = "#ffee8e"; ctx.beginPath(); ctx.arc(listener.x, listener.y, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#ffee8e"; ctx.fillText("Слушатель", listener.x + 14, listener.y - 5); ctx.restore();
}
