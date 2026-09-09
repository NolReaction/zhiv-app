"use client";
import { useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronRight, Clock3, Expand, Hammer, Leaf, Move, Package, Pickaxe, Trees, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { WorldController } from "@/features/world/use-world";
import { WORLD_ART } from "@/features/world/art";
import { SettlementMap } from "./settlement-map";
import { areaBounds, buildingInfo, canPay, canPlace, gatherRewards, newSettlement, settlementCatalog as catalog, storageCapacity, type BuildingKind, type Materials } from "./model";
import type { Placement } from "./scene";
import styles from "./settlement.module.css";

type Props = { open: boolean; onClose: () => void; returnFocus: () => void; world: WorldController };
function Cost({ cost }: { cost: Materials }) {
  return <span className={styles.cost}><span><Trees size={15} aria-hidden="true" />{cost.wood}<span className={styles.sr}> древесины</span></span><span><Pickaxe size={15} aria-hidden="true" />{cost.stone}<span className={styles.sr}> камня</span></span></span>;
}
export default function SettlementPortal({ open, onClose, returnFocus, world }: Props) {
  const [selected, setSelected] = useState<BuildingKind | null>(null), [placement, setPlacement] = useState<Placement | null>(null);
  const [awaitingPlacement, setAwaitingPlacement] = useState(false);
  const [initial] = useState(newSettlement);
  const state = world.snapshot?.state.settlement ?? initial;
  const { min, size } = areaBounds(state.areaLevel), capacity = storageCapacity(state), nextArea = catalog.areas.find(area => area.level === state.areaLevel + 1);
  const locked = world.busy || world.uncertain || !world.snapshot;
  const current = state.buildings.find(building => building.kind === selected);
  const gather = state.gathering, remaining = gather ? Math.max(0, Math.ceil((Date.parse(gather.finishesAt) - world.now) / 1000)) : 0;
  const rewards = gather?.rewards ?? gatherRewards(state), full = state.resources.wood >= capacity && state.resources.stone >= capacity;
  const validPlacement = placement ? canPlace(state, placement.x, placement.y, placement.moving ? placement.kind : undefined) : false;
  // Reconcile this component's draft with the account session before painting.
  // An interrupted command remains pending through closing and reopening.
  if (awaitingPlacement && !world.busy && !world.uncertain) {
    setAwaitingPlacement(false);
    if (world.notice && !world.error) setPlacement(null);
  }
  const choosePlacement = (kind: BuildingKind, moving = false) => {
    const item = state.buildings.find(building => building.kind === kind);
    let x = item?.x ?? min, y = item?.y ?? min;
    if (!moving) {
      const spots = Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10) }));
      const free = spots.find(spot => canPlace(state, spot.x, spot.y)); if (free) { x = free.x; y = free.y; }
    }
    setSelected(kind); setPlacement({ kind, moving, x, y });
  };
  const position = (x: number, y: number) => setPlacement(value => value ? { ...value, x, y } : null);
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <DialogPortal><DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.portal}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}
        onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("settlement-exit")?.focus(); }}>
        <DialogDescription className={styles.sr}>Обустройте отдельную лесную поляну: разместите мастерскую и склад, улучшайте постройки и открывайте новые участки.</DialogDescription>
        <header className={styles.header}>
          <button type="button" id="settlement-exit" aria-label="Домой" className={styles.back} onClick={onClose}><ArrowLeft size={20} /><span>Домой</span></button>
          <div className={styles.title}><span>ТВОЁ ПОСЕЛЕНИЕ</span><DialogTitle>Лесная поляна</DialogTitle></div>
          <span className={styles.level}><Leaf size={16} />Ур. {state.areaLevel}</span>
        </header>
        {!world.snapshot ? <div className={styles.loading} role="status"><Leaf size={34} /><p>{world.error || "Открываем вашу поляну…"}</p>{world.error && <button type="button" onClick={() => void world.retry()}>Повторить</button>}</div> : <div className={styles.layout}>
          <section className={styles.field} aria-label="Территория поселения">
            <div className={styles.resources} aria-label="Запасы материалов">
              <div><Trees aria-hidden="true" /><span><small>Древесина</small><strong>{state.resources.wood}<em> / {capacity}</em></strong></span></div>
              <div><Pickaxe aria-hidden="true" /><span><small>Камень</small><strong>{state.resources.stone}<em> / {capacity}</em></strong></span></div>
            </div>
            <div className={styles.fieldStatus}><span className={styles.dot} />{size} × {size} открытых клеток <span>·</span> {state.buildings.length} / 2 постройки</div>
            <SettlementMap state={state} selected={selected} placement={placement}
              onSelect={kind => { setSelected(kind); setPlacement(null); }} onPosition={position} />
            <div className={styles.fieldFooter}><Leaf size={15} /><span>{state.areaLevel === 3 ? "Вся земля внутри ограды открыта" : "Светлая земля открыта для строительства"}</span></div>
          </section>
          <aside className={styles.sidebar} aria-label="Обустройство поляны">
            <div className={styles.sidebarHeading}><span>ОБУСТРОЙСТВО</span><h2>{placement ? "Выбрать место" : "Всё начинается здесь"}</h2></div>
            {(world.error || world.uncertain) && <div className={styles.error} role="alert"><p>{world.error || "Проверяем сохранение действия."}</p><button type="button" disabled={world.busy} onClick={() => void world.retry()}>Проверить и повторить</button></div>}
            {world.notice && !world.error && <p key={world.feedbackAt} className={styles.notice} role="status"><Check size={17} />{world.notice}</p>}
            {placement ? <section className={styles.placement}>
              <div className={styles.cardTitle}>{placement.kind === "workshop" ? <Hammer size={20} /> : <Package size={20} />}<h3>{buildingInfo(placement.kind).name}</h3><button type="button" aria-label="Отменить размещение" disabled={world.busy} onClick={() => setPlacement(null)}><X size={18} /></button></div>
              <p>Площадка 2 × 2 клетки. Нажмите на землю или используйте стрелки.</p>
              <div className={styles.positionControls}>
                <button type="button" aria-label="Сдвинуть по X назад" disabled={placement.x === 0 || locked} onClick={() => position(placement.x - 1, placement.y)}><ArrowLeft size={19} /></button>
                <button type="button" aria-label="Сдвинуть по Y назад" disabled={placement.y === 0 || locked} onClick={() => position(placement.x, placement.y - 1)}><ArrowUp size={19} /></button>
                <span aria-live="polite">{placement.x + 1} : {placement.y + 1}</span>
                <button type="button" aria-label="Сдвинуть по Y вперёд" disabled={placement.y >= 8 || locked} onClick={() => position(placement.x, placement.y + 1)}><ArrowDown size={19} /></button>
                <button type="button" aria-label="Сдвинуть по X вперёд" disabled={placement.x >= 8 || locked} onClick={() => position(placement.x + 1, placement.y)}><ArrowRight size={19} /></button>
              </div>
              <p className={validPlacement ? styles.valid : styles.invalid} aria-live="polite">{validPlacement ? "Место свободно" : "Здесь занято или земля ещё не открыта"}</p>
              <button type="button" className={styles.primary} disabled={locked || !validPlacement || !placement.moving && !canPay(state.resources, buildingInfo(placement.kind))}
                onClick={() => { world.act(placement.moving ? "settlement_move" : "settlement_build", `${placement.kind}:${placement.x}:${placement.y}`); setAwaitingPlacement(true); }}>
                {world.busy ? "Сохраняем…" : placement.moving ? "Перенести сюда" : "Поставить"}{!placement.moving && <Cost cost={buildingInfo(placement.kind)} />}
              </button>
            </section> : <>
              <div className={styles.buildings}>{catalog.buildings.map(info => {
                const kind = info.kind as BuildingKind, building = state.buildings.find(item => item.kind === kind), active = selected === kind;
                return <button type="button" key={kind} className={styles.buildingCard} data-selected={active} onClick={() => setSelected(kind)} aria-pressed={active}>
                  <span className={styles.buildingThumb} aria-hidden="true" style={{ backgroundImage: `url(${WORLD_ART.settlement.buildings})`, backgroundPosition: `${building?.level === 2 ? "100%" : "0%"} ${kind === "storehouse" ? "100%" : "0%"}` }} />
                  <span><strong>{info.name}</strong><small>{building ? `Уровень ${building.level} из 2` : "Можно построить"}</small></span><ChevronRight size={17} />
                </button>;
              })}</div>
              {selected ? <section className={styles.details}>
                <div className={styles.cardTitle}>{selected === "workshop" ? <Hammer size={20} /> : <Package size={20} />}<h3>{buildingInfo(selected).name}</h3></div>
                <p>{selected === "workshop" ? "Инструменты для обустройства. Второй уровень увеличивает сбор: 30 древесины и 18 камня за выход к опушке." : "Место для запасов. Первый уровень вмещает по 400 материалов, второй — по 800."}</p>
                {current ? <>
                  {current.level === 1 ? <button type="button" className={styles.primary} disabled={locked || !canPay(state.resources, { wood: buildingInfo(selected).upgradeWood, stone: buildingInfo(selected).upgradeStone })} onClick={() => world.act("settlement_upgrade", selected)}>
                    Улучшить до ур. 2<Cost cost={{ wood: buildingInfo(selected).upgradeWood, stone: buildingInfo(selected).upgradeStone }} /></button> : <p className={styles.complete}><Check size={16} />Все улучшения открыты</p>}
                  <button type="button" className={styles.secondary} disabled={locked} onClick={() => choosePlacement(selected, true)}><Move size={16} />Переставить</button>
                </> : <button type="button" className={styles.primary} disabled={locked || !canPay(state.resources, buildingInfo(selected))} onClick={() => choosePlacement(selected)}>Выбрать место<Cost cost={buildingInfo(selected)} /></button>}
              </section> : <p className={styles.guide}>{state.buildings.length ? "Выберите постройку, чтобы улучшить или переставить её." : "Для первого обустройства уже есть запас материалов. Начните с мастерской или склада."}</p>}
            </>}
            <section className={styles.expansion}><div className={styles.sectionTitle}><Expand size={18} /><h3>Больше места</h3><span>{size} × {size}</span></div>
              {nextArea ? <><p>Откройте землю до {nextArea.size} × {nextArea.size} клеток внутри ограды.</p><button type="button" className={styles.secondary} disabled={locked || Boolean(placement) || !canPay(state.resources, nextArea)} onClick={() => world.act("settlement_expand")}><span>Расширить поляну</span><Cost cost={nextArea} /></button></> : <p className={styles.complete}><Check size={16} />Вся территория открыта</p>}
            </section>
            <section className={styles.gathering}><div className={styles.sectionTitle}><Trees size={18} /><h3>У опушки</h3><span><Clock3 size={13} />1 мин</span></div>
              <p>{gather ? remaining ? "Собираем материалы. Можно вернуться позже." : "Всё готово. Материалы ждут вас." : "Древесина и камень для следующих улучшений."}</p>
              <button type="button" className={gather && !remaining ? styles.primary : styles.secondary} disabled={locked || Boolean(gather && remaining) || !gather && full}
                onClick={() => gather ? world.act("settlement_claim", gather.id) : world.act("settlement_gather")}>
                <span>{gather ? remaining ? `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "Забрать материалы" : full ? "Запасы заполнены" : "Собрать материалы"}</span><Cost cost={rewards} />
              </button>
              {gather && <progress aria-label="Сбор материалов" max={catalog.gatherSeconds} value={catalog.gatherSeconds - remaining} />}
            </section>
          </aside>
        </div>}
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
