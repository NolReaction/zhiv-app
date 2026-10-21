"use client";

import type { CSSProperties } from "react";
import { Handshake, Landmark, Trees } from "lucide-react";
import { EARTH_ATLAS_DISCOVERY_DURATION_MS, type EarthAtlasDiscoveryFeedback } from "./earth-atlas-discovery-feedback";
import styles from "./earth-atlas-discovery.module.css";

type Props = { discovery: EarthAtlasDiscoveryFeedback | null; inline?: boolean };

export function EarthAtlasDiscovery({ discovery, inline = false }: Props) {
  const Icon = discovery?.entry.kind === "meeting" ? Handshake : discovery?.entry.kind === "landmark" ? Landmark : Trees;
  const meeting = discovery?.entry.kind === "meeting";
  return <div className={`${styles.region}${inline ? ` ${styles.inlineRegion}` : ""}`} role="status" aria-live="polite" aria-atomic="true">
    {discovery && <div key={discovery.sequence} className={styles.discovery} style={{
      ...(!meeting ? {
        "--atlas-progress-from": `${(discovery.openedCount - 1) / discovery.total * 100}%`,
        "--atlas-progress-to": `${discovery.openedCount / discovery.total * 100}%`,
      } : {}),
      "--atlas-feedback-duration": `${EARTH_ATLAS_DISCOVERY_DURATION_MS}ms`,
    } as CSSProperties}>
      <span className={styles.announcement}>{meeting ? "Встреча отмечена в атласе." : `Открыто в атласе: ${discovery.entry.title}. ${discovery.openedCount} из ${discovery.total}.`}</span>
      <span className={styles.icon} aria-hidden="true"><Icon size={23} strokeWidth={1.7} /></span>
      <div className={styles.content} aria-hidden="true">
        <div className={styles.meta}><span>{meeting ? "Личная отметка" : "Новое в атласе"}</span>{!meeting && <span>{discovery.openedCount} / {discovery.total}</span>}</div>
        <strong>{meeting ? "Встреча отмечена" : discovery.entry.title}</strong>
        {!meeting && <span className={styles.progress}><span /></span>}
      </div>
    </div>}
  </div>;
}
