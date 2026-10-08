"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Compass, Info, Leaf, Map, Package, Sparkles, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WORLD_ONBOARDING_STEPS, type WorldOnboardingProgress, type WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { useForestObservation } from "@/features/world/state/use-forest-observation";
import { MochlikGuide } from "./mochlik-guide";
import styles from "./world-onboarding.module.css";

export type WorldOnboardingProps = {
  open: boolean;
  progress: WorldOnboardingProgress | null;
  worldElement: RefObject<HTMLElement | null>;
  onStart: () => void;
  onStep: (stepId: WorldOnboardingStepId) => void;
  onSkip: () => void;
  onComplete: () => void;
  onPause: () => void;
  onReturnFocus: () => void;
};
type Spotlight = { left: number; top: number; width: number; height: number };
const icons = { map: Map, leaf: Leaf, package: Package, compass: Compass, help: Info };

/** Wait for the actual backdrop and yield the modal to the session takeover notice. */
export function WorldOnboardingSession(props: WorldOnboardingProps & { presenceKey: string }) {
  const observation = useForestObservation(props.presenceKey);
  const blocked = observation?.memory.sync?.mode === "other-device";
  const [sceneReady, setSceneReady] = useState(false);
  useEffect(() => {
    const element = props.worldElement.current;
    if (!element) return;
    const measure = () => setSceneReady(Boolean(element.querySelector('[data-ready="true"] > canvas[role="img"]')));
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready"] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [props.worldElement]);
  return <WorldOnboarding {...props} open={props.open && sceneReady && !blocked} onReturnFocus={() => { if (!blocked) props.onReturnFocus(); }} />;
}

export function WorldOnboarding(props: WorldOnboardingProps) {
  const { open, progress, worldElement } = props;
  const index = progress?.status === "started" ? WORLD_ONBOARDING_STEPS.findIndex(step => step.id === progress.stepId) : -1;
  const step = WORLD_ONBOARDING_STEPS[index];
  const selector = step && "selector" in step ? step.selector : undefined;
  const [spotlight, setSpotlight] = useState<{ selector: string; bounds: Spotlight } | null>(null);
  const primary = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), bubble = useRef<HTMLDivElement>(null);
  const last = index === WORLD_ONBOARDING_STEPS.length - 1;
  const Icon = step ? icons[step.icon] : Sparkles;
  useEffect(() => {
    if (!open || !selector) return;
    const target = worldElement.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    const measure = () => {
      const rect = target.getBoundingClientRect();
      setSpotlight(rect.width > 0 && rect.height > 0 ? { selector, bounds: { left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 } } : null);
    };
    // Measure after the portal's entrance transform and all responsive HUD changes.
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("scroll", measure); };
  }, [open, selector, worldElement]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => { bubble.current?.scrollTo({ top: 0 }); heading.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [open, index]);
  const highlight = selector && spotlight?.selector === selector ? spotlight.bounds : null;
  return <Dialog open={open} onOpenChange={next => { if (!next) props.onPause(); }}>
    <DialogPortal>
      <DialogPrimitive.Overlay className={styles.scrim} data-spotlight={Boolean(highlight)}>
        {highlight && <div className={styles.spotlight} style={highlight as CSSProperties} aria-hidden="true" />}
      </DialogPrimitive.Overlay>
      <DialogPrimitive.Content className={styles.guide} data-world-onboarding={step?.id ?? "welcome"} data-target-position={index === 2 || index === 3 ? "bottom" : "top"}
        onPointerDownOutside={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); props.onPause(); }}
        onOpenAutoFocus={event => { event.preventDefault(); primary.current?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => { event.preventDefault(); props.onReturnFocus(); }}>
        <div className={styles.character}><span className={styles.halo} /><MochlikGuide className={styles.portrait} /><span className={styles.name}><Leaf size={13} aria-hidden="true" />Мохлик</span></div>
        <div className={styles.bubble}>
          <header className={styles.header}><span className={styles.eyebrow}><Leaf size={14} aria-hidden="true" />{step ? "ЗНАКОМСТВО С ПОЛЯНКОЙ" : "ДОБРО ПОЖАЛОВАТЬ В ЛЕС"}</span><button type="button" className={styles.close} onClick={props.onPause} aria-label="Закрыть обучение"><X size={19} aria-hidden="true" /></button></header>
          <div ref={bubble} className={styles.copy}>
          {step && <div className={styles.progress} aria-label={`Шаг ${index + 1} из ${WORLD_ONBOARDING_STEPS.length}`}><span>{index + 1} / {WORLD_ONBOARDING_STEPS.length}</span><div aria-hidden="true">{WORLD_ONBOARDING_STEPS.map((item, i) => <i key={item.id} data-current={i === index} data-done={i < index} />)}</div></div>}
          <span className={styles.stepIcon} aria-hidden="true"><Icon size={25} /></span>
          <DialogTitle ref={heading} tabIndex={-1} className={styles.title}>{step?.title ?? "Привет! Я Мохлик."}</DialogTitle>
          <DialogDescription className={styles.text}>{step?.text ?? "Рад тебя видеть! Это наша маленькая полянка. Давай покажу, где что находится и с чего начать?"}</DialogDescription>
          <p className={styles.hint}>{step?.hint ?? "Пять коротких подсказок. Можно пройти сейчас или вернуться к ним позже."}</p>
          </div>
          <div className={styles.actions}>
            {index > 0 && <button type="button" className={styles.back} onClick={() => props.onStep(WORLD_ONBOARDING_STEPS[index - 1].id)} aria-label="Предыдущая подсказка"><ArrowLeft size={18} aria-hidden="true" /></button>}
            <button ref={primary} type="button" className={styles.primary} onClick={step ? last ? props.onComplete : () => props.onStep(WORLD_ONBOARDING_STEPS[index + 1].id) : props.onStart}>{step ? last ? "Начать играть" : "Дальше" : "Пройти обучение"}<ArrowRight size={18} aria-hidden="true" /></button>
          </div>
          <button type="button" className={styles.skip} onClick={props.onSkip}>{step ? "Пропустить обучение" : "Пропустить"}</button>
          {!step && <p className={styles.later}>Обучение всегда под рукой: «Ещё» → «Обучение»</p>}
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
