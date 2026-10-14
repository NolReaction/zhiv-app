"use client";

import type { CSSProperties } from "react";
import { Check, Hammer, Package, Pickaxe } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { stationName } from "@/features/economy/ui/shared/world-economy-parts";
import { constructionCountdown } from "./world-construction-status";
import type { MapObjectScreenAnchor } from "@/features/world/scene/construction-map-anchor";
import { layoutProductionMarkers, workshopProductionSections, type MapProduction, type MapProductionGroup } from "./world-production-state";
import styles from "./world-production-status.module.css";

export function WorldProductionStatus({ economy, groups, anchors, reserved = [], hidden = false, onOpen, onOpenConstruction }: {
  economy: EconomyController; groups: readonly MapProductionGroup[]; anchors: readonly MapObjectScreenAnchor[];
  reserved?: readonly MapObjectScreenAnchor[]; hidden?: boolean; onOpen: (stationId: string) => void; onOpenConstruction?: (stationId: string) => void;
}) {
  const state = economy.snapshot;
  if (!state || hidden) return null;
  const description = (work: MapProduction) => `${stationName(state, work.stationId)}: ${work.recipeName}, ${work.label}${work.remaining ? `, ${constructionCountdown(work.remaining)}` : ""}`;
  const content = (entry: MapProduction, count: number, stationLabel?: string) => {
    const active = entry.phase === "working" || entry.phase === "collecting", construction = entry.kind === "construction";
    return <>
      <span className={styles.icon} aria-hidden="true">
        {construction ? <Hammer size={23} /> : entry.phase === "storage-blocked" ? <Package size={23} /> : entry.stationId === "quarry" && active ? <Pickaxe size={23} />
          : entry.itemId ? <PlayerItemIcon state={state} itemId={entry.itemId} size={28} /> : <Hammer size={23} />}
        {entry.phase === "ready" && <Check className={styles.check} size={12} />}
      </span>
      <span className={styles.caption}><strong>{active && entry.remaining ? constructionCountdown(entry.remaining) : active ? "Собирает…" : entry.phase === "ready" ? "Готово" : entry.label}</strong>
        <small>{stationLabel ?? (construction ? active ? "Строительство" : "Завершить" : active ? entry.label : entry.phase === "ready" ? "В кладовую" : entry.recipeName)}</small></span>
      {count > 1 && <span className={styles.count} aria-hidden="true">+{count - 1}</span>}
      <span className={styles.track} aria-hidden="true"><span style={{ width: `${entry.progress * 100}%` }} /></span>
    </>;
  };
  return <>{layoutProductionMarkers(groups, anchors, reserved).map(({ group, anchor }) => {
    const entry = group.primary, construction = entry.kind === "construction";
    const count = group.entries.length + Number(Boolean(group.construction));
    const work = group.construction ? [...group.entries, group.construction] : group.entries;
    const details = work.map(description), sections = workshopProductionSections(group);
    const position = { left: anchor.x, top: anchor.y, "--pointer-offset": `${anchor.pointerOffset}px` } as CSSProperties;
    if (sections.length > 1) return <div key={group.place} className={`${styles.marker} ${styles.markerSplit}`} style={position}
      role="group" aria-label={`Верстак и печь${group.construction ? `. ${description(group.construction)}` : ""}`}
      data-production-host={group.place} data-map-object={anchor.objectId} title={details.join("\n")}>
      {sections.map(section => <button key={section.stationId} type="button" className={styles.sectionButton}
        data-production-status={section.primary.phase} data-production-target={section.stationId} data-work-kind={section.primary.kind}
        title={section.entries.map(description).join("\n")}
        aria-label={`${section.entries.map(description).join(". ")}. Открыть ${section.label.toLocaleLowerCase("ru-RU")}`}
        onClick={() => onOpen(section.stationId)}>{content(section.primary, section.entries.length, section.label)}</button>)}
    </div>;
    return <button key={group.place} type="button" className={styles.marker} data-production-status={entry.phase}
      data-production-target={entry.stationId} data-map-object={anchor.objectId} data-work-kind={entry.kind}
      style={position}
      title={details.join("\n")} aria-label={`${details.join(". ")}. ${construction ? "Открыть улучшение" : "Открыть здание"}`}
      onClick={() => construction && onOpenConstruction ? onOpenConstruction(entry.stationId) : onOpen(entry.stationId)}>
      {content(entry, count, sections[0]?.label)}
    </button>;
  })}</>;
}
