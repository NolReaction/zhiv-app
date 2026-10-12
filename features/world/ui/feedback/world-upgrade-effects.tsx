"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { Check } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { ConstructionCompletion } from "@/features/economy/domain/construction-completion";
import { stationName } from "@/features/economy/ui/shared/world-economy-parts";
import { CONSTRUCTION_MARKER, constructionMapPlace, type MapObjectScreenAnchor } from "@/features/world/scene/construction-map-anchor";
import styles from "./world-upgrade-effects.module.css";

export const UPGRADE_CELEBRATION_MS = 2800;
const NO_COMPLETIONS: readonly ConstructionCompletion[] = [];

/** Completion is an action receipt, never a timer or a comparison with a saved level. */
export function WorldUpgradeEffects({ economy, anchors, ready }: {
  economy: EconomyController; anchors: readonly MapObjectScreenAnchor[]; ready: boolean;
}) {
  const completions = economy.completedConstructions ?? NO_COMPLETIONS;
  const layer = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set(completions.map(event => event.id)));
  const running = useRef(new Map<string, { element: HTMLElement; timer: ReturnType<typeof setTimeout> }>());

  useLayoutEffect(() => {
    for (const event of completions) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      // Offscreen/unmounted/hidden completions are not replayed when the map returns.
      const element = layer.current?.querySelector<HTMLElement>(`[data-upgrade-event="${event.id}"]`);
      if (!ready || document.hidden || !element) continue;
      element.hidden = false;
      const timer = setTimeout(() => {
        element.hidden = true;
        running.current.delete(event.id);
      }, UPGRADE_CELEBRATION_MS);
      running.current.set(event.id, { element, timer });
    }
  }, [completions, ready]);

  useEffect(() => {
    const active = running.current;
    const clear = () => {
      for (const { element, timer } of active.values()) { element.hidden = true; clearTimeout(timer); }
      active.clear();
    };
    const visibility = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); clear(); };
  }, []);

  return <div ref={layer} className={styles.layer} aria-live="polite" aria-atomic="false">
    {completions.flatMap(event => {
      const anchor = anchors.find(entry => entry.place === constructionMapPlace(event.stationId));
      if (!anchor || !economy.snapshot) return [];
      const name = stationName(economy.snapshot, event.stationId);
      return <div key={event.id} hidden className={styles.effect} data-upgrade-event={event.id}
        data-upgrade-target={event.stationId} data-map-object={anchor.objectId}
        style={{ left: anchor.x + anchor.pointerOffset, top: anchor.y + CONSTRUCTION_MARKER.gap,
          "--badge-offset": `${-anchor.pointerOffset}px` } as CSSProperties}>
        <span className={styles.halo} aria-hidden="true" />
        <span className={styles.ring} aria-hidden="true" />
        <svg className={styles.glints} viewBox="0 0 180 144" aria-hidden="true" focusable="false">
          {[[28, 80, 5], [45, 43, 7], [75, 24, 5], [108, 31, 7], [143, 58, 6], [154, 95, 4], [56, 115, 4], [121, 109, 5]].map(([x, y, radius], index) =>
            <path key={index} style={{ "--glint-delay": `${index * 65}ms` } as CSSProperties}
              d={`M${x} ${y - radius} Q${x + 1} ${y - 1} ${x + radius} ${y} Q${x + 1} ${y + 1} ${x} ${y + radius} Q${x - 1} ${y + 1} ${x - radius} ${y} Q${x - 1} ${y - 1} ${x} ${y - radius}Z`} />)}
        </svg>
        <span className={styles.badge}><span><Check size={15} aria-hidden="true" /><strong>Уровень {event.level}</strong></span><small>{name}</small></span>
      </div>;
    })}
  </div>;
}
