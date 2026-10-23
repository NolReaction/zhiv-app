"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, House, RefreshCw, Store, X } from "lucide-react";
import type { GuestWorld } from "@/features/people/guest-world-model";
import { economyCatalog } from "@/features/economy/domain/model";
import { WorldScene } from "@/features/world/scene/world-scene";
import type { MapObjectSelection, WorldPlace } from "@/features/world/scene/map-engine";
import { interactiveMapObjects } from "@/features/world/scene/site-interactions";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import { friendWorldJobName, friendWorldJobStatus, friendWorldScene, friendWorldStation, friendWorldStations } from "./friend-world-state";
import worldStyles from "@/features/world/world.module.css";
import styles from "./friend-world-view.module.css";

const settledArrival = { enabled: false, seen: true, onComplete() {} };
export type FriendWorldViewProps = { visit: GuestWorld; now: number; timeZone: string;
  onReturn: () => void; onOpenShop: () => void; onRefresh?: () => void; refreshing?: boolean; suspended?: boolean; onReady?: () => void };

/** One real map, fed only the host's public projection and no account command controller. */
export function FriendWorldView({ visit, now, timeZone, onReturn, onOpenShop, onRefresh, refreshing = false, suspended = false, onReady }: FriendWorldViewProps) {
  const scene = useMemo(() => friendWorldScene(visit), [visit]);
  const topHud = useRef<HTMLElement>(null), bottomHud = useRef<HTMLElement>(null), returnButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { returnButton.current?.focus({ preventScroll: true }); }, [visit.user.publicId]);
  const [selected, setSelected] = useState<{ objectId: string; place: WorldPlace } | null>(null);
  const selectedObject = useMemo(() => interactiveMapObjects(TILED_WORLD).find(object => object.id === selected?.objectId), [selected?.objectId]);
  const station = selected ? friendWorldStation(selected.place) : null;
  const stations = selected ? friendWorldStations(selected.place) : [];
  const building = economyCatalog.buildings.find(item => item.id === station);
  const onPlace = useCallback((place: WorldPlace, selection?: MapObjectSelection) => {
    if (place === "market") { onOpenShop(); return; }
    setSelected(selection ? { objectId: selection.objectId, place } : null);
  }, [onOpenShop]);
  const onSelection = useCallback((selection: MapObjectSelection | null) => {
    setSelected(previous => !selection ? null : previous?.objectId === selection.objectId ? previous : { objectId: selection.objectId, place: selection.place });
  }, []);
  return <section className={`${worldStyles.world} ${styles.visit}`} data-friend-world={visit.user.publicId} aria-label={`Мир ${visit.user.displayName}`}>
    <WorldScene key={visit.user.publicId} readOnly state={scene.state} gifts={scene.gifts} economyBuildings={scene.buildings}
      economyProduction={scene.production} economyConstruction={scene.construction} economyResidents={scene.residents}
      economyJourney={scene.journey} economyGarden={scene.garden}
      residentArrival={settledArrival} lopukhArrival={settledArrival} merchantArrival={settledArrival}
      owner={visit.user.publicId} timeZone={timeZone} now={now} bestStreakDays={0} wakeSignal={0}
      topHud={topHud} bottomHud={bottomHud} onPlace={onPlace} onObjectSelection={onSelection}
      selectedObjectId={selected?.objectId ?? null} suspended={suspended} hideJourneyStatus onReady={onReady} />
    <header ref={topHud} className={styles.header} data-world-hud>
      <button ref={returnButton} type="button" id="friend-world-return" onClick={onReturn} aria-label="Вернуться в свой лес"><ArrowLeft size={20} aria-hidden="true" /></button>
      <div className={styles.owner}><span>В гостях</span><h2>{visit.user.displayName}</h2></div>
      {onRefresh && <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Обновить мир друга"><RefreshCw size={18} aria-hidden="true" /></button>}
      <span className={styles.level} aria-label={`Дом уровня ${scene.state.houseLevel}`}><House size={16} aria-hidden="true" />{scene.state.houseLevel}</span>
    </header>
    <footer ref={bottomHud} className={styles.footer} data-world-hud>
      {selectedObject && <aside className={styles.object} aria-label={selectedObject.label}>
        <div className={styles.objectHeading}><div><span>Хозяйство друга</span><h3>{building?.name ?? selectedObject.label}</h3></div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Закрыть сведения об объекте"><X size={18} aria-hidden="true" /></button></div>
        {stations.map(stationId => <FriendWorldStationInfo key={stationId} visit={visit} stationId={stationId} now={now} titled={stations.length > 1} />)}
      </aside>}
      <button type="button" className={styles.shop} onClick={onOpenShop}><Store size={19} aria-hidden="true" /><span>Лавка игрока</span><span className={styles.lotCount}>{visit.market.listings.length}</span></button>
    </footer>
  </section>;
}

/** Public station details deliberately have no economy command controller. */
export function FriendWorldStationInfo({ visit, stationId, now, titled = false }: { visit: GuestWorld; stationId: string; now: number; titled?: boolean }) {
  const building = economyCatalog.buildings.find(item => item.id === stationId);
  const jobs = visit.world.jobs.filter(job => job.targetId === stationId);
  const level = visit.world.buildings[stationId] ?? 0;
  return <section className={titled ? styles.station : undefined} data-guest-station={stationId}
    aria-label={titled ? stationId === "workshop" ? "Верстак" : building?.name ?? stationId : undefined}>
    {titled && <h4 className={styles.stationName}>{stationId === "workshop" ? "Верстак" : building?.name ?? stationId}</h4>}
    {building && <p className={styles.buildingLevel}>{level > 0 ? `Уровень ${level}` : "Ещё не построено"}</p>}
    {jobs.length > 0 ? <ul className={styles.jobs}>{jobs.map(job => <li key={job.id}><span>{friendWorldJobName(job)}</span><strong>{friendWorldJobStatus(job, now)}</strong></li>)}</ul>
      : <p className={styles.quiet}><Eye size={15} aria-hidden="true" />Вы осматриваете мир друга</p>}
  </section>;
}
