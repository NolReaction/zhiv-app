"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { EconomyView } from "@/features/economy/domain/model";
import { advanceTapOrbit, tapOrbitReading, type TapOrbitMemory } from "./tap-boost-orbit-model";
import styles from "./tap-boost-orbit.module.css";

type Props = {
  snapshot: EconomyView | null;
  now: number;
  ownerKey: string;
  /** Physical feedback only. This signal never predicts or grants a bonus. */
  tapSignal: number;
  active: boolean;
};

/** One bounded SVG, five embers and two reusable transient animation nodes. */
export function TapBoostOrbit({ snapshot, now, ownerKey, tapSignal, active }: Props) {
  const root = useRef<HTMLDivElement>(null), pulse = useRef<HTMLSpanElement>(null), notice = useRef<HTMLSpanElement>(null);
  const pulseAnimation = useRef<Animation | undefined>(undefined), noticeAnimation = useRef<Animation | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const environment = useRef({ visible: false, reduced: false, baseline: true });
  const previousTap = useRef({ ownerKey, tapSignal, playedAt: -Infinity });
  const pendingTapAt = useRef(-Infinity), previous = useRef<TapOrbitMemory | null>(null), previouslyActive = useRef(active);
  const reading = tapOrbitReading(snapshot, now, ownerKey);
  const power = Math.max(0, Math.min(1, reading.powerPercent / 20));
  const css = { "--orbit-power": power, "--orbit-width": `${1.15 + power * .95}`,
    "--orbit-tip-angle": `${reading.remainingRatio * 360}deg`,
  } as CSSProperties;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    environment.current.baseline = true;
    pendingTapAt.current = -Infinity;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let intersecting = true;
    const clearFeedback = () => {
      pulseAnimation.current?.cancel(); noticeAnimation.current?.cancel();
      clearTimeout(noticeTimer.current);
      if (notice.current) { notice.current.textContent = ""; notice.current.style.opacity = ""; }
    };
    const update = () => {
      const visible = active && !document.hidden && intersecting;
      if (environment.current.visible !== visible) environment.current.baseline = true;
      environment.current.visible = visible; environment.current.reduced = media.matches;
      element.dataset.running = String(visible && !media.matches);
      if (!visible) pendingTapAt.current = -Infinity;
      if (!visible || media.matches) clearFeedback();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      intersecting = entries[0]?.isIntersecting ?? false; update();
    }, { threshold: .05 });
    observer?.observe(element);
    document.addEventListener("visibilitychange", update); media.addEventListener("change", update); update();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); media.removeEventListener("change", update); clearFeedback(); };
  }, [active, ownerKey]);

  useEffect(() => {
    const before = previousTap.current, tick = performance.now();
    previousTap.current = { ownerKey, tapSignal, playedAt: before.playedAt };
    if (before.ownerKey !== ownerKey || tapSignal <= before.tapSignal || !active || !environment.current.visible) return;
    pendingTapAt.current = tick;
    if (environment.current.reduced || tick - before.playedAt < 120) return;
    previousTap.current.playedAt = tick;
    pulseAnimation.current?.cancel();
    pulseAnimation.current = pulse.current?.animate?.([
      { opacity: .65, transform: "scale(.985)" },
      { opacity: .32, transform: "scale(1.018)", offset: .35 },
      { opacity: 0, transform: "scale(1.065)" },
    ], { duration: 390, easing: "cubic-bezier(.2,.8,.25,1)" });
  }, [tapSignal, ownerKey, active]);

  useEffect(() => {
    const next = tapOrbitReading(snapshot, now, ownerKey), before = previous.current;
    const changed = before?.jobId !== next.jobId || before?.grantedAt !== next.grantedAt || before?.charge !== next.charge;
    const localInput = performance.now() - pendingTapAt.current < 15_000;
    const result = advanceTapOrbit(before, next, localInput);
    previous.current = result.memory;
    if (changed) pendingTapAt.current = -Infinity;
    const suppressed = environment.current.baseline || !previouslyActive.current;
    environment.current.baseline = false; previouslyActive.current = active;
    if (!result.event || !active || !environment.current.visible || suppressed || !notice.current) return;
    const event = result.event;
    notice.current.textContent = event.kind === "complete" ? `${event.targetName} · работа готова`
      : event.powerPercent === 20 ? "Максимальная мощность" : `Помощь производству +${event.powerPercent}%`;
    notice.current.dataset.feedback = event.kind;
    noticeAnimation.current?.cancel(); clearTimeout(noticeTimer.current);
    if (environment.current.reduced) notice.current.style.opacity = "1";
    else noticeAnimation.current = notice.current.animate?.([
      { opacity: 0, transform: "translate(-50%, 5px) scale(.96)" },
      { opacity: 1, transform: "translate(-50%, 0) scale(1)", offset: .14 },
      { opacity: 1, transform: "translate(-50%, 0) scale(1)", offset: .78 },
      { opacity: 0, transform: "translate(-50%, -4px) scale(1)" },
    ], { duration: 1800, easing: "ease-out" });
    noticeTimer.current = setTimeout(() => {
      if (notice.current) { notice.current.textContent = ""; notice.current.style.opacity = ""; }
    }, 1800);
  }, [snapshot, now, ownerKey, active]);

  return <div ref={root} className={styles.orbit} data-tap-boost-orbit data-running="false"
    data-boosting={reading.active || undefined} data-power={reading.powerPercent} style={css}>
    <div className={styles.visual} aria-hidden="true">
      <svg className={styles.ring} viewBox="0 0 120 120" focusable="false">
        <circle className={styles.rail} cx="60" cy="60" r="58" />
        <circle className={styles.halo} cx="60" cy="60" r="58" pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - reading.remainingRatio)} />
        <circle className={styles.arc} cx="60" cy="60" r="58" pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - reading.remainingRatio)} />
      </svg>
      <span className={styles.tip} />
      <span className={styles.embers}>{[0, 1, 2, 3, 4].map(index => <i key={index} style={{ "--ember": index } as CSSProperties} />)}</span>
      <span ref={pulse} className={styles.pulse} />
    </div>
    <span ref={notice} className={styles.notice} role="status" aria-live="polite" aria-atomic="true" />
  </div>;
}
