import { ClipboardList, Hammer, RefreshCw } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { canStartTutorialWorkshop, workshopStarterCost } from "@/features/economy/domain/workshop-starter";
import { tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { WORLD_CHARACTERS } from "@/features/world/characters/world-characters-model";
import styles from "./world-onboarding.module.css";

/** A quote from the shared catalog, never a receipt or an optimistic balance. */
export function WorkshopConstructionContents({ economy }: { economy: EconomyController }) {
  const snapshot = economy.snapshot;
  if (!snapshot || (snapshot.buildings.workshop ?? 0) > 0
    || snapshot.jobs.some(job => job.kind === "construction" && job.targetId === "workshop")) return null;
  const cost = workshopStarterCost(snapshot.catalog);
  return <div className={styles.starter} data-guide-workshop-cost>
    <Hammer size={18} aria-hidden="true" />
    <span><strong>{canStartTutorialWorkshop(snapshot) ? "Учебный набор Шишколапа" : "Стоимость первой мастерской"}</strong>
      <small>{cost.coins.toLocaleString("ru-RU")} монет{Object.entries(cost.items).map(([id, amount]) =>
        ` · ${snapshot.catalog.items.find(item => item.id === id)?.name ?? id}: ${amount}`).join("")}</small>
      {canStartTutorialWorkshop(snapshot) && <small>Весь набор пойдёт прямо в стройку. Твои запасы останутся в кладовой.</small>}
    </span>
  </div>;
}

/** The same explicit action can live in the coach footer without being clipped by its copy. */
export function tutorialWorkshopAction(economy: EconomyController, isOnline?: boolean) {
  const snapshot = economy.snapshot;
  if (!snapshot || !canStartTutorialWorkshop(snapshot)) return undefined;
  const locked = isOnline === false || economy.busy || economy.uncertain || economy.retryAt > economy.now
    || snapshot.jobs.some(job => job.kind === "construction");
  return { label: "Построить с учебным набором", disabled: locked,
    onClick: () => { if (!locked) void economy.act("start_tutorial_workshop", "workshop"); } };
}

/** One explicit construction command; the server earmarks the kit for this job. */
export function WorkshopTutorialConstruction({ economy, isOnline }: { economy: EconomyController; isOnline?: boolean }) {
  const action = tutorialWorkshopAction(economy, isOnline);
  if (!action) return null;
  return <button type="button" className={styles.build} data-guide-workshop-start disabled={action.disabled} onClick={action.onClick}>
    <Hammer size={16} aria-hidden="true" />Построить с учебным набором
  </button>;
}

/** Reusable detailed introduction only lists residents the player has already met. */
export function NeighborIntroduction({ economy, quarryBuilt = false, leaftailAvailable = false }: {
  economy: EconomyController; quarryBuilt?: boolean; leaftailAvailable?: boolean;
}) {
  if (!economy.snapshot) return null;
  const roles = {
    builder: "строит и улучшает здания",
    plesk: "помогает с рыбалкой и торгует снастями",
    lopukh: "лесоруб, у его дома получают брёвна",
    kamneshmyg: "шахтёр, работает в каменоломне",
    leaftail: "торговец находками",
  };
  return <ul className={styles.neighbors} aria-label="Жители леса и знакомство с ними">
    {WORLD_CHARACTERS.filter(character => character.id !== "kamneshmyg" || quarryBuilt)
      .filter(character => character.id !== "leaftail" || leaftailAvailable).map(character => <li key={character.id} data-guide-neighbor={character.id}>
      <strong>{character.name}</strong> - {roles[character.id]}.
    </li>)}
  </ul>;
}

/** Requirements from the actual pinned request; ingredients come from the player's stock. */
export function TutorialOrderContents({ economy }: { economy: EconomyController }) {
  const snapshot = economy.snapshot;
  if (!snapshot) return null;
  const order = tutorialResidentOrder(snapshot);
  if (!order) return null;
  return <div className={styles.starter} data-guide-order-starter>
    <ClipboardList size={18} aria-hidden="true" />
    <span><strong>Припасы для учебного заказа</strong>
      <small>{Object.entries(order.items).map(([id, amount]) => `${snapshot.catalog.items.find(item => item.id === id)?.name ?? id}: ${amount}`).join(" · ")}</small>
    </span>
  </div>;
}

export function WorkshopRetry({ economy, isOnline }: { economy: EconomyController; isOnline?: boolean }) {
  if (!economy.uncertain && !economy.error) return null;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  return <button type="button" className={styles.retry} disabled={economy.busy || cooldown > 0 || isOnline === false}
    onClick={() => void economy.retry()}><RefreshCw size={14} aria-hidden="true" />
    {cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить запрос"}
  </button>;
}
