"use client";
import { useEffect, useRef } from "react";
import { House, Trees } from "lucide-react";
import type { WorldState } from "./model";
import styles from "./journey-progress.module.css";

type Journey = WorldState["journeys"][number];
export function journeyFraction(journey: Journey, now: number) {
  const start = Date.parse(journey.startedAt), end = Date.parse(journey.finishesAt);
  return Math.max(0, Math.min(1, (now - start) / Math.max(1, end - start)));
}
export function JourneyProgress({ journey, equipment, now, paused = false }: { journey: Journey; equipment: WorldState["equipment"]; now: number; paused?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef({ journey, equipment, now, received: 0, paused });
  useEffect(() => { source.current = { journey, equipment, now, received: performance.now(), paused }; }, [journey, equipment, now, paused]);
  useEffect(() => {
    let disposed = false, frame = 0, last = 0;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let sprite: typeof import("@/lib/mochlik/pixel-sprite").pixelSprite | undefined;
    function draw(time: number) {
      const ctx = canvas.current?.getContext("2d"); if (!ctx) return;
      const value = source.current;
      const progress = journeyFraction(value.journey, value.now + time - value.received);
      ctx.clearRect(0, 0, 200, 42); ctx.imageSmoothingEnabled = false;
      ctx.setLineDash([2, 5]); ctx.lineWidth = 2; ctx.strokeStyle = "#92a57b66";
      ctx.beginPath(); ctx.moveTo(14, 32); ctx.lineTo(182, 32); ctx.stroke();
      ctx.strokeStyle = "#d0dfa4"; ctx.beginPath(); ctx.moveTo(14, 32); ctx.lineTo(14 + progress * 168, 32); ctx.stroke();
      if (sprite) ctx.drawImage(sprite(progress < 1 ? "walk" : "greet", progress < 1 ? "right" : "front", media.matches ? 0 : Math.floor(time / 150) % 4, value.equipment), 2 + progress * 160, 2, 32, 32);
    }
    function tick(time: number) {
      frame = 0;
      if (disposed || document.hidden || source.current.paused) return;
      if (time - last >= 1000 / 12) { draw(time); last = time; }
      if (!media.matches) frame = requestAnimationFrame(tick);
    }
    function resume() { cancelAnimationFrame(frame); frame = 0; if (!disposed && !document.hidden && !source.current.paused) { draw(performance.now()); if (!media.matches) frame = requestAnimationFrame(tick); } }
    void import("@/lib/mochlik/pixel-sprite").then(module => { if (!disposed) { sprite = module.pixelSprite; resume(); } });
    // Refresh reduced-motion progress and resume after the circle becomes visible again.
    const timer = setInterval(() => { if (media.matches || !frame) resume(); }, 1000);
    document.addEventListener("visibilitychange", resume); media.addEventListener("change", resume);
    return () => { disposed = true; cancelAnimationFrame(frame); clearInterval(timer); document.removeEventListener("visibilitychange", resume); media.removeEventListener("change", resume); };
  }, []);
  const fraction = journeyFraction(journey, now);
  return <span className={styles.route} role="progressbar" aria-label="Путешествие Мохлика к дому" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-valuetext={fraction === 1 ? "Мохлик вернулся с находками" : `Пройдено ${Math.round(fraction * 100)}% пути`}>
    <Trees size={17} aria-hidden /><canvas ref={canvas} width={200} height={42} aria-hidden /><House size={20} aria-hidden />
  </span>;
}
