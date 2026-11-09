"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, Clock3, Eye, Hammer, LockKeyhole, Wrench } from "lucide-react";
import { boatUpgradeReason } from "@/features/economy/domain/boat-fishing";
import type { BoatCatalog, BoatState, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import type { EconomyView } from "@/features/economy/domain/model";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BoatGarageArt } from "./boat-garage-art";
import { BoatModuleThumbnail } from "./boat-module-thumbnail";
import { BoatCost, BoatWork } from "./boat-panels";
import shared from "./boat-fishing.module.css";
import styles from "./boat-garage.module.css";

type GarageModuleId = Extract<BoatUpgradeId, "repair" | "oars" | "crate">;
const modules: { id: GarageModuleId; label: string; x?: number; y?: number }[] = [
  { id: "repair", label: "Корпус", x: 59, y: 65 },
  { id: "oars", label: "Вёсла", x: 79, y: 57 },
  { id: "crate", label: "Трюм" },
];
const ownsModule = (boat: BoatState, id: GarageModuleId) => id === "repair" ? boat.level > 0 : boat.upgrades.some(value => value === id);

function upgradeEffect(id: GarageModuleId, config: BoatCatalog): { label: string; from: string; to: string } {
  switch (id) {
    case "repair": return { label: "Состояние корпуса", from: "Повреждён", to: "Готов к выходу" };
    case "oars": return { label: "Дорога в одну сторону", from: worldDuration(config.outboundSeconds), to: worldDuration(config.oarsTravelSeconds) };
    case "crate": return { label: "Рыбы за один выход", from: String(config.maxCasts), to: String(config.maxCasts + 1) };
  }
}

type Props = { state: EconomyView; boat: BoatState; config: BoatCatalog; now: number; disabled: boolean;
  onUpgrade: (id: BoatUpgradeId) => void; onClaim: (id: string) => void };

/** The selection/preview is local UI state; fitting a module never spends materials. */
export function BoatGarage({ state, boat, config, now, disabled, onUpgrade, onClaim }: Props) {
  const [selected, setSelected] = useState<GarageModuleId>(() => {
    const work = boat.work?.upgradeId;
    return work === "repair" || work === "oars" || work === "crate" ? work : boat.level ? "oars" : "repair";
  });
  const [preview, setPreview] = useState(false);
  const id = useId();
  const upgrade = config.upgrades.find(entry => entry.id === selected)!;
  const installed = ownsModule(boat, selected), working = boat.work?.upgradeId === selected;
  const reason = installed ? null : boatUpgradeReason(state, selected, now);
  const effect = upgradeEffect(selected, config);
  function choose(module: GarageModuleId) { setSelected(module); setPreview(false); }
  return <section className={styles.garage} aria-label="Гараж лодки" data-boat-garage>
    <div className={styles.stage} data-boat-preview={preview && !installed ? selected : undefined}>
      <div className={styles.stageHeading}><span>ЛОДОЧНАЯ МАСТЕРСКАЯ</span><strong>{preview && !installed ? "Примерка модуля" : boat.level ? "Ваша комплектация" : "Корпус под восстановление"}</strong></div>
      <div className={styles.assembly}><BoatGarageArt repaired={boat.level > 0} crate={boat.upgrades.includes("crate")} oars={boat.upgrades.includes("oars")} selectedModule={selected} previewModule={preview && !installed ? selected : undefined} /></div>
      <div className={styles.hotspots} aria-label="Модули на лодке">{modules.map((module, index) => module.x === undefined || module.y === undefined ? null : <button key={module.id} type="button" className={styles.hotspot} style={{ left: `${module.x}%`, top: `${module.y}%` }} aria-label={`Выбрать: ${module.label}`} aria-pressed={selected === module.id} onClick={() => choose(module.id)}><span>{String(index + 1).padStart(2, "0")}</span><small>{module.label}</small></button>)}</div>
      <div className={styles.stageFoot}><span><Wrench size={13} />{modules.filter(module => ownsModule(boat, module.id)).length} / {modules.length} модулей готово</span>
        {!installed && selected !== "crate" && <button type="button" className={styles.preview} aria-pressed={preview} onClick={() => setPreview(value => !value)}><Eye size={14} />{preview ? "Показать текущую" : "Примерить модуль"}</button>}</div>
    </div>
    <div className={styles.rail}>
      <div className={styles.railHeading}><h3>Комплектация</h3><span>Выберите модуль для улучшения</span></div>
      <div className={styles.modules} aria-label="Выбор модуля лодки">{modules.map((module, index) => {
        const entry = config.upgrades.find(value => value.id === module.id)!, owned = ownsModule(boat, module.id), active = boat.work?.upgradeId === module.id;
        return <button key={module.id} type="button" className={styles.module} aria-pressed={selected === module.id} aria-controls={`${id}-module`} data-boat-module={module.id} onClick={() => choose(module.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % modules.length : event.key === "ArrowLeft" ? (index + modules.length - 1) % modules.length : event.key === "Home" ? 0 : event.key === "End" ? modules.length - 1 : null;
          if (next != null) { event.preventDefault(); choose(modules[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[data-boat-module]")[next]?.focus(); }
        }}>
          <span className={styles.modulePrice}>{owned ? <><Check size={11} />Готово</> : active ? <><Hammer size={11} />В работе</> : <>{number(entry.cost.coins)} <small>монет</small></>}</span>
          <BoatModuleThumbnail module={module.id} className={styles.moduleImage} />
          <strong>{module.label}</strong><span className={styles.level} data-complete={owned || undefined} data-working={active || undefined}><i /></span>
        </button>;
      })}</div>
    </div>
    <section className={styles.inspector} aria-labelledby={`${id}-module`} data-boat-upgrade={selected}>
      <div className={styles.inspectorTop}><span>МОДУЛЬ {String(modules.findIndex(module => module.id === selected) + 1).padStart(2, "0")}</span><span className={styles.status} data-installed={installed || undefined}>{installed ? <><Check size={12} />Установлено</> : working ? <><Hammer size={12} />В работе</> : "0 / 1"}</span></div>
      <h3 id={`${id}-module`}>{upgrade.name}</h3>
      <p>{upgrade.description}</p>
      <div className={styles.effect}><small>{effect.label}</small><div>{!installed && <><span>{effect.from}</span><ArrowRight size={14} /></>}<strong>{effect.to}</strong></div></div>
      {installed ? <div className={styles.installed}><Check size={17} /><span>{selected === "crate" ? "Вместимость трюма увеличена" : "Модуль установлен на лодке"}</span></div> : working ? <p className={styles.workNote}>Работа начата. После окончания таймера установите готовый модуль.</p> : <>
        <div className={styles.purchase}><BoatCost state={state} cost={upgrade.cost} /><span className={styles.duration}><Clock3 size={13} />{worldDuration(upgrade.seconds)}</span>
          <button type="button" className={shared.primary} disabled={disabled || Boolean(reason)} onClick={() => onUpgrade(selected)}><Hammer size={16} />{selected === "repair" ? "Восстановить лодку" : "Установить улучшение"}</button>
          {reason && <p className={styles.reason}><LockKeyhole size={12} />{reason}</p>}
        </div>
      </>}
    </section>
    {boat.work && <BoatWork boat={boat} config={config} now={now} disabled={disabled} onClaim={onClaim} />}
  </section>;
}
