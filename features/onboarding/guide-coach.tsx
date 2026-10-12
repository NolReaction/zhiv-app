"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Ellipsis, Minus, MousePointer2 } from "lucide-react";
import { createPortal } from "react-dom";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { GuideCharacter } from "./guide-character";
import { measureGuideSpotlight } from "./guide-spotlight";
import { worldCoachLayout } from "./guide-coach-layout";
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
  /** Existing panel slot; the speech reserves space instead of covering its body. */
  dock?: string;
  welcome?: boolean;
  status?: string;
  primary?: { label: string; onClick: () => void; disabled?: boolean; advance?: boolean };
  secondary?: { label: string; onClick: () => void };
  /** Keep essential read-only navigation outside the details disclosure. */
  secondaryVisible?: boolean;
  onPause: () => void;
  onSkip: () => void;
  onBack?: () => void;
  children?: ReactNode;
};
type Bounds = { left: number; top: number; width: number; height: number };
type CoachLayout = { key: string; left: number; top: number; width: number; maxHeight: number };
const overlapArea = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
function shortReply(text: string) {
  if (text.length <= 140) return text;
  const sentence = text.match(/^.{35,139}?[.!?](?:\s|$)/u)?.[0].trim();
  if (sentence) return sentence;
  const boundary = text.lastIndexOf(" ", 134);
  return `${text.slice(0, boundary > 95 ? boundary : 134).trimEnd()}…`;
}

/** An ordinary region, deliberately inside the parent's DOM/focus scope.
 * Only the speech bubble receives pointer events; the real UI stays usable. */
export function GuideCoach(props: GuideCoachProps) {
  const { open, flow, stepId, target, targetRoot, compact, inline, dock, title, text, summary, hint, pose, progress, welcome, status, primary, secondary, secondaryVisible, onPause, onSkip, onBack, children } = props;
  const headingId = useId(), textId = useId(), detailsId = useId();
  const card = useRef<HTMLElement>(null), copy = useRef<HTMLDivElement>(null);
  const [dockElement, setDockElement] = useState<HTMLElement | null>(null);
  const embedded = Boolean(inline || dockElement);
  const canAdvance = Boolean(!welcome && primary?.advance && !primary.disabled);
  const [layout, setLayout] = useState<CoachLayout | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const layoutKey = `${flow}:${stepId}:${target ?? ""}`;
  const replyKey = `${flow}:${stepId}`;
  const expanded = Boolean(welcome || expandedStep === replyKey);
  const reply = welcome ? text : shortReply(summary ?? text);
  useEffect(() => {
    if (!open) return;
    const root = targetRoot?.current ?? document;
    let frame = 0, observedTarget: HTMLElement | null = null;
    let observedHud: HTMLElement[] = [];
    let settleUntil = performance.now() + 400;
    const measure = () => {
      frame = 0;
      const bubble = card.current;
      if (!bubble) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const viewportLeft = viewport?.offsetLeft ?? 0, viewportTop = viewport?.offsetTop ?? 0;
      const slot = dock ? root.querySelector<HTMLElement>(dock) : null;
      setDockElement(previous => previous === slot ? previous : slot);
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
      const highlight = measureGuideSpotlight(element, { left: viewportLeft, top: viewportTop, width, height });
      element?.classList.toggle(styles.spotlight, Boolean(highlight));
      // Panel lessons reserve their own space. Viewport coordinates cannot be
      // applied inside a transformed dialog's fixed-position containing block.
      if (inline || slot) return;
      const bubbleRect = bubble.getBoundingClientRect();
      if (flow === "world") {
        const topHud = root.querySelector<HTMLElement>('[data-world-hud="top"]');
        const bottomHud = root.querySelector<HTMLElement>('[data-world-hud="bottom"]');
        const hud = [topHud, bottomHud].filter((element): element is HTMLElement => Boolean(element));
        if (hud.length !== observedHud.length || hud.some((element, index) => element !== observedHud[index])) {
          for (const element of observedHud) if (element !== observedTarget) resize.unobserve(element);
          for (const element of hud) resize.observe(element);
          observedHud = hud;
        }
        const padding = topHud ? getComputedStyle(topHud) : null;
        const next: CoachLayout = { key: layoutKey, ...worldCoachLayout(
          { left: viewportLeft, top: viewportTop, width, height }, bubbleRect.height,
          { topHud: topHud?.getBoundingClientRect(), bottomHud: bottomHud?.getBoundingClientRect(),
            sideInset: Math.max(parseFloat(padding?.paddingLeft ?? "0") || 0, parseFloat(padding?.paddingRight ?? "0") || 0), highlight },
        ) };
        setLayout(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (performance.now() < settleUntil) frame = requestAnimationFrame(measure);
        return;
      }
      const bubbleWidth = Math.min(384, width - 16);
      const left = viewportLeft + 8, right = Math.max(left, viewportLeft + width - bubbleWidth - 8);
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
      const next: CoachLayout = { key: layoutKey, left: ordered[0].left, top: ordered[0].top, width: bubbleWidth, maxHeight: Math.max(96, height - 112) };
      setLayout(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      // Opening panels can translate their targets without resizing them.
      // Follow that short entrance, then return to event-driven measurement.
      if (performance.now() < settleUntil) frame = requestAnimationFrame(measure);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    if (card.current) resize.observe(card.current);
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "aria-hidden", "inert", "style", "aria-expanded", "data-state"] });
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
  }, [open, flow, target, targetRoot, layoutKey, compact, inline, dock, dockElement]);
  useEffect(() => {
    if (!open || !dockElement) return;
    dockElement.classList.add(styles.dockSlot);
    const panel = dockElement.parentElement?.id === "world-quick-menu" ? dockElement.parentElement : null;
    panel?.classList.add(styles.scrollingPanel);
    return () => { dockElement.classList.remove(styles.dockSlot); panel?.classList.remove(styles.scrollingPanel); };
  }, [open, dockElement]);
  useEffect(() => {
    if (open) copy.current?.scrollTo({ top: 0 });
  }, [open, stepId]);
  if (!open) return null;
  const placement = !embedded && layout?.key === layoutKey ? layout : null;
  const position: CSSProperties | undefined = placement ? { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight, right: "auto", bottom: "auto" } : undefined;
  const current = progress ? Math.min(progress.total, Math.max(1, progress.current)) : 0;
  const next = canAdvance ? primary!.onClick : undefined;
  const message = <span className={styles.text}>{reply}</span>;
  const coach = <section ref={card} className={styles.coach} style={position} role="region" aria-labelledby={headingId} aria-describedby={textId}
    data-guide-coach={flow} data-guide-step={stepId} data-compact={Boolean(compact)} data-welcome={Boolean(welcome)} data-inline={embedded} data-expanded={expanded}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onPause(); } }}>
    <div ref={copy} className={styles.copy}>
      <div className={styles.intro}>
        <GuideCharacter key={stepId} pose={pose} stepId={stepId} onAdvance={next} advanceLabel={primary?.label} />
        <div className={styles.speech}>
          <header className={styles.header}>
            <h2 id={headingId} className={styles.title}>{title}</h2>
          </header>
          {canAdvance ? <button type="button" id={textId} className={styles.message} data-guide-advance onClick={next} aria-label={`${reply} ${primary!.label}`}>{message}</button>
            : <p id={textId} className={styles.messageText}>{message}</p>}
        </div>
        {welcome && <button type="button" className={styles.pause} data-guide-pause onClick={onPause} title="Свернуть обучение, сохранив шаг" aria-label="Свернуть обучение, сохранив шаг"><Minus size={18} aria-hidden="true" /></button>}
      </div>
      {children}
      {secondaryVisible && secondary && <div className={styles.actions}><button type="button" className={styles.secondary} onClick={secondary.onClick}>{secondary.label}</button></div>}
      <div id={detailsId} className={styles.details} hidden={!expanded}>
        {reply !== text && <p className={styles.text}>{text}</p>}
        {hint && <p className={styles.hint}><MousePointer2 size={15} aria-hidden="true" /><span>{hint}</span></p>}
        {!welcome && <div className={styles.actions}>
          {onBack && <button type="button" className={styles.back} onClick={onBack} aria-label="Предыдущая подсказка"><ArrowLeft size={18} aria-hidden="true" /></button>}
          {!secondaryVisible && secondary && <button type="button" className={styles.secondary} onClick={secondary.onClick}>{secondary.label}</button>}
          <button type="button" className={styles.skip} onClick={onSkip}>{flow === "section" ? "Пропустить знакомство" : "Пропустить обучение"}</button>
        </div>}
      </div>
      {status && !canAdvance && <p className={styles.status} role="status">{status}</p>}
    </div>
    <footer className={styles.footer}>
      {!welcome && <div className={styles.controls}>
        {progress && <span className={styles.counter} aria-label={`Шаг ${current} из ${progress.total}`}>{current}<span> / {progress.total}</span></span>}
        <button type="button" className={styles.pause} data-guide-pause onClick={onPause} title="Свернуть обучение, сохранив шаг" aria-label="Свернуть обучение, сохранив шаг"><Minus size={18} aria-hidden="true" /></button>
        <button type="button" className={styles.more} aria-label="Подробнее и действия обучения" title="Подробнее и действия" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedStep(expanded ? null : replyKey)}><Ellipsis size={19} aria-hidden="true" /></button>
        {canAdvance && <button type="button" className={styles.continue} data-guide-next onClick={next} aria-label={primary!.label.startsWith("Дальше") ? primary!.label : `Дальше: ${primary!.label}`} title={primary!.label}>Дальше<ArrowRight size={18} aria-hidden="true" /></button>}
      </div>}
      {(welcome || primary && !canAdvance) && <div className={styles.actions}>
        {primary && <button type="button" className={styles.primary} onClick={primary.onClick} disabled={primary.disabled}>{primary.label}<ArrowRight size={17} aria-hidden="true" /></button>}
        {welcome && <button type="button" className={styles.skip} onClick={onSkip}>Пропустить</button>}
      </div>}
    </footer>
    <span className={styles.live} aria-live="polite" aria-atomic="true">{title}. {reply}{canAdvance ? ` ${primary!.label}` : status ? ` ${status}` : ""}</span>
  </section>;
  return dockElement && open ? createPortal(coach, dockElement) : coach;
}
