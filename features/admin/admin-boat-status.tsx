import { boatPhase, boatReturnsAt } from "@/features/economy/domain/boat-fishing";
import type { EconomyView } from "@/features/economy/domain/model";
import styles from "./admin-economy.module.css";

const phaseLabels = {
  broken: "Требует ремонта", repairing: "Ремонт", docked: "У берега", outbound: "Плывёт к месту ловли",
  fishing: "На рыбалке", returning: "Возвращается", ready: "Ожидает разгрузки",
};

export function AdminBoatStatus({ state, now }: { state: EconomyView; now: number }) {
  const boat = state.boat;
  if (!boat) return null;
  const phase = boatPhase(boat, now);
  const work = boat.work;
  const voyage = boat.voyage;
  const caught = voyage?.catches.length ?? 0;
  const shortfall = Math.max(0, caught - state.storage.available);
  const readyWork = work && now >= Date.parse(work.finishesAt);
  const workName = state.catalog?.boat?.upgrades.find(upgrade => upgrade.id === work?.upgradeId)?.name;
  return <section className={styles.panel} aria-label="Лодка игрока">
    <div className={styles.heading}><h3>Лодочная рыбалка</h3>
      <strong>{work ? readyWork ? "Улучшение готово" : "Идёт работа" : phaseLabels[phase]}</strong></div>
    {work && <p>{workName ?? "Работа в мастерской"} · {readyWork ? "можно забрать" : `до ${new Date(work.finishesAt).toLocaleString("ru-RU")}`}</p>}
    {voyage && <>
      <dl className={styles.facts}>
        <div><dt>Улов на борту</dt><dd>{caught} / {voyage.maxCatches}</dd></div>
        <div><dt>Забросы</dt><dd>{voyage.castsUsed} / {voyage.maxCasts}</dd></div>
        <div><dt>Свободно в кладовой</dt><dd>{state.storage.available}</dd></div>
      </dl>
      {phase === "returning" && <p>Возвращение к берегу · {new Date(boatReturnsAt(voyage)).toLocaleString("ru-RU")}</p>}
      {caught === 0 ? <p>Улов для разгрузки пока пуст.</p>
        : <p className={shortfall ? styles.warning : undefined}>{shortfall ? `Мест для разгрузки не хватает: ${shortfall}.` : "Весь улов поместится в кладовую."}</p>}
    </>}
  </section>;
}
