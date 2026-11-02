import { Check, Clock3, Hammer, LockKeyhole, Telescope } from "lucide-react";
import type { BoatCatalog, BoatState, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import { boatUpgradeReason } from "@/features/economy/domain/boat-fishing";
import type { EconomyView } from "@/features/economy/domain/model";
import { itemName, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BoatCost } from "./boat-cost";
import styles from "./boat-blueprints.module.css";

type BlueprintId = BoatCatalog["blueprints"][number]["id"];
type Props = { state: EconomyView; boat: BoatState; config: BoatCatalog; now: number; disabled: boolean;
  onUpgrade: (id: BoatUpgradeId) => void; onInspect: () => void };

const blueprintImages: Record<BlueprintId, string> = {
  landing_net: "/world/boat/blueprint-landing-net.webp",
  telescope: "/world/boat/blueprint-telescope.webp",
};

// Each edge is shared by its neighbour, so found scraps reconstruct one unbroken image.
const fragmentShapes = [
  "polygon(0 0, 37% 0, 34% 13%, 40% 26%, 34% 39%, 39% 52%, 34% 66%, 40% 78%, 35% 90%, 38% 100%, 0 100%)",
  "polygon(37% 0, 69% 0, 65% 15%, 71% 27%, 66% 40%, 71% 55%, 65% 68%, 71% 82%, 67% 92%, 69% 100%, 38% 100%, 35% 90%, 40% 78%, 34% 66%, 39% 52%, 34% 39%, 40% 26%, 34% 13%)",
  "polygon(69% 0, 100% 0, 100% 100%, 69% 100%, 67% 92%, 71% 82%, 65% 68%, 71% 55%, 66% 40%, 71% 27%, 65% 15%)",
];

function BlueprintPuzzle({ kind, name, found }: { kind: BlueprintId; name: string; found: number }) {
  const complete = found === 3;
  return <figure className={styles.board} role="img" aria-label={`${name}: найдено ${found} из 3 фрагментов${complete ? ", изображение собрано" : ""}`}
    data-blueprint-puzzle={kind} data-complete={complete || undefined}>
    <div className={styles.paper} aria-hidden="true">
      {fragmentShapes.map((shape, index) => <div key={index} className={styles.fragment} data-blueprint-fragment={index + 1}
        data-found={index < found || undefined} style={{ clipPath: shape,
          ...(index < found ? { backgroundImage: `url("${blueprintImages[kind]}")` } : {}) }} />)}
      {!complete && <div className={styles.missingMarks}>{fragmentShapes.map((_, index) => index >= found
        ? <span key={index} style={{ left: `${[17, 52, 85][index]}%` }}><span>0{index + 1}</span><small>не найден</small></span> : null)}</div>}
    </div>
    <figcaption className={styles.boardCaption}><span>{complete ? <Check size={13} /> : <LockKeyhole size={12} />}{complete ? "Схема собрана" : "Фрагменты схемы"}</span><strong>{found}<span> / 3</span></strong></figcaption>
  </figure>;
}

export function BoatBlueprints({ state, boat, config, now, disabled, onUpgrade, onInspect }: Props) {
  return <section className={styles.workbench} aria-label="Сборка чертежей">
    <div className={styles.intro}><div><span className={styles.eyebrow}>Архив находок</span><h3>Соберите схему. Создайте снаряжение.</h3></div><p>Каждый найденный обрывок открывает часть рисунка. Три фрагмента складываются в готовый чертёж.</p></div>
    <div className={styles.blueprints}>{config.blueprints.map((blueprint, index) => {
      const count = Math.max(0, Math.min(3, boat.blueprints[blueprint.id]));
      const upgrade = config.upgrades.find(entry => entry.id === blueprint.id);
      if (!upgrade) return null;
      const owned = boat.artifacts.includes(blueprint.id), complete = count === 3;
      const working = boat.work?.upgradeId === blueprint.id;
      const reason = owned ? null : boatUpgradeReason(state, blueprint.id, now);
      const nextAt = blueprint.milestones[count];
      return <article key={blueprint.id} className={styles.blueprint} data-boat-blueprint={blueprint.id} data-installed={owned || undefined}>
        <header className={styles.cardHeader}><div><span className={styles.eyebrow}>Снаряжение · 0{index + 1}</span><h3>{blueprint.name}</h3></div><span className={styles.status} data-complete={complete || undefined}>{owned ? "Установлено" : working ? "В работе" : complete ? "Собрано" : `${count} / 3`}</span></header>
        <BlueprintPuzzle kind={blueprint.id} name={blueprint.name} found={count} />
        <div className={styles.details}><p className={styles.effect}>{upgrade.description}</p>
          {owned ? <><p className={styles.installed}><Check size={16} />Изготовлено и установлено на лодке</p>{blueprint.id === "telescope" && <BoatForecast state={state} disabled={disabled} onInspect={onInspect} />}</>
            : complete ? <div className={styles.crafting}><div className={styles.craftingTitle}><Hammer size={15} /><strong>{working ? "Изготавливаем снаряжение" : "Изготовление по чертежу"}</strong><span><Clock3 size={12} />{worldDuration(upgrade.seconds)}</span></div>
              <BoatCost state={state} cost={upgrade.cost} /><button type="button" className={styles.primary} disabled={disabled || Boolean(reason)} onClick={() => onUpgrade(blueprint.id)}><Hammer size={16} />{working ? "Работа начата" : "Изготовить"}</button>
              {reason && <p className={styles.note}>{reason}</p>}</div>
              : <div className={styles.discovery}><p><strong>{count ? `Найдено ${count} из 3 фрагментов` : "Первый фрагмент ещё впереди"}</strong></p>
                <p className={styles.next}><span>Следующий фрагмент</span><strong>{boat.qualifiedVoyages >= nextAt ? "Следующий зачтённый выход" : `После ${nextAt}-го зачтённого выхода`}</strong></p>
                <p className={styles.note}>Используйте все забросы и привезите хотя бы одну рыбу. Засчитано выходов: {boat.qualifiedVoyages}.</p></div>}
        </div>
      </article>;
    })}</div>
  </section>;
}

function BoatForecast({ state, disabled, onInspect }: { state: EconomyView; disabled: boolean; onInspect: () => void }) {
  const forecast = state.ship.nextVoyage;
  return <div className={styles.forecast}>
    {!forecast ? <><button type="button" className={styles.secondary} disabled={disabled || !(state.buildings.lighthouse > 0)} onClick={onInspect}><Telescope size={17} />Посмотреть будущий груз</button>{!(state.buildings.lighthouse > 0) && <p className={styles.note}>Сначала восстановите маяк.</p>}</>
      : <><strong>Следующий корабль</strong><p className={styles.note}>Эти товары понадобятся капитану. Можно подготовить их заранее.</p>{forecast.orders.map((order, index) => <details key={order.id} open={index === 0} className={styles.forecastOrder}>
        <summary>Груз {index + 1} · {order.title}</summary><ul>{Object.entries(order.items).map(([itemId, quantity]) => <li key={itemId}><ProductIcon state={state} itemId={itemId} size={19} /><span>{itemName(state, itemId)}</span><strong>×{quantity}</strong></li>)}</ul>
      </details>)}</>}
  </div>;
}
