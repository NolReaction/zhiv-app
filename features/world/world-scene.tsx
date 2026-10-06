"use client";
import type { EconomySceneProduction } from "@/features/world/economy-production-state";
import type { WorldResidentId } from "@/features/world/world-characters-model";
import type { EconomySceneConstruction } from "@/features/world/economy-construction-state";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import { reportIncident } from "@/lib/client-incidents";
import { HabitatAssetError } from "@/features/mochlik/assets";
import { habitatLighting } from "@/features/mochlik/lighting";
import { sceneJourney } from "./journey-timeline";
import { JourneyProgress } from "./journey-progress";
import type { GameItemId } from "@/features/game/game-rewards";
import type { SceneOptions } from "@/features/mochlik/scene";
import type { EconomySceneBuildings, EconomySceneJourney } from "./economy-scene-state";
import type { WorldState } from "./model";
import type { createMapEngine, MapObjectSelection, WorldPlace } from "./map-engine";
import { MAP_PLACES } from "./map-layout";
import { TILED_WORLD, WORLD_PRESENTATION } from "./presentation";
import { interactiveMapObjects } from "./site-interactions";
import type { EconomyController } from "@/features/economy/use-economy";
import { WorldConstructionStatus } from "./world-construction-status";
import { WorldUpgradeEffects, UPGRADE_CELEBRATION_MS } from "./world-upgrade-effects";
import { WorldProductionStatus } from "./world-production-status";
import { WorldProductionEffects } from "./world-production-effects";
import { mapProductionGroups } from "./world-production-state";
import { constructionMapPlace } from "./construction-map-anchor";
import { INVENTORY_GAIN_MS, INVENTORY_GAIN_QUEUE_LIMIT } from "./inventory-gain-playback";
import { createMapAnchorStore } from "./map-anchor-store";
import { useGardenCollection } from "@/features/economy/garden-collection-context";
import { ForestSpeechAnnouncements } from "./forest-speech";
import styles from "./world.module.css";

type Props = { hideJourneyStatus?: boolean; economyJourney?: EconomySceneJourney | null; cancelledExplorations?: readonly string[]; economyBuildings?: EconomySceneBuildings | null; economyProduction?: EconomySceneProduction | null; economyConstruction?: EconomySceneConstruction | null; state: WorldState; gifts: readonly string[]; items?: readonly GameItemId[]; timeZone: string; now: number; owner: string; bestStreakDays: number; wakeSignal: number; onPlace: (place: WorldPlace, selection?: MapObjectSelection) => void;
  constructionEconomy?: EconomyController; onOpenConstruction?: (stationId: string) => void; onOpenProduction?: (stationId: string) => void; hideConstructionStatus?: boolean;
  selectedObjectId?: string | null; onObjectSelection?: (selection: MapObjectSelection | null) => void;
  onResident?: (id: WorldResidentId) => void;
  openObjectRequest?: { id: number; place: WorldPlace };
  topHud: RefObject<HTMLElement | null>; bottomHud: RefObject<HTMLElement | null> };
export function WorldScene({ hideJourneyStatus = false, constructionEconomy, onOpenConstruction, onOpenProduction, hideConstructionStatus = false, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, state, gifts, items, timeZone, now, owner, bestStreakDays, wakeSignal, onPlace, onResident, selectedObjectId, onObjectSelection, openObjectRequest, topHud, bottomHud }: Props) {
  const garden = useGardenCollection();
  const canvas = useRef<HTMLCanvasElement>(null), root = useRef<HTMLDivElement>(null);
  const engine = useRef<Awaited<ReturnType<typeof createMapEngine>> | null>(null);
  const time = useRef(now);
  useEffect(() => { time.current = now; engine.current?.setTime(now); }, [now]);
  const previousWake = useRef(wakeSignal), pendingWake = useRef(0);
  const { lampOn, dusk } = habitatLighting(now, timeZone);
  const latest = useRef({ state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace, onResident, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, garden });
  const selection = useRef({ selectedObjectId, onObjectSelection });
  const objectRequest = useRef(openObjectRequest), handledObjectRequest = useRef<number | null>(null);
  const applyObjectRequest = useCallback(() => {
    const request = objectRequest.current;
    if (!request || handledObjectRequest.current === request.id) return;
    const object = interactiveMapObjects(TILED_WORLD).find(object => object.place === request.place);
    if (object && engine.current?.activateObject(object.id)) handledObjectRequest.current = request.id;
  }, []);
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  const [anchorStore] = useState(createMapAnchorStore);
  const constructionActive = Boolean(constructionEconomy?.snapshot?.jobs.some(job => job.kind === "construction"));
  const productionActive = Boolean(constructionEconomy?.snapshot?.jobs.some(job => job.kind === "production"));
  const completions = constructionEconomy?.completedConstructions;
  const gains = constructionEconomy?.inventoryGains;
  const anchorTracking = useRef({ enabled: constructionActive || productionActive, production: productionActive, seen: new Set(completions?.map(event => event.id)), gains: new Set(gains?.map(event => event.id)), until: 0 });
  useLayoutEffect(() => {
    const tracker = anchorTracking.current;
    const fresh = completions?.some(event => !tracker.seen.has(event.id));
    const freshGain = gains?.some(event => event.stationId && !tracker.gains.has(event.id));
    // Snapshot adoption and its receipt notification are separate publications.
    // Keep the last job's anchors through that gap; polling alone creates no effect.
    if (tracker.production && !productionActive) tracker.until = Math.max(tracker.until, performance.now() + INVENTORY_GAIN_MS + 100);
    tracker.production = productionActive;
    tracker.seen = new Set(completions?.map(event => event.id));
    tracker.gains = new Set(gains?.map(event => event.id));
    if (fresh) tracker.until = Math.max(tracker.until, performance.now() + UPGRADE_CELEBRATION_MS + 100);
    if (freshGain) tracker.until = Math.max(tracker.until, performance.now() + INVENTORY_GAIN_MS * (INVENTORY_GAIN_QUEUE_LIMIT + 1) + 100);
    tracker.enabled = constructionActive || productionActive || performance.now() < tracker.until;
    engine.current?.setObjectAnchorsEnabled(tracker.enabled);
    if (constructionActive || productionActive || !tracker.enabled) return;
    const timer = setTimeout(() => { tracker.enabled = false; engine.current?.setObjectAnchorsEnabled(false); }, Math.max(0, tracker.until - performance.now()));
    return () => clearTimeout(timer);
  }, [constructionActive, productionActive, completions, gains]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    latest.current = { state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace, onResident, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, garden };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    engine.current?.update({ lampOn, dusk, paused: false, view: "world", reducedMotion: media.matches, worldState: state, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyGarden: garden?.crop, gardenHarvestRequest: garden?.request, onGardenHarvestEvent: garden?.sceneEvent, worldGifts: gifts, items, bestStreakDays, presenceKey: `zhiv:mochlik:presence:${owner}` });
  }, [state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace, onResident, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, garden]);
  useEffect(() => { selection.current = { selectedObjectId, onObjectSelection }; }, [selectedObjectId, onObjectSelection]);
  useEffect(() => { engine.current?.setSelectedObject(selectedObjectId ?? null); }, [selectedObjectId]);
  useEffect(() => { objectRequest.current = openObjectRequest; applyObjectRequest(); }, [openObjectRequest, applyObjectRequest]);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const options = (): SceneOptions => ({ serverNow: time.current, lampOn: latest.current.lampOn, dusk: latest.current.dusk, paused: false, view: "world", reducedMotion: media.matches,
      worldState: latest.current.state, economyJourney: latest.current.economyJourney, cancelledExplorations: latest.current.cancelledExplorations, economyBuildings: latest.current.economyBuildings, economyProduction: latest.current.economyProduction, economyConstruction: latest.current.economyConstruction, economyGarden: latest.current.garden?.crop, gardenHarvestRequest: latest.current.garden?.request, onGardenHarvestEvent: latest.current.garden?.sceneEvent, worldGifts: latest.current.gifts, items: latest.current.items,
      bestStreakDays: latest.current.bestStreakDays, presenceKey: `zhiv:mochlik:presence:${latest.current.owner}` });
    void import("./map-engine").then(module => {
      if (disposed) return null;
      return module.createMapEngine(canvas.current!, options(), (place, selection) => latest.current.onPlace(place, selection), Array.from(root.current!.querySelectorAll<HTMLElement>("[data-map-anchor]")), abort.signal,
        { top: topHud.current, bottom: bottomHud.current }, {
          onSelectionChange: value => selection.current.onObjectSelection?.(value),
          onResident: id => latest.current.onResident?.(id),
          objectAnchorsEnabled: anchorTracking.current.enabled,
          onObjectAnchorsChange: values => { if (!disposed) anchorStore.publish(values); },
        });
    }).then(value => {
      if (!value) return;
      if (disposed) { value.dispose(); return; }
      engine.current = value; value.setObjectAnchorsEnabled(anchorTracking.current.enabled); value.update(options()); value.setTime(time.current); value.setSelectedObject(selection.current.selectedObjectId ?? null);
      applyObjectRequest();
      for (let i = 0; i < pendingWake.current; i++) value.notice(); pendingWake.current = 0;
      setReady(true); setError(null);
    }).catch((error: unknown) => {
      if (disposed) return;
      const detail = error as { stage?: string; cause?: unknown };
      const timeout = detail.cause instanceof HabitatAssetError && detail.cause.timedOut;
      reportIncident(latest.current.owner, "world", `WORLD_${detail.stage === "character" ? "CHARACTER" : "MAP"}_${timeout ? "TIMEOUT" : "FAILED"}`);
      setError("Не удалось загрузить лес. Попробуйте ещё раз — ваш прогресс сохранён.");
    });
    const change = () => engine.current?.update(options()); media.addEventListener("change", change);
    return () => { disposed = true; abort.abort(); media.removeEventListener("change", change); engine.current?.dispose(); engine.current = null; };
  }, [reload, topHud, bottomHud, applyObjectRequest, anchorStore]);
  useEffect(() => {
    const taps = Math.max(0, wakeSignal - previousWake.current); previousWake.current = wakeSignal;
    if (engine.current) { for (let i = 0; i < taps; i++) engine.current.notice(); }
    else pendingWake.current += taps;
  }, [wakeSignal]);
  const journey = sceneJourney(state, now);
  const objects = interactiveMapObjects(TILED_WORLD);
  return <div ref={root} className={styles.scene} data-ready={ready}>
    <canvas ref={canvas} tabIndex={0} role="img" aria-label="Лес Мохлика. Перетаскивайте карту, меняйте масштаб двумя пальцами или колёсиком. Стрелки двигают карту, плюс и минус меняют масштаб, Home находит Мохлика." />
    <ForestSpeechAnnouncements key={owner} owner={owner} />
    {!ready && <div className={styles.sceneLoading} role="status"><p>{!error && <LoaderCircle className={styles.loadingSpinner} size={23} />}{error ?? "Загружаем лес и Мохлика…"}</p>{error && <button onClick={() => { setReady(false); setError(null); setReload(value => value + 1); }}>Повторить загрузку</button>}</div>}
    {WORLD_PRESENTATION.rebuilding ? <div className={styles.mapAnchors} hidden={!ready} role="group" aria-label="Объекты на карте">
      {objects.map(({ id, place, label }) => <button key={id} data-map-anchor data-object-id={id} data-kind={place}
        onClick={event => { if (event.detail === 0) engine.current?.activateObject(id); }} aria-label={`Открыть: ${label}`} aria-expanded={selectedObjectId === id} title={label} />)}
    </div> : <div className={styles.mapAnchors} hidden={!ready}>
      <button data-map-anchor data-kind="house" data-x={MAP_PLACES.house.marker.x} data-y={MAP_PLACES.house.marker.y} onClick={() => onPlace("house")} aria-label={`Домик ${state.houseLevel} уровня. Улучшить`} title="Домик" />
      <button data-map-anchor data-kind="bush" data-x={MAP_PLACES.bush.marker.x} data-y={MAP_PLACES.bush.marker.y} onClick={() => engine.current?.visitBush()} aria-label="Позвать Мохлика к кустику" title="Кустик" />
      <button data-map-anchor data-kind="cave" data-x={MAP_PLACES.cave.marker.x} data-y={MAP_PLACES.cave.marker.y} onClick={() => onPlace("cave")} aria-label="Войти в пещеру" title="Пещера" />
      <button data-map-anchor data-kind="fishing" data-x={MAP_PLACES.fishing.marker.x} data-y={MAP_PLACES.fishing.marker.y} onClick={() => onPlace("fishing")} aria-label="Открыть рыбалку" title="Рыбалка" />
    </div>}
    <MapFeedback key={owner} anchorStore={anchorStore} economy={constructionEconomy} onOpen={onOpenConstruction} onOpenProduction={onOpenProduction} ready={ready} hidden={hideConstructionStatus} />
    {!hideJourneyStatus && economyJourney && <button className={styles.away} onClick={() => onPlace("cave")} aria-label="Открыть исследование Мохлика">
      <span>{economyJourney.label ?? "Исследование"} · {now >= Date.parse(economyJourney.finishesAt) ? "Мохлик вернулся — забрать находки" : `${Math.max(1, Math.ceil((Date.parse(economyJourney.finishesAt) - now) / 60000))} мин до возвращения`}</span>
    </button>}
    {!hideJourneyStatus && !economyJourney && journey && <button className={styles.away} onClick={() => onPlace("journeys")} aria-label="Открыть текущее путешествие"><JourneyProgress journey={journey} equipment={state.equipment} now={now} /></button>}
  </div>;
}

/** Only the small map overlays subscribe to camera movement; the scene stays mounted. */
function MapFeedback({ anchorStore, economy, onOpen, onOpenProduction, ready, hidden }: {
  anchorStore: ReturnType<typeof createMapAnchorStore>; economy?: EconomyController;
  onOpen?: (stationId: string) => void; onOpenProduction?: (stationId: string) => void; ready: boolean; hidden: boolean;
}) {
  const anchors = useSyncExternalStore(anchorStore.subscribe, anchorStore.getSnapshot, anchorStore.getSnapshot);
  const garden = useGardenCollection();
  const groups = mapProductionGroups(economy?.snapshot ?? null, economy?.now ?? NaN, garden);
  const construction = economy?.snapshot?.jobs.find(job => job.kind === "construction");
  const constructionAnchors = anchors.filter(anchor => !groups.some(group => group.place === anchor.place));
  const reserved = constructionAnchors.filter(anchor => anchor.place === constructionMapPlace(construction?.targetId ?? ""));
  return <>
    {ready && economy && onOpen && <WorldConstructionStatus economy={economy} anchors={constructionAnchors} onOpen={onOpen} hidden={hidden} />}
    {ready && economy && onOpenProduction && <WorldProductionStatus economy={economy} groups={groups} anchors={anchors} reserved={reserved} onOpen={onOpenProduction} onOpenConstruction={onOpen} hidden={hidden} />}
    {economy && <WorldUpgradeEffects economy={economy} anchors={anchors} ready={ready} />}
    {economy && <WorldProductionEffects economy={economy} anchors={anchors} ready={ready} />}
  </>;
}
