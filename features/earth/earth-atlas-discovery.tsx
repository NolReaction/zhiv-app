"use client";

import type { CSSProperties } from "react";
import { Handshake, Landmark, Trees } from "lucide-react";
import { EARTH_ATLAS_DISCOVERY_DURATION_MS, type EarthAtlasDiscoveryFeedback } from "./earth-atlas-discovery-feedback";
import styles from "./earth-atlas-discovery.module.css";

type Props = { discovery: EarthAtlasDiscoveryFeedback | null; inline?: boolean };

export function EarthAtlasDiscovery({ discovery, inline = false }: Props) {
  const Icon = discovery?.entry.kind === "meeting" ? Handshake : discovery?.entry.kind === "landmark" ? Landmark : Trees;
  return <div className={`${styles.region}${inline ? ` ${styles.inlineRegion}` : ""}`} role="status" aria-live="polite" aria-atomic="true">
    {discovery && <div key={discovery.sequence} className={styles.discovery} style={{
      "--atlas-progress-from": `${(discovery.openedCount - 1) / discovery.total * 100}%`,
      "--atlas-progress-to": `${discovery.openedCount / discovery.total * 100}%`,
      "--atlas-feedback-duration": `${EARTH_ATLAS_DISCOVERY_DURATION_MS}ms`,
    } as CSSProperties}>
      <span className={styles.announcement}>Открыто в атласе: {discovery.entry.title}. {discovery.openedCount} из {discovery.total}.</span>
      <span className={styles.icon} aria-hidden="true"><Icon size={23} strokeWidth={1.7} /></span>
      <div className={styles.content} aria-hidden="true">
        <div className={styles.meta}><span>Новое в атласе</span><span>{discovery.openedCount} / {discovery.total}</span></div>
        <strong>{discovery.entry.title}</strong>
        <span className={styles.progress}><span /></span>
      </div>
    </div>}
  </div>;
}
