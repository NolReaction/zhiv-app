"use client";

import { Check, Hammer } from "lucide-react";
import type { CSSProperties } from "react";
import type { EconomyController } from "@/features/economy/use-economy";
import { stationName } from "@/features/economy/world-economy-parts";
import { constructionMapPlace, type MapObjectScreenAnchor } from "./construction-map-anchor";
import styles from "./world-construction-status.module.css";

export function constructionCountdown(seconds: number) {
  const value = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(value / 86400);
  const hours = Math.floor(value % 86400 / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const rest = value % 60;
  return `${days ? `${days} д ` : ""}${hours || days ? `${hours}:` : ""}${hours || days ? String(minutes).padStart(2, "0") : minutes}:${String(rest).padStart(2, "0")}`;
}

/** The server-owned job follows its map host until the ordinary completion claim. */
export function WorldConstructionStatus({ economy, onOpen, anchors = [], hidden = false }: {
  economy: EconomyController;
  onOpen: (stationId: string) => void;
  anchors?: readonly MapObjectScreenAnchor[];
  hidden?: boolean;
}) {
  const state = economy.snapshot;
  const job = state?.jobs.find(entry => entry.kind === "construction");
  const anchor = job && anchors.find(entry => entry.place === constructionMapPlace(job.targetId));
  if (!state || !job || !anchor || hidden) return null;
  const remaining = Math.max(0, Math.ceil((Date.parse(job.finishesAt) - economy.now) / 1000));
  const duration = Math.max(1, Date.parse(job.finishesAt) - Date.parse(job.startedAt));
  const progress = Math.min(1, Math.max(0, 1 - remaining * 1000 / duration));
  const name = stationName(state, job.targetId);
  return <button type="button" className={styles.marker} data-construction-status data-construction-target={job.targetId}
    data-map-object={anchor.objectId} data-ready={remaining === 0 || undefined}
    style={{ left: anchor.x, top: anchor.y, "--pointer-offset": `${anchor.pointerOffset}px` } as CSSProperties}
    aria-label={`${name}: ${remaining ? "идёт строительство" : "строительство завершено"}. Открыть улучшение`}
    title={`${name} · Уровень ${job.targetLevel}`}
    onClick={() => onOpen(job.targetId)}>
    {remaining ? <Hammer size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
    <strong>{remaining ? constructionCountdown(remaining) : "Готово"}</strong>
    <span className={styles.track} aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></span>
  </button>;
}
