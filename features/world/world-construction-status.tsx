"use client";

import { Check, Hammer } from "lucide-react";
import type { EconomyController } from "@/features/economy/use-economy";
import { stationName } from "@/features/economy/world-economy-parts";
import styles from "./world-map-hud.module.css";

export function constructionCountdown(seconds: number) {
  const value = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(value / 86400);
  const hours = Math.floor(value % 86400 / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const rest = value % 60;
  return `${days ? `${days} д ` : ""}${hours || days ? `${hours}:` : ""}${hours || days ? String(minutes).padStart(2, "0") : minutes}:${String(rest).padStart(2, "0")}`;
}

/** Server-owned construction remains visible even while its object menu is closed. */
export function WorldConstructionStatus({ economy, onOpen }: { economy: EconomyController; onOpen: (stationId: string) => void }) {
  const state = economy.snapshot;
  const job = state?.jobs.find(entry => entry.kind === "construction");
  if (!state || !job) return null;
  const remaining = Math.max(0, Math.ceil((Date.parse(job.finishesAt) - economy.now) / 1000));
  const duration = Math.max(1, Date.parse(job.finishesAt) - Date.parse(job.startedAt));
  const progress = Math.min(1, Math.max(0, 1 - remaining * 1000 / duration));
  const name = stationName(state, job.targetId);
  return <button type="button" className={styles.construction} data-construction-status data-ready={remaining === 0 || undefined}
    aria-label={`${name}: ${remaining ? "идёт строительство" : "строительство завершено"}. Открыть улучшение`}
    onClick={() => onOpen(job.targetId)}>
    {remaining ? <Hammer size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
    <span className={styles.constructionName}>{name}<small> → {job.targetLevel}</small></span>
    <strong>{remaining ? constructionCountdown(remaining) : "Готово"}</strong>
    <span className={styles.constructionTrack} aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></span>
  </button>;
}
