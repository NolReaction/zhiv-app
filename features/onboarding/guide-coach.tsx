"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Leaf, Minus, MousePointer2 } from "lucide-react";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { GuidePortrait } from "./guide-portrait";
import styles from "./guide-coach.module.css";

export type GuideCoachProps = {
  open: boolean;
  flow: "app" | "world";
  stepId: string;
  title: string;
  text: string;
  hint?: string;
  pose: PixelPose;
  target?: string;
  targetRoot?: RefObject<HTMLElement | null>;
  progress?: { current: number; total: number };
  compact?: boolean;
  welcome?: boolean;
  status?: string;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void };
  onPause: () => void;
  onSkip: () => void;
  onBack?: () => void;
};
type Bounds = { left: number; top: number; width: number; height: number };
type CoachLayout = { key: string; left: number; top: number; highlight: (Bounds & { borderRadius: string }) | null };
const overlapArea = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/** An ordinary region, deliberately inside the parent's DOM/focus scope.
 * Only the speech bubble receives pointer events; the real UI stays usable. */
export function GuideCoach(props: GuideCoachProps) {
  const { open, flow, stepId, target, targetRoot, compact, title, text, hint, pose, progress, welcome, status, primary, secondary, onPause, onSkip, onBack } = props;
  const headingId = useId(), textId = useId();
  const card = useRef<HTMLElement>(null), copy = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<CoachLayout | null>(null);
  const layoutKey = `${flow}:${stepId}:${target ?? ""}`;
  useEffect(() => {
    if (!open) return;
    const root = targetRoot?.current ?? document;
    let frame = 0, observedTarget: HTMLElement | null = null;
    let settleUntil = performance.now() + 400;
    const measure = () => {
      frame = 0;
      const bubble = card.current;
      if (!bubble) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const viewportLeft = viewport?.offsetLeft ?? 0, viewportTop = viewport?.offsetTop ?? 0;
      const element = target ? root.querySelector<HTMLElement>(target) : null;
      if (element !== observedTarget) {
        settleUntil = performance.now() + 400;
        if (observedTarget) resize.unobserve(observedTarget);
        if (element) resize.observe(element);
        observedTarget = element;
      }
      const rect = element?.getBoundingClientRect();
      const visible = rect && rect.width > 0 && rect.height > 0 && rect.bottom > viewportTop && rect.top < viewportTop + height
        && rect.right > viewportLeft && rect.left < viewportLeft + width;
      const highlight = visible ? {
        left: Math.max(viewportLeft + 3, rect.left - 5), top: Math.max(viewportTop + 3, rect.top - 5),
        width: Math.min(viewportLeft + width - 3, rect.right + 5) - Math.max(viewportLeft + 3, rect.left - 5),
        height: Math.min(viewportTop + height - 3, rect.bottom + 5) - Math.max(viewportTop + 3, rect.top - 5),
        borderRadius: element ? window.getComputedStyle(element).borderRadius : "15px",
      } : null;
      const bubbleRect = bubble.getBoundingClientRect();
      const left = viewportLeft + 12, right = Math.max(left, viewportLeft + width - bubbleRect.width - 16);
      const top = viewportTop + 12, bottom = Math.max(top, viewportTop + height - bubbleRect.height - 88);
      const candidates = [{ left: right, top: bottom }, { left: right, top }, { left, top: bottom }, { left, top }];
      if (highlight) {
        candidates.push({ left: right, top: highlight.top - bubbleRect.height - 14 },
          { left: right, top: highlight.top + highlight.height + 14 });
      }
      const preferred = candidates[0];
      const ordered = candidates.map(candidate => ({
        left: Math.max(left, Math.min(right, candidate.left)),
        top: Math.max(top, Math.min(bottom, candidate.top)),
      })).map(candidate => ({ ...candidate, score: (highlight ? overlapArea({ ...candidate, width: bubbleRect.width, height: bubbleRect.height }, highlight) * 100 : 0)
        + Math.abs(candidate.top - preferred.top) + Math.abs(candidate.left - preferred.left) * .5 }));
      ordered.sort((a, b) => a.score - b.score);
      const next: CoachLayout = { key: layoutKey, left: ordered[0].left, top: ordered[0].top, highlight };
      setLayout(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      // Opening panels can translate their targets without resizing them.
      // Follow that short entrance, then return to event-driven measurement.
      if (performance.now() < settleUntil) frame = requestAnimationFrame(measure);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    if (card.current) resize.observe(card.current);
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "aria-expanded", "data-state"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("transitionend", schedule, true);
    window.addEventListener("animationend", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("animationend", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, target, targetRoot, layoutKey, compact]);
  useEffect(() => {
    if (open) copy.current?.scrollTo({ top: 0 });
  }, [open, stepId]);
  if (!open) return null;
  const placement = layout?.key === layoutKey ? layout : null;
  const position: CSSProperties | undefined = placement ? { left: placement.left, top: placement.top, right: "auto", bottom: "auto" } : undefined;
  const current = progress ? Math.min(progress.total, Math.max(1, progress.current)) : 0;
  return <>
    {placement?.highlight && <div className={styles.spotlight} style={placement.highlight} data-guide-spotlight={flow} aria-hidden="true" />}
    <section ref={card} className={styles.coach} style={position} role="region" aria-labelledby={headingId} aria-describedby={textId}
      data-guide-coach={flow} data-guide-step={stepId} data-compact={Boolean(compact)} data-welcome={Boolean(welcome)}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onPause(); } }}>
      <header className={styles.header}>
        <div className={styles.signature}><Leaf size={14} aria-hidden="true" /><span>Мохлик рядом</span></div>
        {progress && <span className={styles.counter} aria-label={`Шаг ${current} из ${progress.total}`}>{current}<span>/{progress.total}</span></span>}
        <button type="button" className={styles.pause} onClick={onPause} title="Свернуть обучение, сохранив шаг"><Minus size={16} aria-hidden="true" /><span>Свернуть</span></button>
      </header>
      {progress && <div className={styles.progress} aria-hidden="true"><span style={{ width: `${progress.total > 0 ? current / progress.total * 100 : 0}%` }} /></div>}
      <div ref={copy} className={styles.copy}>
        <div className={styles.intro}>
          <div className={styles.character}><GuidePortrait pose={pose} stepId={stepId} className={styles.portrait} /></div>
          <h2 id={headingId} className={styles.title}>{title}</h2>
        </div>
        <p id={textId} className={styles.text}>{text}</p>
        {hint && <p className={styles.hint}><MousePointer2 size={15} aria-hidden="true" /><span>{hint}</span></p>}
        {status && <p className={styles.status} role="status">{status}</p>}
      </div>
      <footer className={styles.footer} data-simple={!onBack && Boolean(primary) !== Boolean(secondary)}>
        {(primary || secondary || onBack) && <div className={styles.actions}>
          {onBack && <button type="button" className={styles.back} onClick={onBack} aria-label="Предыдущая подсказка"><ArrowLeft size={18} aria-hidden="true" /></button>}
          {secondary && <button type="button" className={styles.secondary} onClick={secondary.onClick}>{secondary.label}</button>}
          {primary && <button type="button" className={styles.primary} onClick={primary.onClick} disabled={primary.disabled}>{primary.label}<ArrowRight size={17} aria-hidden="true" /></button>}
        </div>}
        <button type="button" className={styles.skip} onClick={onSkip}>{welcome ? "Пропустить" : "Пропустить обучение"}</button>
      </footer>
      <span className={styles.live} aria-live="polite" aria-atomic="true">{title}. {text}</span>
    </section>
  </>;
}
