import { economyCatalog } from "@/features/economy/domain/model";
import { boatFishWeightLabel } from "@/features/economy/ui/boat/boat-panels";
import type { GuestProfile } from "./guest-profile-model";
import styles from "./guest-profile.module.css";

const moduleNames = { hull: "Корпус", engine: "Двигатель", tank: "Бак", storage: "Хранилище" } as const;
const itemName = (id: string) => economyCatalog.items.find(item => item.id === id)?.name ?? id;

export function GuestFishingCard({ fishing }: { fishing: NonNullable<GuestProfile["fishingSummary"]> }) {
  const catalog = economyCatalog.fishing!;
  return <section className={styles.fishing} aria-label="Лодка и рыбалка друга">
    <h4>Лодка и рыбалка</h4>
    <dl>
      <div><dt>Удочка</dt><dd>{catalog.rods.find(rod => rod.id === fishing.rodId)?.name ?? "Нет данных"}</dd></div>
      <div><dt>Крючок</dt><dd>{catalog.hooks.find(hook => hook.id === fishing.hookId)?.name ?? "Нет данных"}</dd></div>
      <div><dt>Наживка</dt><dd>{fishing.baitId ? itemName(fishing.baitId) : "Без наживки"}</dd></div>
      <div><dt>Завершено рейсов</dt><dd>{fishing.completedVoyages.toLocaleString("ru-RU")}</dd></div>
      {(Object.keys(moduleNames) as (keyof typeof moduleNames)[]).map(id => <div key={id}>
        <dt>{moduleNames[id]}</dt><dd>Ур. {fishing.modules[id]}</dd>
      </div>)}
    </dl>
    <h4>Самые тяжёлые уловы</h4>
    {fishing.records.length ? <ol>{fishing.records.map(record => <li key={record.fishId}>
      {itemName(record.fishId)} · <strong>{boatFishWeightLabel(record.weightGrams)}</strong>
    </li>)}</ol> : <p>Пока нет доставленных уловов.</p>}
  </section>;
}
