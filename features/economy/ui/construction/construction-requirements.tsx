import { ArrowRight, LockKeyhole } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { stationName, type StationNavigation } from "@/features/economy/ui/shared/world-economy-parts";
import { worldMissingRequirements } from "@/features/economy/ui/shared/world-stations";
import { ConstructionBuildingArt } from "./construction-building-art";
import styles from "./construction-requirements.module.css";

/** One prerequisite per row, with a real destination only when it can be opened. */
export function ConstructionRequirements({ state, required, navigation }: {
  state: EconomyView; required: Record<string, number>; navigation?: StationNavigation;
}) {
  const missing = worldMissingRequirements(state, required);
  if (!missing.length) return null;
  return <ul className={styles.list} aria-label="Недостающие условия">{missing.map(({ id, level, current }) => {
    const name = stationName(state, id);
    const content = <><ConstructionBuildingArt stationId={id} level={level} /><span className={styles.copy}><strong>{name}</strong><span>{current ? `Сейчас ур. ${current}` : "Не построено"}</span></span><span className={styles.level}>Нужен ур. {level}</span></>;
    return <li key={id} data-building-requirement={id}>{navigation?.canOpen(id)
      ? <button type="button" className={styles.row} aria-label={`${name}: нужен уровень ${level}. ${current ? `Сейчас уровень ${current}` : "Не построено"}. Открыть постройку`} onClick={() => navigation.open(id)}>{content}<ArrowRight size={14} aria-hidden="true" /></button>
      : <div className={styles.row}>{content}<LockKeyhole size={13} aria-hidden="true" /></div>}</li>;
  })}</ul>;
}
