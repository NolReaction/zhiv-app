"use client";
import { useEffect, useRef } from "react";
import { Fish, House, Trees, Waves } from "lucide-react";
import type { WorldState } from "./model";
import { isFishingJourney, journeyTimeline, journeyPhaseLabel } from "./journey-timeline";
import styles from "./journey-progress.module.css";

type Journey = WorldState["journeys"][number];
export function journeyFraction(journey: Journey, now: number) {
  return journeyTimeline(journey, now).progress;
}
export function journeyLeg(journey: Journey, now: number) {
  const timeline = journeyTimeline(journey, now);
  return { progress: timeline.progress, returning: timeline.phase === "returning" || timeline.phase === "home", position: timeline.position };
}
export function JourneyProgress({ journey, equipment, now, paused = false }: { journey: Journey; equipment: WorldState["equipment"]; now: number; paused?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef({ journey, equipment, now, received: 0, paused });
  useEffect(() => { source.current = { journey, equipment, now, received: performance.now(), paused }; }, [journey, equipment, now, paused]);
  useEffect(() => {
    let disposed = false, frame = 0, last = 0;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let sprite: typeof import("@/features/mochlik/pixel-sprite").pixelSprite | undefined;
    function draw(time: number) {
      const ctx = canvas.current?.getContext("2d"); if (!ctx) return;
      const value = source.current;
      const clock = value.now + time - value.received;
      const { progress, returning, position } = journeyLeg(value.journey, clock);
      const fishing = isFishingJourney(value.journey) && journeyTimeline(value.journey, clock).phase === "fishing";
      ctx.clearRect(0, 0, 200, 42); ctx.imageSmoothingEnabled = false;
      ctx.setLineDash([2, 5]); ctx.lineWidth = 2; ctx.strokeStyle = "#92a57b66";
      ctx.beginPath(); ctx.moveTo(14, 32); ctx.lineTo(182, 32); ctx.stroke();
      ctx.strokeStyle = "#d0dfa4"; ctx.beginPath(); ctx.moveTo(returning ? 182 : 14, 32); ctx.lineTo(14 + position * 168, 32); ctx.stroke();
      if (sprite) ctx.drawImage(sprite(progress < 1 ? fishing ? "fish" : "walk" : "greet", progress < 1 ? returning ? "left" : "right" : "front", media.matches ? 0 : Math.floor(time / 150) % 4, value.equipment), 2 + position * 160, 2, 32, 32);
      if (fishing) {
        ctx.setLineDash([]); ctx.strokeStyle = "#d8c393"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(183, 23); ctx.lineTo(191, 9); ctx.stroke();
        ctx.strokeStyle = "#dae5cc88"; ctx.lineWidth = .7;
        ctx.beginPath(); ctx.moveTo(191, 9); ctx.lineTo(197, 34); ctx.stroke();
        ctx.fillStyle = "#cb8060"; ctx.fillRect(196, 32, 2, 3);
      }
    }
    function tick(time: number) {
      frame = 0;
      if (disposed || document.hidden || source.current.paused) return;
      if (time - last >= 1000 / 12) { draw(time); last = time; }
      if (!media.matches) frame = requestAnimationFrame(tick);
    }
    function resume() { cancelAnimationFrame(frame); frame = 0; if (!disposed && !document.hidden && !source.current.paused) { draw(performance.now()); if (!media.matches) frame = requestAnimationFrame(tick); } }
    void import("@/features/mochlik/pixel-sprite").then(module => { if (!disposed) { sprite = module.pixelSprite; resume(); } });
    // Refresh reduced-motion progress and resume after the circle becomes visible again.
    const timer = setInterval(() => { if (media.matches || !frame) resume(); }, 1000);
    document.addEventListener("visibilitychange", resume); media.addEventListener("change", resume);
    return () => { disposed = true; cancelAnimationFrame(frame); clearInterval(timer); document.removeEventListener("visibilitychange", resume); media.removeEventListener("change", resume); };
  }, []);
  const fraction = journeyFraction(journey, now);
  const fishing = isFishingJourney(journey), river = journey.routeId === "brook_path", Destination = fishing ? Fish : river ? Waves : Trees;
  return <span className={styles.route} role="progressbar" aria-label={fishing ? "Рыбалка с дорогой туда и обратно" : river ? "Путешествие к воде и обратно" : "Прогулка по тропе и обратно"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-valuetext={`${journeyPhaseLabel(journey, now)}. ${Math.round(fraction * 100)}% времени прогулки`}>
    <House size={20} aria-hidden /><canvas ref={canvas} width={200} height={42} aria-hidden /><Destination size={20} aria-hidden />
  </span>;
}
