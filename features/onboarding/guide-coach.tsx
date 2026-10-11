"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Minus, MousePointer2 } from "lucide-react";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { GuideCharacter } from "./guide-character";
import { measureGuideSpotlight } from "./guide-spotlight";
import styles from "./guide-coach.module.css";

export type GuideCoachProps = {
  open: boolean;
  flow: "app" | "world" | "section";
  stepId: string;
  title: string;
  text: string;
  summary?: string;
  hint?: string;
  pose: PixelPose;
  target?: string;
  targetRoot?: RefObject<HTMLElement | null>;
  progress?: { current: number; total: number };
  compact?: boolean;
  /** Reserve space inside a panel, keeping its focus scope and coordinate system. */
  inline?: boolean;
  welcome?: boolean;
  status?: string;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void };
  onPause: () => void;
  onSkip: () => void;
  onBack?: () => void;
  children?: ReactNode;
};
type Bounds = { left: number; top: number; width: number; height: number };
type CoachLayout = { key: string; left: number; top: number };
const overlapArea = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
function shortReply(text: string) {
  if (text.length <= 160) return text;
  const sentence = text.match(/^.{35,159}?[.!?](?:\s|$)/u)?.[0].trim();
  if (sentence) return sentence;
  const boundary = text.lastIndexOf(" ", 154);
  return `${text.slice(0, boundary > 100 ? boundary : 154).trimEnd()}…`;
}

/** An ordinary region, deliberately inside the parent's DOM/focus scope.
 * Only the speech bubble receives pointer events; the real UI stays usable. */
export function GuideCoach(props: GuideCoachProps) {
  const { open, flow, stepId, target, targetRoot, compact, inline, title, text, summary, hint, pose, progress, welcome, status, primary, secondary, onPause, onSkip, onBack, children } = props;
  const headingId = useId(), textId = useId(), detailsId = useId();
  const card = useRef<HTMLElement>(null), copy = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<CoachLayout | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const layoutKey = `${flow}:${stepId}:${target ?? ""}`;
  const replyKey = `${flow}:${stepId}`;
  const expanded = Boolean(welcome || expandedStep === replyKey);
  const reply = welcome ? text : summary ?? shortReply(text);
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
        if (observedTarget) {
          resize.unobserve(observedTarget);
          observedTarget.classList.remove(styles.spotlight);
        }
        if (element) resize.observe(element);
        observedTarget = element;
      }
      // Paint on the actual control: native scrolling, clipping and transforms
      // carry the ring with it even between animation frames. React may replace
      // className, so restore it idempotently when the mutation observer fires.
      if (element && !element.classList.contains(styles.spotlight)) element.classList.add(styles.spotlight);
      // Panel lessons reserve their own space. Viewport coordinates cannot be
      // applied inside a transformed dialog's fixed-position containing block.
      if (inline) return;
      const highlight = measureGuideSpotlight(element, { left: viewportLeft, top: viewportTop, width, height });
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
      const next: CoachLayout = { key: layoutKey, left: ordered[0].left, top: ordered[0].top };
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
      observedTarget?.classList.remove(styles.spotlight);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("animationend", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, target, targetRoot, layoutKey, compact, inline]);
  useEffect(() => {
    if (open) copy.current?.scrollTo({ top: 0 });
  }, [open, stepId]);
  if (!open) return null;
  const placement = !inline && layout?.key === layoutKey ? layout : null;
  const position: CSSProperties | undefined = placement ? { left: placement.left, top: placement.top, right: "auto", bottom: "auto" } : undefined;
  const current = progress ? Math.min(progress.total, Math.max(1, progress.current)) : 0;
  return <>
    <section ref={card} className={styles.coach} style={position} role="region" aria-labelledby={headingId} aria-describedby={textId}
      data-guide-coach={flow} data-guide-step={stepId} data-compact={Boolean(compact)} data-welcome={Boolean(welcome)} data-inline={Boolean(inline)} data-expanded={expanded}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onPause(); } }}>
      <div ref={copy} className={styles.copy}>
        <div className={styles.intro}>
          <GuideCharacter key={stepId} pose={pose} stepId={stepId} />
          <div className={styles.speech}>
            <header className={styles.header}>
              <h2 id={headingId} className={styles.title}>{title}</h2>
              <button type="button" className={styles.pause} data-guide-pause onClick={onPause} title="Свернуть обучение, сохранив шаг" aria-label="Свернуть обучение, сохранив шаг"><Minus size={18} aria-hidden="true" /></button>
            </header>
            <p id={textId} className={styles.text}>{reply}</p>
          </div>
        </div>
        {children}
        <div id={detailsId} className={styles.details} hidden={!expanded}>
          {reply !== text && <p className={styles.text}>{text}</p>}
          {hint && <p className={styles.hint}><MousePointer2 size={15} aria-hidden="true" /><span>{hint}</span></p>}
          {!welcome && <button type="button" className={styles.skip} onClick={onSkip}>{flow === "section" ? "Пропустить знакомство" : "Пропустить обучение"}</button>}
        </div>
        {status && <p className={styles.status} role="status">{status}</p>}
      </div>
      <footer className={styles.footer}>
        {!welcome && <div className={styles.tools}>
          {progress && <span className={styles.counter} aria-label={`Шаг ${current} из ${progress.total}`}>{current}<span>/{progress.total}</span><span className={styles.progress} aria-hidden="true"><span style={{ width: `${progress.total > 0 ? current / progress.total * 100 : 0}%` }} /></span></span>}
          <button type="button" className={styles.more} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedStep(expanded ? null : replyKey)}>{expanded ? "Кратко" : reply !== text || hint ? "Подробнее" : "Ещё"}<ChevronDown size={14} aria-hidden="true" /></button>
        </div>}
        {(primary || secondary || onBack) && <div className={styles.actions}>
          {onBack && <button type="button" className={styles.back} onClick={onBack} aria-label="Предыдущая подсказка"><ArrowLeft size={18} aria-hidden="true" /></button>}
          {secondary && <button type="button" className={styles.secondary} onClick={secondary.onClick}>{secondary.label}</button>}
          {primary && <button type="button" className={styles.primary} onClick={primary.onClick} disabled={primary.disabled}>{primary.label}<ArrowRight size={17} aria-hidden="true" /></button>}
          {welcome && <button type="button" className={styles.skip} onClick={onSkip}>Пропустить</button>}
        </div>}
      </footer>
      <span className={styles.live} aria-live="polite" aria-atomic="true">{title}. {reply}</span>
    </section>
  </>;
}
