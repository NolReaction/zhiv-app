"use client";

import { useId, useState, type ReactNode } from "react";
import { ArrowRight, Check, Clock3, Hammer, LockKeyhole, Wrench } from "lucide-react";
import { boatFuelStatus, boatModules, boatModuleUpgrade, boatUpgradeReason } from "@/features/economy/domain/boat-fishing";
import type { BoatCatalog, BoatState, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import type { EconomyView } from "@/features/economy/domain/model";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BoatGarageArt } from "./boat-garage-art";
import { BoatModuleThumbnail } from "./boat-module-thumbnail";
import { BoatCost, BoatWork } from "./boat-panels";
import shared from "./boat-fishing.module.css";
import styles from "./boat-garage.module.css";

const modules = [
  { id: "engine", label: "Двигатель", marker: { x: 8, y: 27 } },
  { id: "tank", label: "Бак", marker: { x: 31, y: 24 } },
  { id: "hull", label: "Корпус", marker: { x: 68, y: 58 } },
  { id: "storage", label: "Хранилище", marker: null },
] as const;
type ModuleId = typeof modules[number]["id"];
const effectLabels = { engine: "Отклик снасти", tank: "Ячеек бензина", hull: "Контроль рыбы", storage: "Рыб за один выход" };

function effectValue(module: ModuleId, level: number, config: BoatCatalog) {
  const value = config.moduleEffects[module][level];
  switch (module) {
    case "hull": return level === 0 ? "Повреждён" : level === 1 ? "На плаву" : `На ${value}% спокойнее`;
    case "engine": return value === 0 ? "Штатный" : `Усиление ${value}`;
    case "storage": return String(value);
    case "tank": return String(value);
  }
}

function workDuration(seconds: number) {
  return seconds < 60 ? `${seconds} с` : worldDuration(seconds);
}

type Props = { state: EconomyView; boat: BoatState; config: BoatCatalog; now: number; disabled: boolean; children?: ReactNode;
  onUpgrade: (id: BoatUpgradeId) => void; onClaim: (id: string) => void };

export function BoatGarage({ state, boat, config, now, disabled, children, onUpgrade, onClaim }: Props) {
  const levels = boatModules(boat);
  const workModule = config.upgrades.find(entry => entry.id === boat.work?.upgradeId)?.module;
  const [selected, setSelected] = useState<ModuleId>(workModule ?? (levels.hull ? "engine" : "hull"));
  const id = useId();
  const upgrade = boatModuleUpgrade(boat, selected, config);
  const level = levels[selected], working = Boolean(boat.work && workModule === selected);
  const workReady = Boolean(boat.work && now >= Date.parse(boat.work.finishesAt));
  const reason = upgrade && !working ? boatUpgradeReason(state, upgrade.id, now) : null;
  const hasFuel = boatFuelStatus(boat, now, config).cells > 0;
  const readiness = boat.work ? workReady ? "Заберите улучшение" : "Улучшение в работе"
    : !levels.hull ? "Нужен ремонт" : hasFuel ? "Готова к воде" : "Бак пуст";
  const selectedLabel = modules.find(module => module.id === selected)!.label;
  const isFree = Boolean(upgrade && upgrade.cost.coins === 0 && !Object.values(upgrade.cost.items).some(Boolean));
  return <section className={styles.garage} aria-label="Гараж лодки" data-boat-garage>
    <div className={styles.stage}>
      <span className={styles.readiness} data-ready={!boat.work && levels.hull > 0 && hasFuel || undefined}>
        {boat.work ? <Hammer size={13} /> : levels.hull && hasFuel ? <Check size={13} /> : <Wrench size={13} />}{readiness}
      </span>
      <div className={styles.assembly}><div className={styles.rig}>
        <BoatGarageArt repaired={levels.hull > 0} modules={levels} selectedModule={selected === "hull" ? "repair" : selected === "storage" ? undefined : selected} />
        <div className={styles.hotspots} aria-label="Модули на лодке">{modules.map(module => module.marker && <button
          key={module.id} type="button" className={styles.hotspot} style={{ left: `${module.marker.x}%`, top: `${module.marker.y}%` }}
          aria-label={`Выбрать: ${module.label}`} aria-controls={`${id}-details`} aria-pressed={selected === module.id} onClick={() => setSelected(module.id)}>
          <span aria-hidden="true" /><small>{module.label}</small>
        </button>)}</div>
      </div></div>
    </div>
    {children && <div className={styles.dock}>{children}</div>}
    <div className={styles.rail}>
      <h3>Улучшения лодки</h3>
      <div className={styles.modules} aria-label="Выбор модуля лодки">{modules.map((module, index) => {
        const owned = levels[module.id], next = boatModuleUpgrade(boat, module.id, config);
        return <button key={module.id} type="button" className={styles.module} aria-pressed={selected === module.id} aria-controls={`${id}-details`}
          data-boat-module={module.id} onClick={() => setSelected(module.id)} onKeyDown={event => {
            const nextIndex = event.key === "ArrowRight" ? (index + 1) % modules.length : event.key === "ArrowLeft" ? (index + modules.length - 1) % modules.length : event.key === "Home" ? 0 : event.key === "End" ? modules.length - 1 : null;
            if (nextIndex != null) { event.preventDefault(); setSelected(modules[nextIndex].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[data-boat-module]")[nextIndex]?.focus(); }
          }}>
          <BoatModuleThumbnail module={module.id} level={owned} className={styles.moduleImage} />
          <strong>{module.label}</strong>
          <span className={styles.tier}>Ур. {owned} / {config.moduleEffects[module.id].length - 1}</span>
          <span className={styles.level} aria-hidden="true">{config.moduleEffects[module.id].slice(1).map((_, i) => <i key={i} data-complete={i < owned || undefined} />)}</span>
          <span className={styles.cardHint}>{workModule === module.id ? workReady ? "Забрать" : "В работе" : !next ? "Максимум" : next.cost.coins ? `${number(next.cost.coins)} мон.` : "Бесплатно"}</span>
        </button>;
      })}</div>
    </div>
    <section id={`${id}-details`} className={styles.inspector} aria-labelledby={`${id}-module`} data-boat-upgrade={selected}>
      <div className={styles.inspectorTop}><h3 id={`${id}-module`}>{selectedLabel}</h3>
        <span>{working ? workReady ? "Можно установить" : "В работе" : upgrade ? `Ур. ${level} → ${upgrade.tier}` : "Максимум"}</span></div>
      {upgrade && <p className={styles.description}>{upgrade.description}</p>}
      <div className={styles.effect}><small>{effectLabels[selected]}</small><div><span>{effectValue(selected, level, config)}</span>
        {upgrade && <><ArrowRight size={14} aria-label="После улучшения" /><strong>{effectValue(selected, level + 1, config)}</strong></>}
      </div></div>
      {working ? <BoatWork boat={boat} config={config} now={now} disabled={disabled} onClaim={onClaim} /> : upgrade && <>
        <div className={styles.costHeading}><span>Материалы и работа</span><span><Clock3 size={13} />{workDuration(upgrade.seconds)}</span></div>
        {isFree ? <p className={styles.free}>Бесплатно</p> : <BoatCost state={state} cost={upgrade.cost} />}
        <button type="button" className={`${shared.primary} ${styles.buy}`} disabled={disabled || Boolean(reason)} onClick={() => onUpgrade(upgrade.id)}>
          <Hammer size={16} />{upgrade.id === "repair" ? "Восстановить лодку" : "Установить улучшение"}</button>
        {reason && <p className={styles.reason}><LockKeyhole size={12} />{reason}</p>}
      </>}
    </section>
    {boat.work && !working && <BoatWork boat={boat} config={config} now={now} disabled={disabled} onClaim={onClaim} />}
  </section>;
}
