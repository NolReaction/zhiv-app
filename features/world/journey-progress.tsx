"use client";
import { useEffect, useRef } from "react";
import { House, Trees, Waves } from "lucide-react";
import type { WorldState } from "./model";
import styles from "./journey-progress.module.css";

type Journey = WorldState["journeys"][number];
export function journeyFraction(journey: Journey, now: number) {
  const start = Date.parse(journey.startedAt), end = Date.parse(journey.finishesAt);
  return Math.max(0, Math.min(1, (now - start) / Math.max(1, end - start)));
}
export function journeyLeg(journey: Journey, now: number) {
  const progress = journeyFraction(journey, now);
  return { progress, returning: progress >= .5, position: progress < .5 ? progress * 2 : (1 - progress) * 2 };
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
      const { progress, returning, position } = journeyLeg(value.journey, value.now + time - value.received);
      ctx.clearRect(0, 0, 200, 42); ctx.imageSmoothingEnabled = false;
      ctx.setLineDash([2, 5]); ctx.lineWidth = 2; ctx.strokeStyle = "#92a57b66";
      ctx.beginPath(); ctx.moveTo(14, 32); ctx.lineTo(182, 32); ctx.stroke();
      ctx.strokeStyle = "#d0dfa4"; ctx.beginPath(); ctx.moveTo(returning ? 182 : 14, 32); ctx.lineTo(14 + position * 168, 32); ctx.stroke();
      if (sprite) ctx.drawImage(sprite(progress < 1 ? "walk" : "greet", progress < 1 ? returning ? "left" : "right" : "front", media.matches ? 0 : Math.floor(time / 150) % 4, value.equipment), 2 + position * 160, 2, 32, 32);
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
  const { progress: fraction, returning } = journeyLeg(journey, now);
  const river = journey.routeId === "brook_path", Destination = river ? Waves : Trees;
  return <span className={styles.route} role="progressbar" aria-label={river ? "Путешествие к ручью и обратно" : "Прогулка по тропе и обратно"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-valuetext={fraction === 1 ? "Мохлик вернулся с находками" : `${returning ? "Возвращается домой" : river ? "Идёт к ручью" : "Идёт по лесной тропе"}. Пройдено ${Math.round(fraction * 100)}% пути`}>
    <House size={20} aria-hidden /><canvas ref={canvas} width={200} height={42} aria-hidden /><Destination size={20} aria-hidden />
  </span>;
}
