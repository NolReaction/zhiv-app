"use client";

import { ArrowRight } from "lucide-react";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { Work } from "@/features/economy/ui/shared/world-economy-parts";
import { worldMissingRequirements, worldRequirements } from "@/features/economy/ui/shared/world-stations";
import { ConstructionBuildingArt } from "./construction-building-art";
import { ConstructionRequirements } from "./construction-requirements";
import styles from "./world-station-setup.module.css";

const descriptions: Record<string, string> = {
  garden: "Здесь можно будет выращивать ягоды.",
  woodlot: "Здесь можно будет заготавливать древесину.",
  dryer: "Здесь можно будет готовить блюда и напитки.",
  workshop: "Здесь можно будет делать материалы и инструменты.",
  kiln: "Здесь можно будет обжигать материалы.",
  quarry: "Шахтёр будет добывать материалы независимо от Мохлика.",
};

/** Unfinished places lead to construction instead of an unusable catalogue. */
export function WorldStationSetup({ economy, stationId, onOpenConstruction, onOpenPantry }: {
  economy: ReadyEconomy; stationId: string; onOpenConstruction?: () => void; onOpenPantry?: () => void;
}) {
  const state = economy.snapshot;
  const current = state.buildings[stationId] ?? 0;
  const target = state.catalog.buildings.find(building => building.id === stationId)?.levels.find(level => level.level === current + 1);
  const construction = state.jobs.find(job => job.kind === "construction" && job.targetId === stationId);
  const missing = target && !construction ? worldMissingRequirements(state, worldRequirements(target)) : [];
  return <section className={styles.setup} data-station-setup={stationId} aria-label={construction ? "Строительство" : "Место ещё не построено"}>
    <div className={styles.heading}><span className={styles.icon}><ConstructionBuildingArt stationId={stationId} level={target?.level ?? 1} /></span><div><h3>{construction ? current ? "Идёт улучшение" : "Идёт строительство" : "Сначала постройте это место"}</h3><p>{construction ? "Работа откроется после завершения стройки." : descriptions[stationId] ?? "Обустройте место, чтобы начать работу."}</p></div></div>
    {construction ? <Work economy={economy} job={construction} openPantry={onOpenPantry} compact /> : target && missing.length > 0 && <div className={styles.requirement}><span>Для строительства</span><ConstructionRequirements state={state} required={worldRequirements(target)} /></div>}
    {onOpenConstruction && <button type="button" className={styles.action} aria-haspopup="dialog" onClick={onOpenConstruction}>{construction ? "Ход строительства" : missing.length ? "Условия строительства" : "Построить"}<ArrowRight size={14} aria-hidden="true" /></button>}
  </section>;
}
