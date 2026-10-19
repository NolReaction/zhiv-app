"use client";
import type { EconomySceneGarden } from "@/features/world/state/economy/economy-garden-state";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { WorldResidentId } from "@/features/world/characters/world-characters-model";
import type { EconomySceneConstruction } from "@/features/world/state/economy/economy-construction-state";
import type { EconomySceneResidents, ResidentArrivalPresentation } from "@/features/world/state/economy/economy-residents-state";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import { reportIncident } from "@/lib/client-incidents";
import { HabitatAssetError } from "@/features/mochlik/assets";
import { bindSceneLoaderEnvironment, createSceneLoader, WORLD_SCENE_TIMEOUT_MS } from "@/features/startup/scene-loader";
import { habitatLighting, habitatLocalHour } from "@/features/mochlik/lighting";
import { sceneJourney } from "@/features/world/activities/journeys/journey-timeline";
import { JourneyProgress } from "@/features/world/ui/journeys/journey-progress";
import type { GameItemId } from "@/features/game/game-rewards";
import type { SceneOptions } from "@/features/mochlik/scene";
import type { EconomySceneBuildings, EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { WorldState } from "@/features/world/domain/model";
import type { createMapEngine, MapObjectSelection, WorldPlace } from "./map-engine";
import { MAP_PLACES } from "@/features/world/legacy/map-layout";
import { TILED_WORLD, WORLD_PRESENTATION } from "./presentation";
import { interactiveMapObjects, type MapObjectPlace } from "./site-interactions";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { isMinerJob } from "@/features/economy/domain/actor-availability";
import { WorldConstructionStatus } from "@/features/world/ui/hud/world-construction-status";
import { WorldUpgradeEffects, UPGRADE_CELEBRATION_MS } from "@/features/world/ui/feedback/world-upgrade-effects";
import { WorldProductionStatus } from "@/features/world/ui/hud/world-production-status";
import { WorldMarketSaleStatus, marketSaleMarkerAnchor } from "@/features/world/ui/hud/world-market-sale-status";
import { WorldProductionEffects } from "@/features/world/ui/feedback/world-production-effects";
import { mapProductionGroups, productionMarkerHeight } from "@/features/world/ui/hud/world-production-state";
import { CONSTRUCTION_MARKER, constructionMapPlace } from "./construction-map-anchor";
import { INVENTORY_GAIN_MS, INVENTORY_GAIN_QUEUE_LIMIT } from "@/features/world/ui/feedback/inventory-gain-playback";
import { createMapAnchorStore } from "./map-anchor-store";
import { observeMapGuideInset } from "./map-guide-inset";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";
import { ForestSpeechAnnouncements } from "@/features/world/characters/social/forest-speech";
import { useTapHintPreference } from "@/features/world/state/use-tap-hint-preferences";
import styles from "@/features/world/world.module.css";

type Props = { readOnly?: boolean; economyGarden?: EconomySceneGarden | null; tutorialActive?: boolean; audioSuppressed?: boolean; suspended?: boolean; hideJourneyStatus?: boolean; economyJourney?: EconomySceneJourney | null; cancelledExplorations?: readonly string[]; economyBuildings?: EconomySceneBuildings | null; economyProduction?: EconomySceneProduction | null; economyConstruction?: EconomySceneConstruction | null; economyResidents?: EconomySceneResidents | null; residentArrival?: ResidentArrivalPresentation; merchantArrival?: ResidentArrivalPresentation; lopukhArrival?: ResidentArrivalPresentation; state: WorldState; gifts: readonly string[]; items?: readonly GameItemId[]; timeZone: string; now: number; owner: string; bestStreakDays: number; wakeSignal: number; onPlace: (place: WorldPlace, selection?: MapObjectSelection) => void;
  constructionEconomy?: EconomyController; onOpenConstruction?: (stationId: string) => void; onOpenProduction?: (stationId: string) => void; hideConstructionStatus?: boolean;
  marketSales?: number; onOpenMarket?: () => void;
  selectedObjectId?: string | null; onObjectSelection?: (selection: MapObjectSelection | null) => void;
  onResident?: (id: WorldResidentId) => void;
  onReady?: () => void;
  openObjectRequest?: { id: number; place: WorldPlace };
  guidePlace?: MapObjectPlace | null;
  topHud: RefObject<HTMLElement | null>; bottomHud: RefObject<HTMLElement | null> };
export function WorldScene({ readOnly = false, economyGarden, tutorialActive = false, audioSuppressed = false, suspended = false, hideJourneyStatus = false, constructionEconomy, onOpenConstruction, onOpenProduction, marketSales = 0, onOpenMarket, hideConstructionStatus = false, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyResidents, residentArrival, merchantArrival, lopukhArrival, state, gifts, items, timeZone, now, owner, bestStreakDays, wakeSignal, onPlace, onResident, onReady, selectedObjectId, onObjectSelection, openObjectRequest, guidePlace, topHud, bottomHud }: Props) {
  const { showTapHints } = useTapHintPreference(owner);
  const collection = useGardenCollection();
  const garden = readOnly ? null : collection;
  const canvas = useRef<HTMLCanvasElement>(null), speechCanvas = useRef<HTMLCanvasElement>(null), root = useRef<HTMLDivElement>(null);
  const engine = useRef<Awaited<ReturnType<typeof createMapEngine>> | null>(null);
  const time = useRef(now);
  useEffect(() => { time.current = now; engine.current?.setTime(now); }, [now]);
  const previousWake = useRef(wakeSignal), pendingWake = useRef(0);
  const readyCallback = useRef(onReady);
  useEffect(() => { readyCallback.current = onReady; }, [onReady]);
  const { lampOn, dusk } = habitatLighting(now, timeZone);
  const localHour = habitatLocalHour(now, timeZone);
  const latest = useRef({ readOnly, economyGarden, tutorialActive, audioSuppressed, state, gifts, items, owner, bestStreakDays, lampOn, dusk, localHour, suspended, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyResidents, residentArrival, merchantArrival, lopukhArrival, garden });
  const interactions = useRef({ onPlace, onResident });
  useEffect(() => { interactions.current = { onPlace, onResident }; }, [onPlace, onResident]);
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
  const markerHeights = useRef<ReadonlyMap<MapObjectPlace, number>>(new Map());
  useLayoutEffect(() => {
    const heights = new Map(mapProductionGroups(constructionEconomy?.snapshot ?? null, constructionEconomy?.now ?? NaN, garden)
      .map(group => [group.place, productionMarkerHeight(group)]));
    const changed = heights.size !== markerHeights.current.size
      || [...heights].some(([place, height]) => markerHeights.current.get(place) !== height);
    markerHeights.current = heights;
    if (changed) engine.current?.refreshObjectAnchors();
  }, [constructionEconomy, garden]);
  const constructionActive = Boolean(constructionEconomy?.snapshot?.jobs.some(job => job.kind === "construction"));
  const productionActive = Boolean(constructionEconomy?.snapshot?.jobs.some(job => job.kind === "production" || isMinerJob(job)));
  const salesActive = !readOnly && marketSales > 0;
  const completions = constructionEconomy?.completedConstructions;
  const gains = constructionEconomy?.inventoryGains;
  const anchorTracking = useRef({ enabled: constructionActive || productionActive || salesActive, production: productionActive, seen: new Set(completions?.map(event => event.id)), gains: new Set(gains?.map(event => event.id)), until: 0 });
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
    tracker.enabled = constructionActive || productionActive || salesActive || performance.now() < tracker.until;
    engine.current?.setObjectAnchorsEnabled(tracker.enabled);
    if (constructionActive || productionActive || salesActive || !tracker.enabled) return;
    const timer = setTimeout(() => { tracker.enabled = false; engine.current?.setObjectAnchorsEnabled(false); }, Math.max(0, tracker.until - performance.now()));
    return () => clearTimeout(timer);
  }, [constructionActive, productionActive, salesActive, completions, gains]);
  const loader = useRef<ReturnType<typeof createSceneLoader<Awaited<ReturnType<typeof createMapEngine>>>> | null>(null);
  useEffect(() => {
    latest.current = { readOnly, economyGarden, tutorialActive, audioSuppressed, state, gifts, items, owner, bestStreakDays, lampOn, dusk, localHour, suspended, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyResidents, residentArrival, merchantArrival, lopukhArrival, garden };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    engine.current?.update({ readOnly, tutorialActive, audioSuppressed, lampOn, dusk, localHour, paused: false, backgrounded: suspended, view: "world", reducedMotion: media.matches, worldState: state, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyResidents, residentArrival, merchantArrival, lopukhArrival, economyGarden: readOnly ? economyGarden : garden?.crop, gardenHarvestRequest: garden?.request, onGardenHarvestEvent: garden?.sceneEvent, worldGifts: gifts, items, bestStreakDays, presenceKey: `zhiv:mochlik:presence:${owner}` });
  }, [readOnly, economyGarden, tutorialActive, audioSuppressed, state, gifts, items, owner, bestStreakDays, lampOn, dusk, localHour, suspended, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyResidents, residentArrival, merchantArrival, lopukhArrival, garden]);
  useEffect(() => {
    // Report after the engine options update, also when a ready portal reopens
    // before its exit animation unmounts the canvas. The circle then yields.
    if (ready && !suspended) readyCallback.current?.();
  }, [ready, suspended]);
  useEffect(() => { selection.current = { selectedObjectId, onObjectSelection }; }, [selectedObjectId, onObjectSelection]);
  useEffect(() => { engine.current?.setSelectedObject(selectedObjectId ?? null); }, [selectedObjectId]);
  useEffect(() => { objectRequest.current = openObjectRequest; applyObjectRequest(); }, [openObjectRequest, applyObjectRequest]);
  useEffect(() => {
    if (!ready || suspended || !guidePlace) { engine.current?.setGuidePlace(null); return; }
    const world = root.current?.parentElement, surface = root.current;
    if (!world || !surface) return;
    return observeMapGuideInset(world, surface, bottom => engine.current?.setGuidePlace(guidePlace, bottom));
  }, [ready, suspended, guidePlace]);
  useEffect(() => {
    let disposed = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const options = (): SceneOptions => ({ readOnly: latest.current.readOnly, tutorialActive: latest.current.tutorialActive, audioSuppressed: latest.current.audioSuppressed, serverNow: time.current, lampOn: latest.current.lampOn, dusk: latest.current.dusk, localHour: latest.current.localHour, paused: false, backgrounded: latest.current.suspended, view: "world", reducedMotion: media.matches,
      worldState: latest.current.state, economyJourney: latest.current.economyJourney, cancelledExplorations: latest.current.cancelledExplorations, economyBuildings: latest.current.economyBuildings, economyProduction: latest.current.economyProduction, economyConstruction: latest.current.economyConstruction, economyResidents: latest.current.economyResidents, residentArrival: latest.current.residentArrival, merchantArrival: latest.current.merchantArrival, lopukhArrival: latest.current.lopukhArrival, economyGarden: latest.current.readOnly ? latest.current.economyGarden : latest.current.garden?.crop, gardenHarvestRequest: latest.current.garden?.request, onGardenHarvestEvent: latest.current.garden?.sceneEvent, worldGifts: latest.current.gifts, items: latest.current.items,
      bestStreakDays: latest.current.bestStreakDays, presenceKey: `zhiv:mochlik:presence:${latest.current.owner}` });
    const loading = createSceneLoader<Awaited<ReturnType<typeof createMapEngine>>>({
      timeoutMs: WORLD_SCENE_TIMEOUT_MS,
      async load(signal) {
        const mapModule = await import("./map-engine");
        signal.throwIfAborted();
        return mapModule.createMapEngine(canvas.current!, options(), (place, selection) => interactions.current.onPlace(place, selection), Array.from(root.current!.querySelectorAll<HTMLElement>("[data-map-anchor]")), signal,
          { top: topHud.current, bottom: bottomHud.current }, {
            onSelectionChange: value => selection.current.onObjectSelection?.(value),
            onResident: id => interactions.current.onResident?.(id),
            objectAnchorsEnabled: anchorTracking.current.enabled,
            objectMarkerHeight: place => markerHeights.current.get(place) ?? CONSTRUCTION_MARKER.height,
            onObjectAnchorsChange: values => { if (!disposed) anchorStore.publish(values); },
          }, speechCanvas.current, root.current);
      },
      release(value) { value.dispose(); if (engine.current === value) engine.current = null; },
      onReady(value) {
        engine.current = value; value.setObjectAnchorsEnabled(anchorTracking.current.enabled); value.update(options()); value.setTime(time.current); value.setSelectedObject(selection.current.selectedObjectId ?? null);
        applyObjectRequest();
        for (let i = 0; i < pendingWake.current; i++) value.notice(); pendingWake.current = 0;
      },
      onState(state, error) {
        setReady(state === "ready");
        if (state !== "error") { setError(null); return; }
        const detail = error as { stage?: string; cause?: unknown } | null;
        const timeout = [error, detail?.cause].some(cause => cause instanceof HabitatAssetError && cause.timedOut
          || cause instanceof Error && cause.name === "TimeoutError");
        reportIncident(latest.current.owner, "world", `WORLD_${detail?.stage === "character" ? "CHARACTER" : "MAP"}_${timeout ? "TIMEOUT" : "FAILED"}`);
        setError("Восстанавливаем связь с лесом… Загрузка повторится автоматически, ваш прогресс сохранён.");
      },
    });
    loader.current = loading;
    const unbind = bindSceneLoaderEnvironment(loading);
    loading.retry();
    const change = () => engine.current?.update(options()); media.addEventListener("change", change);
    return () => {
      disposed = true; unbind(); loading.dispose(); media.removeEventListener("change", change);
      if (loader.current === loading) loader.current = null;
    };
  }, [owner, readOnly, topHud, bottomHud, applyObjectRequest, anchorStore]);

  useEffect(() => {
    const taps = Math.max(0, wakeSignal - previousWake.current); previousWake.current = wakeSignal;
    if (engine.current) { for (let i = 0; i < taps; i++) engine.current.notice(); }
    else pendingWake.current += taps;
  }, [wakeSignal]);
  const journey = sceneJourney(state, now);
  const objects = interactiveMapObjects(TILED_WORLD);
  return <div ref={root} className={styles.scene} data-ready={ready}>
    <canvas ref={canvas} tabIndex={0} role="img" aria-label="Лес Мохлика. Перетаскивайте карту, меняйте масштаб двумя пальцами или колёсиком. Стрелки двигают карту, плюс и минус меняют масштаб, Home находит Мохлика." />
    <canvas ref={speechCanvas} className={styles.speechCanvas} aria-hidden="true" />
    {!readOnly && <ForestSpeechAnnouncements key={`speech:${owner}`} owner={owner} />}
    {!ready && <div className={styles.sceneLoading} role="status"><p>{!error && <LoaderCircle className={styles.loadingSpinner} size={23} />}{error ?? "Загружаем лес и Мохлика…"}</p>{error && <button onClick={() => loader.current?.retry()}>Повторить загрузку</button>}</div>}
    {WORLD_PRESENTATION.rebuilding ? <div className={styles.mapAnchors} data-tap-hints={showTapHints} hidden={!ready} role="group" aria-label="Объекты на карте">
      {objects.map(({ id, place, label }) => <button key={id} data-map-anchor data-object-id={id} data-kind={place}
        onClick={event => { if (event.detail === 0) engine.current?.activateObject(id); }} aria-label={`Открыть: ${label}`} aria-expanded={selectedObjectId === id} title={label} />)}
    </div> : <div className={styles.mapAnchors} data-tap-hints={showTapHints} hidden={!ready}>
      <button data-map-anchor data-kind="house" data-x={MAP_PLACES.house.marker.x} data-y={MAP_PLACES.house.marker.y} onClick={() => onPlace("house")} aria-label={`Домик ${state.houseLevel} уровня. Улучшить`} title="Домик" />
      <button data-map-anchor data-kind="bush" data-x={MAP_PLACES.bush.marker.x} data-y={MAP_PLACES.bush.marker.y} onClick={() => engine.current?.visitBush()} aria-label="Позвать Мохлика к кустику" title="Кустик" />
      <button data-map-anchor data-kind="cave" data-x={MAP_PLACES.cave.marker.x} data-y={MAP_PLACES.cave.marker.y} onClick={() => onPlace("cave")} aria-label="Войти в пещеру" title="Пещера" />
      <button data-map-anchor data-kind="fishing" data-x={MAP_PLACES.fishing.marker.x} data-y={MAP_PLACES.fishing.marker.y} onClick={() => onPlace("fishing")} aria-label="Открыть рыбалку" title="Рыбалка" />
    </div>}
    <MapFeedback key={`feedback:${owner}`} anchorStore={anchorStore} economy={readOnly ? undefined : constructionEconomy} onOpen={onOpenConstruction} onOpenProduction={onOpenProduction}
      marketSales={readOnly ? 0 : marketSales} onOpenMarket={readOnly ? undefined : onOpenMarket} ready={ready} hidden={hideConstructionStatus || suspended} />
    {!hideJourneyStatus && economyJourney && <button className={styles.away} onClick={() => onPlace("cave")} aria-label="Открыть исследование Мохлика">
      <span>{economyJourney.label ?? "Исследование"} · {now >= Date.parse(economyJourney.finishesAt) ? "Мохлик вернулся, забрать находки" : `${Math.max(1, Math.ceil((Date.parse(economyJourney.finishesAt) - now) / 60000))} мин до возвращения`}</span>
    </button>}
    {!hideJourneyStatus && !economyJourney && journey && <button className={styles.away} onClick={() => onPlace("journeys")} aria-label="Открыть текущее путешествие"><JourneyProgress journey={journey} equipment={state.equipment} now={now} /></button>}
  </div>;
}

/** Only the small map overlays subscribe to camera movement; the scene stays mounted. */
function MapFeedback({ anchorStore, economy, onOpen, onOpenProduction, marketSales, onOpenMarket, ready, hidden }: {
  anchorStore: ReturnType<typeof createMapAnchorStore>; economy?: EconomyController;
  marketSales: number; onOpenMarket?: () => void;
  onOpen?: (stationId: string) => void; onOpenProduction?: (stationId: string) => void; ready: boolean; hidden: boolean;
}) {
  const anchors = useSyncExternalStore(anchorStore.subscribe, anchorStore.getSnapshot, anchorStore.getSnapshot);
  const garden = useGardenCollection();
  const snapshot = economy?.snapshot ?? null, now = economy?.now ?? NaN;
  // Camera anchors move independently of confirmed jobs, their clock and harvest.
  const groups = useMemo(() => mapProductionGroups(snapshot, now, garden), [snapshot, now, garden]);
  const construction = economy?.snapshot?.jobs.find(job => job.kind === "construction");
  const constructionAnchors = anchors.filter(anchor => !groups.some(group => group.place === anchor.place));
  const reserved = constructionAnchors.filter(anchor => anchor.place === constructionMapPlace(construction?.targetId ?? ""));
  const marketAnchor = marketSales > 0 && onOpenMarket ? marketSaleMarkerAnchor(anchors, reserved) : null;
  const productionReserved = marketAnchor ? [...reserved, marketAnchor] : reserved;
  return <>
    {ready && economy && onOpen && <WorldConstructionStatus economy={economy} anchors={constructionAnchors} onOpen={onOpen} hidden={hidden} />}
    {ready && economy && onOpenProduction && <WorldProductionStatus economy={economy} groups={groups} anchors={anchors} reserved={productionReserved} onOpen={onOpenProduction} onOpenConstruction={onOpen} hidden={hidden} />}
    {ready && economy && onOpenMarket && <WorldMarketSaleStatus count={marketSales} anchor={marketAnchor} onOpen={onOpenMarket} hidden={hidden} />}
    {economy && <WorldUpgradeEffects economy={economy} anchors={anchors} ready={ready} />}
    {economy && <WorldProductionEffects economy={economy} anchors={anchors} ready={ready} />}
  </>;
}
