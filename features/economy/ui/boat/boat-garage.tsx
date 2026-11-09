"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, ChevronRight, Clock3, Coins, Eye, Hammer, LockKeyhole, Wrench } from "lucide-react";
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
  { id: "repair", label: "Корпус", x: 56, y: 64 },
  { id: "oars", label: "Вёсла", x: 81, y: 47 },
  { id: "crate", label: "Трюм" },
];
const ownsModule = (boat: BoatState, id: GarageModuleId) => id === "repair" ? boat.level > 0 : boat.upgrades.some(value => value === id);

function upgradeEffect(id: GarageModuleId, config: BoatCatalog): { label: string; from: string; to: string; brief: string } {
  switch (id) {
    case "repair": return { label: "Состояние корпуса", from: "Повреждён", to: "Готов к выходу", brief: "Выход на воду" };
    case "oars": return { label: "Дорога в одну сторону", from: worldDuration(config.outboundSeconds), to: worldDuration(config.oarsTravelSeconds), brief: `${worldDuration(config.oarsTravelSeconds)} в пути` };
    case "crate": return { label: "Рыбы за один выход", from: String(config.maxCasts), to: String(config.maxCasts + 1), brief: `${config.maxCasts} → ${config.maxCasts + 1} за выход` };
  }
}

type Props = { state: EconomyView; boat: BoatState; config: BoatCatalog; now: number; disabled: boolean;
  onUpgrade: (id: BoatUpgradeId) => void; onClaim: (id: string) => void };

/** Selecting or comparing a module only changes the drawing, never the saved loadout. */
export function BoatGarage({ state, boat, config, now, disabled, onUpgrade, onClaim }: Props) {
  const [selected, setSelected] = useState<GarageModuleId>(() => {
    const work = boat.work?.upgradeId;
    return work === "repair" || work === "oars" || work === "crate" ? work : boat.level ? "oars" : "repair";
  });
  const [preview, setPreview] = useState(false);
  const id = useId();
  const upgrade = config.upgrades.find(entry => entry.id === selected)!;
  const installed = ownsModule(boat, selected), working = boat.work?.upgradeId === selected;
  const workReady = Boolean(boat.work && now >= Date.parse(boat.work.finishesAt));
  const workProgress = boat.work ? Math.min(1, Math.max(0, (now - Date.parse(boat.work.startedAt)) / Math.max(1, Date.parse(boat.work.finishesAt) - Date.parse(boat.work.startedAt)))) : 0;
  const reason = installed ? null : boatUpgradeReason(state, selected, now);
  const effect = upgradeEffect(selected, config);
  const completed = modules.filter(module => ownsModule(boat, module.id)).length;
  const readyForWater = boat.level > 0 && !boat.work;
  const readiness = boat.work ? workReady ? "Заберите улучшение" : "Улучшение в работе" : boat.level ? "Готова к воде" : "Нужен ремонт";
  function choose(module: GarageModuleId) { setSelected(module); setPreview(false); }
  return <section className={styles.garage} aria-label="Гараж лодки" data-boat-garage>
    <div className={styles.stage} data-boat-preview={preview && !installed ? selected : undefined}>
      <div className={styles.stageHeading}><span>ЛОДОЧНАЯ МАСТЕРСКАЯ</span><strong>{preview && !installed ? "Примерка модуля" : boat.level ? "Ваша комплектация" : "Восстановите лодку"}</strong></div>
      <span className={styles.readiness} data-ready={readyForWater || undefined}>{boat.work ? <Hammer size={13} /> : readyForWater ? <Check size={13} /> : <Wrench size={13} />}{readiness}</span>
      <div className={styles.assembly}><div className={styles.rig}>
        <BoatGarageArt repaired={boat.level > 0} crate={boat.upgrades.includes("crate")} oars={boat.upgrades.includes("oars")} selectedModule={selected} previewModule={preview && !installed ? selected : undefined} />
        <div className={styles.hotspots} aria-label="Модули на лодке">{modules.map((module, index) => module.x === undefined || module.y === undefined ? null : <button key={module.id} type="button" className={styles.hotspot} style={{ left: `${module.x}%`, top: `${module.y}%` }} aria-label={`Выбрать: ${module.label}`} aria-controls={`${id}-details`} aria-pressed={selected === module.id} onClick={() => choose(module.id)}><span>{String(index + 1).padStart(2, "0")}</span><small>{module.label}</small></button>)}</div>
      </div></div>
      <div className={styles.stageFoot}>
        <div className={styles.completion}><span className={styles.completionBars} aria-hidden="true">{modules.map(module => <i key={module.id} data-complete={ownsModule(boat, module.id) || undefined} />)}</span><span>{completed} / {modules.length} улучшений установлено</span></div>
        {!installed && selected !== "crate" && <button type="button" className={styles.preview} aria-pressed={preview} onClick={() => setPreview(value => !value)}><Eye size={14} />{preview ? "Показать текущую" : "Примерить модуль"}</button>}
      </div>
    </div>
    <div className={styles.rail}>
      <div className={styles.railHeading}><div><span>КОМПЛЕКТАЦИЯ</span><h3>Выберите улучшение</h3></div><span className={styles.wallet}><Coins size={14} /><strong>{number(state.wallet.coins)}</strong><span className={shared.srOnly}>монет в наличии</span></span></div>
      <div className={styles.modules} aria-label="Выбор модуля лодки">{modules.map((module, index) => {
        const entry = config.upgrades.find(value => value.id === module.id)!, owned = ownsModule(boat, module.id), active = boat.work?.upgradeId === module.id;
        return <button key={module.id} type="button" className={styles.module} aria-pressed={selected === module.id} aria-controls={`${id}-details`} data-boat-module={module.id} onClick={() => choose(module.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % modules.length : event.key === "ArrowLeft" ? (index + modules.length - 1) % modules.length : event.key === "Home" ? 0 : event.key === "End" ? modules.length - 1 : null;
          if (next != null) { event.preventDefault(); choose(modules[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[data-boat-module]")[next]?.focus(); }
        }}>
          <span className={styles.moduleTop}><span>{String(index + 1).padStart(2, "0")}</span><span className={styles.moduleLevel}>{owned ? "1" : "0"} / 1</span></span>
          <BoatModuleThumbnail module={module.id} className={styles.moduleImage} />
          <strong>{module.label}</strong><span className={styles.moduleBenefit}>{upgradeEffect(module.id, config).brief}</span>
          <span className={styles.modulePrice} data-installed={owned || undefined}>{owned ? <><Check size={12} />Установлено</> : active ? <><Hammer size={12} />{workReady ? "Готово" : "В работе"}</> : <><Coins size={12} />{number(entry.cost.coins)}</>}</span>
          <progress className={styles.level} value={owned ? 1 : active ? workProgress : 0} max={1} aria-label={`${module.label}: ${owned ? "установлено" : "готовность улучшения"}`} />
          <ChevronRight className={styles.cardArrow} size={15} aria-hidden="true" />
        </button>;
      })}</div>
    </div>
    <section id={`${id}-details`} className={styles.inspector} aria-labelledby={`${id}-module`} data-boat-upgrade={selected}>
      <div className={styles.inspectorTop}><span>УЛУЧШЕНИЕ {String(modules.findIndex(module => module.id === selected) + 1).padStart(2, "0")}</span><span className={styles.status} data-installed={installed || undefined}>{installed ? <><Check size={12} />Установлено</> : working ? <><Hammer size={12} />{workReady ? "Можно установить" : "В работе"}</> : "0 → 1"}</span></div>
      <h3 id={`${id}-module`}>{upgrade.name}</h3>
      <p className={styles.description}>{upgrade.description}</p>
      <div className={styles.effect}><span className={styles.effectLabel}>{effect.label}</span><div className={styles.comparison}>
        <span><small>Сейчас</small><strong>{installed ? effect.to : effect.from}</strong></span>
        {!installed && <><ArrowRight size={17} aria-hidden="true" /><span data-next><small>После улучшения</small><strong>{effect.to}</strong></span></>}
      </div></div>
      {installed ? <div className={styles.installed}><Check size={18} /><span>{selected === "crate" ? "Вместимость трюма увеличена" : "Модуль установлен на лодке"}</span></div> : working ? <div className={styles.workSlot}>
        <BoatWork boat={boat} config={config} now={now} disabled={disabled} onClaim={onClaim} />
      </div> : <div className={styles.purchase}>
        <div className={styles.costHeading}><span>Стоимость работы</span><span className={styles.duration}><Clock3 size={12} />{worldDuration(upgrade.seconds)}</span></div>
        <BoatCost state={state} cost={upgrade.cost} />
        <button type="button" className={`${shared.primary} ${styles.buy}`} disabled={disabled || Boolean(reason)} onClick={() => onUpgrade(selected)}><Hammer size={17} />{selected === "repair" ? "Восстановить лодку" : "Установить улучшение"}<ChevronRight size={17} /></button>
        {reason && <p className={styles.reason}><LockKeyhole size={12} />{reason}</p>}
      </div>}
    </section>
    {boat.work && !working && <BoatWork boat={boat} config={config} now={now} disabled={disabled} onClaim={onClaim} />}
  </section>;
}
