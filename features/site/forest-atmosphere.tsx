"use client";

import { useEffect, useRef } from "react";
import { atmosphereBudget, forestParticleFrame, forestParticles } from "./forest-atmosphere-model";
import styles from "./forest-atmosphere.module.css";

export function ForestAtmosphere({ className = "", night = false, enabled = true }: { className?: string; night?: boolean; enabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const surface = canvas.current;
    if (!surface || !enabled || typeof window.matchMedia !== "function") return;
    const element = surface;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;
    const ctx = element.getContext("2d", { alpha: true });
    if (!ctx) return;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    // Cache one small glow instead of allocating gradients for every particle.
    const glow = document.createElement("canvas");
    glow.width = glow.height = 64;
    const light = glow.getContext("2d");
    if (!light) return;
    const gradient = light.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,250,202,1)");
    gradient.addColorStop(.08, "rgba(240,223,140,.9)");
    gradient.addColorStop(.25, "rgba(221,207,115,.22)");
    gradient.addColorStop(1, "rgba(221,207,115,0)");
    light.fillStyle = gradient; light.fillRect(0, 0, 64, 64);

    let width = 1, height = 1, budget = atmosphereBudget(1, 1, 1, coarse);
    let visible = true, stopped = false, frame = 0, previous = -1, elapsed = 0;
    let pointerX = 0, pointerY = 0;
    const particles = forestParticles(coarse ? 18 : 30);
    const clear = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, element.width, element.height); ctx.restore(); };
    const canRun = () => !stopped && visible && !document.hidden && !reduced.matches;
    function draw(now: number) {
      frame = 0;
      if (!canRun()) return;
      if (previous < 0 || now - previous >= budget.interval) {
        elapsed += previous >= 0 ? Math.min(100, now - previous) : 0;
        previous = now;
        clear();
        for (const particle of particles) {
          const point = forestParticleFrame(particle, elapsed / 1000, pointerX, pointerY);
          ctx!.globalAlpha = point.opacity * (night ? 1 : .8);
          ctx!.drawImage(glow, point.x * width - point.size / 2, point.y * height - point.size / 2, point.size, point.size);
        }
        ctx!.globalAlpha = 1;
      }
      frame = window.requestAnimationFrame(draw);
    }
    function reconcile() {
      if (stopped) return;
      if (canRun()) { if (!frame) { previous = -1; frame = window.requestAnimationFrame(draw); } }
      else { window.cancelAnimationFrame(frame); frame = 0; previous = -1; }
      if (reduced.matches) clear();
    }
    function resize() {
      if (stopped) return;
      const rect = element.getBoundingClientRect();
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      budget = atmosphereBudget(width, height, window.devicePixelRatio, coarse);
      element.width = Math.max(1, Math.floor(width * budget.ratio));
      element.height = Math.max(1, Math.floor(height * budget.ratio));
      ctx!.setTransform(budget.ratio, 0, 0, budget.ratio, 0, 0);
      visible = rect.bottom > 0 && rect.top < window.innerHeight;
      reconcile();
    }
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting); reconcile();
    });
    const host = element.parentElement;
    function pointer(event: PointerEvent) {
      pointerX = Math.max(-1, Math.min(1, event.clientX / Math.max(1, window.innerWidth) * 2 - 1));
      pointerY = Math.max(-1, Math.min(1, event.clientY / Math.max(1, window.innerHeight) * 2 - 1));
    }
    const resetPointer = () => { pointerX = pointerY = 0; };
    resizeObserver?.observe(element); intersectionObserver?.observe(element);
    if (!resizeObserver) window.addEventListener("resize", resize, { passive: true });
    if (!intersectionObserver) window.addEventListener("scroll", resize, { passive: true });
    if (!coarse) { host?.addEventListener("pointermove", pointer, { passive: true }); host?.addEventListener("pointerleave", resetPointer); }
    document.addEventListener("visibilitychange", reconcile);
    if (reduced.addEventListener) reduced.addEventListener("change", reconcile);
    else reduced.addListener(reconcile);
    resize();
    return () => {
      stopped = true; window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect(); intersectionObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize);
      host?.removeEventListener("pointermove", pointer); host?.removeEventListener("pointerleave", resetPointer);
      document.removeEventListener("visibilitychange", reconcile);
      if (reduced.removeEventListener) reduced.removeEventListener("change", reconcile);
      else reduced.removeListener(reconcile);
      clear();
    };
  }, [enabled, night]);
  return <canvas ref={canvas} className={`${styles.canvas} ${className}`} aria-hidden="true" />;
}
