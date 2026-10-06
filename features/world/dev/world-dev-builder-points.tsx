"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { economyCatalog, type EconomyView } from "@/features/economy/model";
import { economySceneConstruction } from "@/features/economy/world-adapter";
import { builderWorkMarkerChecks, builderWorkStops, BUILDER_NAVIGATION_LIMITS, type BuilderWorkMarkerIssue } from "../builder-navigation";
import { constructionMapPlace } from "../construction-map-anchor";
import { forestConstructionJob, type SceneConstructionJob } from "../economy-construction-state";
import { accountSceneLevels } from "../economy-scene-state";
import { initialPreviewLevels, previewWorldScene } from "../tiled/preview-state";
import type { FixedWorldScene, WorldPoint } from "../tiled/types";
import type { WorldDevState } from "./world-dev-store";
import styles from "./world-dev-panel.module.css";

const issues: Record<BuilderWorkMarkerIssue, string> = {
  "invalid-position": "Некорректные координаты точки.",
  "missing-navigation": "Нет доступной навигации или свободного места старта.",
  "missing-host": "Не найдено здание или его точки подхода.",
  "far-from-building": `Дальше ${BUILDER_NAVIGATION_LIMITS.workReach} ед. от текущего или будущего контура здания.`,
  doorway: "Перекрывает вход или проход к нему.",
  activity: "Слишком близко к месту другого занятия.",
  "blocked-ground": "Нет свободной земли с запасом для лап: коллизия, вода или край WalkAreas.",
  "blocked-future": "Точка занята геометрией после улучшения.",
};
const coordinates = (point: WorldPoint) => `X ${point.x} · Y ${point.y}`;
type Preview = Pick<WorldDevState, "levels" | "previewBuildings">;

/** Read-only account/DEV geometry selection; these hypothetical jobs never enter the simulation. */
export function builderWorkDiagnosticContext(source: FixedWorldScene, preview: Preview, houseLevel: number | undefined,
  economy: EconomyView | null | undefined, now: number) {
  const levels = accountSceneLevels(source, houseLevel, preview, economy?.buildings);
  const scene = previewWorldScene(source, levels), authored = initialPreviewLevels(source);
  const previewing = preview.previewBuildings || Object.entries(preview.levels).some(([id, level]) => level !== authored[id]);
  const active = forestConstructionJob(economySceneConstruction(economy), now);
  const stations = (economy?.catalog ?? economyCatalog).buildings.filter(station => constructionMapPlace(station.id)).map(station => {
    const currentLevel = (previewing ? levels[station.id] ?? economy?.buildings[station.id] : economy?.buildings[station.id])
      ?? (station.id === "home" ? houseLevel : undefined) ?? levels[station.id] ?? 0;
    const maximum = Math.max(1, ...station.levels.map(level => level.level));
    const job: SceneConstructionJob = active?.stationId === station.id ? active : {
      id: `diagnostic:${station.id}`, stationId: station.id, targetLevel: Math.min(currentLevel + 1, maximum),
      startedAt: "1970-01-01T00:00:00.000Z", finishesAt: "1970-01-01T00:00:00.000Z",
    };
    return { id: station.id, name: station.name, currentLevel, job, confirmed: job === active };
  });
  return { scene, stations, activeStationId: active?.stationId };
}

export function BuilderWorkPointReport({ scene, station }: {
  scene: FixedWorldScene; station: ReturnType<typeof builderWorkDiagnosticContext>["stations"][number];
}) {
  const checks = builderWorkMarkerChecks(scene, station.job), first = builderWorkStops(scene, station.job)[0];
  return <>
    <p className={styles.hint}>Уровень {station.currentLevel} → {station.job.targetLevel} · {station.confirmed ? "подтверждённая стройка"
      : station.currentLevel === station.job.targetLevel ? "проверка текущего уровня" : "проверка следующего улучшения"}</p>
    {checks.length ? checks.map(marker => <section key={marker.id} className={styles.aiIntention} aria-label={marker.id}>
      <strong>{marker.id}</strong><p>{coordinates(marker.position)}</p>
      {marker.issues.length ? marker.issues.map(issue => <p key={issue} data-marker-issue={issue}>{issues[issue]}</p>)
        : <p>Физические проверки пройдены.</p>}
    </section>) : <p className={styles.hint}>В экспорте нет рабочей точки для этого здания. Место подбирается автоматически.</p>}
    <p className={styles.hint}>{first ? `Первый безопасный кандидат: ${coordinates(first.position)}. Путь может выбрать следующий.`
      : "Безопасных кандидатов нет. Проверьте точки и коллизии в Tiled."}</p>
  </>;
}

export function WorldDevBuilderPoints({ source, preview, houseLevel, economy, now }: {
  source: FixedWorldScene; preview: Preview; houseLevel?: number; economy?: EconomyView | null; now: number;
}) {
  const [selected, select] = useState<string | null>(null);
  const context = builderWorkDiagnosticContext(source, preview, houseLevel, economy, now);
  const station = context.stations.find(item => item.id === (selected ?? context.activeStationId ?? "home")) ?? context.stations[0];
  return <details className={styles.section}>
    <summary>Рабочие точки Tiled<ChevronDown size={16} aria-hidden /></summary>
    <div className={styles.sectionBody}>
      <p className={styles.hint}>Координаты загруженного экспорта. После сохранения Tiled нужен world:export или world:watch.</p>
      {station ? <>
        <label className={styles.field}><span>Здание для проверки</span>
          <select value={station.id} onChange={event => select(event.target.value)}>
            {context.stations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <BuilderWorkPointReport scene={context.scene} station={station} />
      </> : <p className={styles.hint}>В каталоге нет доступных строителю зданий.</p>}
    </div>
  </details>;
}
