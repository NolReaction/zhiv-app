import { ArrowRight, Clock3, Fish, Fuel, Wrench } from "lucide-react";
import { boatFuelStatus, boatModules, boatPhase, boatState } from "@/features/economy/domain/boat-fishing";
import type { EconomyView } from "@/features/economy/domain/model";
import { BoatArt } from "@/features/economy/ui/boat/boat-art";
import { BoatCountdown } from "@/features/economy/ui/boat/boat-countdown";
import styles from "./world-expeditions-menu.module.css";

const phaseLabels = {
  broken: "Восстановить бесплатно", docked: "Снарядить лодку", repairing: "Работа в мастерской",
  outbound: "По пути к плёсу", fishing: "Продолжить рыбалку", returning: "Лодка возвращается", ready: "Завершить выход",
} as const;

export function BoatActivityPreview({ state, now, readClock, recovery }: { state: EconomyView; now: number; readClock?: () => number; recovery: boolean }) {
  const boat = boatState(state), levels = boatModules(boat), config = state.catalog.boat;
  const phase = boatPhase(boat, now), voyage = boat.voyage;
  const workUntil = boat.work ? Date.parse(boat.work.finishesAt) : null;
  const action = workUntil !== null ? workUntil > now ? "Работа в мастерской" : "Забрать улучшение"
    : phase === "ready" && voyage?.catches.length ? "Забрать улов" : phaseLabels[phase];
  const fuel = !recovery && config?.moduleEffects && levels.hull ? boatFuelStatus(boat, now, config) : null;
  const installed = Object.values(levels).reduce((sum, value) => sum + value, 0);
  const total = config?.upgrades.filter(step => step.module).length ?? 0;
  return <>
    <span className={styles.boatLettering}>
      <strong>{recovery ? "Возвращение к причалу" : "Лодочная рыбалка"}</strong>
      <span className={styles.boatAction}><span>{action}{workUntil !== null && workUntil > now && <> · <BoatCountdown until={workUntil} now={now} readClock={readClock} /></>}</span><ArrowRight size={15} aria-hidden="true" /></span>
      <span className={styles.boatStats}>
        {voyage ? <span><Fish size={13} aria-hidden="true" />На борту {voyage.catches.length}/{voyage.maxCatches}</span>
          : !recovery && total > 0 && <span><Wrench size={13} aria-hidden="true" />Улучшения {installed}/{total}</span>}
        {fuel && <span><Fuel size={13} aria-hidden="true" />Бензин {fuel.cells}/{fuel.capacity}
          {fuel.nextAt !== null && <span className={styles.fuelCountdown} title="До следующей ячейки бензина"><Clock3 size={11} aria-hidden="true" /><span className="sr-only">До следующей ячейки </span><BoatCountdown until={fuel.nextAt} now={now} readClock={readClock} /></span>}
        </span>}
      </span>
    </span>
    <span className={styles.boatIllustration} aria-hidden="true">
      <BoatArt repaired={levels.hull > 0} modules={levels} net={boat.artifacts.includes("landing_net")} telescope={boat.artifacts.includes("telescope")} />
    </span>
  </>;
}
