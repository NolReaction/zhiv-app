"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { CircleHelp } from "lucide-react";
import { GuideCoach } from "./guide-coach";
import { sectionGuideCanOpen, sectionGuideLessons, transitionSectionGuide, type SectionGuideEvent, type SectionGuideId } from "./section-guide-model";
import { createSectionGuideStore } from "./section-guide-storage";
import { requestSectionGuideNavigation } from "./section-guide-navigation";
import { useSectionGuideLauncherPreference } from "./use-section-guide-preferences";
import styles from "./section-guide.module.css";

export type SectionGuideProps = {
  owner: string;
  section: SectionGuideId;
  /** Parent excludes initial-course steps, unloaded state and sessions owned by another device. */
  enabled: boolean;
  targetRoot?: RefObject<HTMLElement | null>;
  /** Keep this inside the current menu/dialog, before its scrolling content. */
  inline?: boolean;
};
function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
function hiddenByParent(element: HTMLElement) {
  return Boolean(element.closest('[aria-hidden="true"], [hidden], [inert]'));
}
function coveredByModal(element: HTMLElement) {
  // Live regions can be exempt from Radix aria-hidden, and its Content does not
  // always emit aria-modal. Include our known modal slot, excluding nonmodal
  // quick panels. Only the active portal's own guide may remain open.
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [data-slot="dialog-content"][role="dialog"][data-state="open"]:not([aria-modal="false"])',
  ));
  const active = dialogs.findLast(dialog => dialog.dataset.state !== "closed" && !hiddenByParent(dialog)
    && dialog.getClientRects().length > 0 && window.getComputedStyle(dialog).visibility !== "hidden");
  return Boolean(active && !active.contains(element));
}

export function SectionGuide({ owner, section, enabled, targetRoot, inline = true }: SectionGuideProps) {
  const { showSectionGuideLauncher } = useSectionGuideLauncherPreference(owner);
  const host = useRef<HTMLDivElement>(null), scope = useRef<HTMLElement | null>(null), launcher = useRef<HTMLButtonElement>(null);
  const store = useMemo(() => createSectionGuideStore(owner, section, browserStorage()), [owner, section]);
  // Persist the step, never permission to interrupt the next visit or account.
  const [requestedStore, setRequestedStore] = useState<typeof store | null>(null);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const steps = sectionGuideLessons[section];
  const index = Math.max(0, steps.findIndex(step => step.id === state.progress?.stepId));
  const step = steps[index];
  const [presentation, setPresentation] = useState<{ key: string; scope: string; visible: boolean; target?: string }>({ key: "", scope: "", visible: false });
  const scopeKey = JSON.stringify([owner, section]);
  const presentationKey = `${scopeKey}:${step.id}`;
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => {
      if (event.key !== store.storageKey && event.key !== null) return;
      setRequestedStore(null);
      store.restore();
    };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  useEffect(() => {
    if (!enabled || !host.current) return;
    const element = host.current;
    const root = targetRoot?.current ?? element.parentElement ?? document.body;
    scope.current = root;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const visible = element.isConnected && Boolean(element.parentElement?.getClientRects().length) && !hiddenByParent(element) && !coveredByModal(element) && window.getComputedStyle(element).visibility !== "hidden";
      const target = step.targets.find(selector => {
        const candidate = root.querySelector<HTMLElement>(selector);
        return candidate && !hiddenByParent(candidate) && candidate.getClientRects().length > 0 && window.getComputedStyle(candidate).visibility !== "hidden";
      });
      const next = { key: presentationKey, scope: scopeKey, visible, target };
      setPresentation(previous => previous.key === next.key && previous.visible === visible && previous.target === target ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "inert", "class", "data-state", "style"] });
    // Radix hides an existing dialog's ancestor when opening another focus scope.
    const ancestors = new MutationObserver(schedule);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.observe(parent, { attributes: true, attributeFilter: ["hidden", "aria-hidden", "inert", "class", "style"] });
    const modals = new MutationObserver(schedule);
    modals.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["role", "aria-modal", "data-state", "hidden", "aria-hidden", "inert"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => { cancelAnimationFrame(frame); mutation.disconnect(); ancestors.disconnect(); modals.disconnect(); window.removeEventListener("resize", schedule); };
  }, [enabled, targetRoot, step, presentationKey, scopeKey]);
  const eligible = Boolean(owner) && enabled && presentation.scope === scopeKey && presentation.visible;
  const open = sectionGuideCanOpen(state.loaded, eligible, state.progress, requestedStore === store);
  const currentTarget = presentation.key === presentationKey ? presentation.target : undefined;
  const revealedStep = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { revealedStep.current = null; return; }
    if (!step.revealOnOpen || !step.navigation || revealedStep.current === presentationKey) return;
    // Wait for the shop listener, then reveal its actual odds. This only changes
    // tabs, the selected preview and scroll position; no game command is sent.
    const frame = requestAnimationFrame(() => {
      const root = targetRoot?.current ?? host.current?.parentElement;
      if (root && step.navigation && requestSectionGuideNavigation(root, step.navigation, step.id)) revealedStep.current = presentationKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, step, presentationKey, targetRoot, currentTarget]);
  const apply = (event: SectionGuideEvent) => {
    const progress = transitionSectionGuide(section, store.getSnapshot().progress, event);
    store.save(progress);
    if (progress.status !== "started") {
      setRequestedStore(null);
      requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
    }
  };
  const start = () => {
    const progress = store.getSnapshot().progress;
    apply(progress?.status === "started" || progress?.status === "paused" ? "resume" : progress ? "replay" : "start");
    setRequestedStore(store);
  };
  const showTarget = () => {
    const root = targetRoot?.current ?? host.current?.parentElement;
    if (root && step.navigation && requestSectionGuideNavigation(root, step.navigation, step.id)) return;
    const target = currentTarget && root?.querySelector<HTMLElement>(currentTarget);
    if (target) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  };
  return <div ref={host} className={styles.guide} data-section-guide={section}>
    {eligible && state.loaded && (open ? <GuideCoach open flow="section" inline={inline} compact stepId={`${section}:${step.id}`}
      title={step.title} summary={step.summary} text={step.text} pose={step.pose} target={currentTarget} targetRoot={targetRoot ?? scope}
      progress={{ current: index + 1, total: steps.length }} onPause={() => apply("pause")} onSkip={() => apply("skip")}
      onBack={index > 0 ? () => apply("back") : undefined}
      primary={{ advance: true, label: index === steps.length - 1 ? "Понятно" : "Дальше", onClick: () => apply("next") }}
      secondaryVisible={section === "plesk"}
      secondary={currentTarget || step.navigation ? { label: step.showLabel ?? "Показать", onClick: showTarget } : undefined} />
      : (showSectionGuideLauncher || state.progress?.status === "paused") && <button ref={launcher} type="button" className={styles.launcher} onClick={start}><CircleHelp size={15} aria-hidden="true" />Что здесь делать?</button>)}
  </div>;
}
