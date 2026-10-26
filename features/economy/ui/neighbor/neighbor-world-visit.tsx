"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, House, RefreshCw, Store, X } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { NeighborView } from "@/features/economy/domain/neighbor-model";
import { WorldScene } from "@/features/world/scene/world-scene";
import type { MapObjectSelection, WorldPlace } from "@/features/world/scene/map-engine";
import { readOnlyWorldScene, friendWorldStations } from "@/features/world/ui/visits/friend-world-state";
import { WorldVisitStatus } from "@/features/world/ui/visits/world-visit-status";
import { useMarketAudio } from "@/features/world/audio/use-market-audio";
import { NeighborShopDialog, NeighborStationInfo } from "./neighbor-dialog";
import worldStyles from "@/features/world/world.module.css";
import visitStyles from "@/features/world/ui/visits/world-visit-shell.module.css";
import styles from "@/features/world/ui/visits/friend-world-view.module.css";

const settledArrival = { enabled: false, seen: true, onComplete() {} };
type Props = { ownerPublicId: string; economy: EconomyController; isOnline?: boolean; suspended?: boolean;
  timeZone: string; onReturn: () => void; onSceneReady?: () => void };

/** A world character shares the full-screen visit surface, without a fabricated player relationship. */
export function NeighborWorldVisit(props: Props) {
  if (props.isOnline === false) return <WorldVisitStatus text="Нужен интернет, чтобы прийти в гости." offline onReturn={props.onReturn} />;
  if (props.suspended) return <WorldVisitStatus text="Визит приостановлен. Вернитесь в игру, чтобы продолжить." onReturn={props.onReturn} />;
  return <LoadedNeighborVisit key={props.ownerPublicId} {...props} />;
}

function LoadedNeighborVisit({ ownerPublicId, economy, timeZone, onReturn, onSceneReady }: Props) {
  const neighbor = economy.neighbor?.ownerPublicId === ownerPublicId ? economy.neighbor : null;
  const [refreshing, setRefreshing] = useState(false), [shopOpen, setShopOpen] = useState(false);
  const active = useRef(true), expiredCycle = useRef<string | null>(null), shopReturn = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const refresh = economy.refreshNeighbor;
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = useCallback(async () => {
    if (!active.current) return;
    setRefreshing(true);
    try { await refresh(); } finally { if (active.current) setRefreshing(false); }
  }, [refresh]);
  useEffect(() => {
    const kickoff = setTimeout(() => { void load(); }, 0);
    const visible = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(kickoff); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  useEffect(() => {
    if (!neighbor || refreshing || economy.busy || economy.uncertain || document.hidden
      || economy.now < Date.parse(neighbor.shop.refreshAt) || expiredCycle.current === neighbor.shop.cycleId) return;
    expiredCycle.current = neighbor.shop.cycleId;
    void load();
  }, [neighbor, refreshing, economy.busy, economy.uncertain, economy.now, load]);
  const hasData = Boolean(neighbor);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(hasData ? "#friend-world-return" : "[data-guest-return]")?.focus({ preventScroll: true });
  }, [hasData]);
  useMarketAudio({ active: shopOpen && hasData, ownerPublicId: "world-character:berest", now: economy.now, timeZone, readOnly: true });
  return <div ref={root} className={visitStyles.visit} data-world-character-visit="berest">
    {neighbor ? <>
      <NeighborWorld neighbor={neighbor} now={economy.now} timeZone={timeZone} suspended={shopOpen} onReturn={onReturn}
        onReady={onSceneReady} refreshing={refreshing} onRefresh={load} onShop={() => {
          shopReturn.current = document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)
            ? document.activeElement : null;
          setShopOpen(true); void load();
        }} />
      <NeighborShopDialog open={shopOpen} neighbor={neighbor} economy={economy} timeZone={timeZone} refreshing={refreshing}
        onRefresh={load} onClose={() => setShopOpen(false)} onReturnFocus={() => {
          if (shopReturn.current?.isConnected) shopReturn.current.focus({ preventScroll: true });
          else root.current?.querySelector<HTMLElement>("#friend-world-return")?.focus({ preventScroll: true });
        }} />
    </> : <WorldVisitStatus text={economy.neighborError ?? "Идём в гости к лесному соседу…"}
      loading={!economy.neighborError} onReturn={onReturn} onRetry={economy.neighborError ? load : undefined} />}
  </div>;
}

export function NeighborWorld({ neighbor, now, timeZone, onShop, onReturn, onReady, onRefresh, refreshing, suspended }: {
  neighbor: NeighborView; now: number; timeZone: string; onShop: () => void; onReturn: () => void; onReady?: () => void;
  onRefresh: () => void; refreshing: boolean; suspended: boolean;
}) {
  const scene = useMemo(() => readOnlyWorldScene(neighbor.character.world, `world-character:${neighbor.character.id}`, neighbor.serverTime), [neighbor]);
  const top = useRef<HTMLElement>(null), bottom = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<{ objectId: string; place: WorldPlace } | null>(null);
  const onPlace = useCallback((place: WorldPlace, selection?: MapObjectSelection) => {
    if (place === "market") onShop(); else setSelected(selection ? { objectId: selection.objectId, place } : null);
  }, [onShop]);
  const onSelection = useCallback((selection: MapObjectSelection | null) => {
    setSelected(previous => !selection ? null : previous?.objectId === selection.objectId ? previous : { objectId: selection.objectId, place: selection.place });
  }, []);
  const stations = selected ? friendWorldStations(selected.place) : [];
  return <section className={`${worldStyles.world} ${styles.visit}`} data-neighbor-world={neighbor.character.id} aria-label={`Полянка: ${neighbor.character.name}`}>
    <WorldScene readOnly state={scene.state} gifts={scene.gifts} economyBuildings={scene.buildings} economyProduction={scene.production}
      economyConstruction={scene.construction} economyResidents={scene.residents} economyGarden={scene.garden}
      residentArrival={settledArrival} merchantArrival={settledArrival} lopukhArrival={settledArrival}
      owner={`world-character:${neighbor.character.id}`} now={now} timeZone={timeZone} bestStreakDays={0} wakeSignal={0}
      onPlace={onPlace} onObjectSelection={onSelection} selectedObjectId={selected?.objectId ?? null}
      topHud={top} bottomHud={bottom} suspended={suspended} onReady={onReady} hideJourneyStatus />
    <header ref={top} className={styles.header} data-world-hud>
      <button type="button" id="friend-world-return" onClick={onReturn} aria-label="Вернуться в свой лес"><ArrowLeft size={20} aria-hidden="true" /></button>
      <div className={styles.owner}><span>В гостях · Персонаж мира</span><h2>{neighbor.character.name}</h2></div>
      <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Обновить полянку соседа"><RefreshCw size={18} aria-hidden="true" /></button>
      <span className={styles.level} aria-label={`Дом уровня ${scene.state.houseLevel}`}><House size={16} aria-hidden="true" />{scene.state.houseLevel}</span>
    </header>
    <footer ref={bottom} className={styles.footer} data-world-hud>
      {selected && <aside className={styles.object} tabIndex={0} aria-label="Осмотр построек соседа" onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const panel = event.currentTarget;
        const top = event.key === "End" ? panel.scrollHeight : event.key === "Home" ? 0
          : event.key === "PageDown" ? panel.scrollTop + panel.clientHeight : event.key === "PageUp" ? panel.scrollTop - panel.clientHeight
            : event.key === "ArrowDown" ? panel.scrollTop + 40 : event.key === "ArrowUp" ? panel.scrollTop - 40 : null;
        if (top === null) return;
        event.preventDefault(); event.stopPropagation(); panel.scrollTop = top;
      }}>
        <div className={styles.objectHeading}><div><span>Хозяйство соседа</span><h3>{neighbor.character.name}</h3></div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Закрыть осмотр"><X size={18} aria-hidden="true" /></button></div>
        {stations.map(id => <NeighborStationInfo key={id} world={neighbor.character.world} stationId={id} />)}
        {!stations.length && <p className={styles.quiet}>Вы осматриваете полянку лесного соседа.</p>}
      </aside>}
      <button type="button" className={styles.shop} onClick={onShop}><Store size={19} aria-hidden="true" /><span>Лавка: {neighbor.character.name}</span><span className={styles.lotCount}>{neighbor.shop.offers.length}</span></button>
    </footer>
  </section>;
}
