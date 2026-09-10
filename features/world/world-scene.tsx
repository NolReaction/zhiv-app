"use client";
import { useEffect, useRef, useState } from "react";
import { LocateFixed, Minus, Plus, LoaderCircle, Scan } from "lucide-react";
import { reportIncident } from "@/lib/client-incidents";
import { HabitatAssetError } from "@/features/mochlik/assets";
import { habitatLighting } from "@/features/mochlik/lighting";
import { sceneJourney } from "./journey-timeline";
import { JourneyProgress } from "./journey-progress";
import type { GameItemId } from "@/features/game/game-rewards";
import type { SceneOptions } from "@/features/mochlik/scene";
import type { WorldState } from "./model";
import type { createMapEngine, MapAction, WorldPlace } from "./map-engine";
import { WORLD_ART } from "./art";
import { MAP_PLACES } from "./map-layout";
import styles from "./world.module.css";

type Props = { state: WorldState; gifts: readonly string[]; items?: readonly GameItemId[]; timeZone: string; now: number; owner: string; bestStreakDays: number; wakeSignal: number; onPlace: (place: WorldPlace) => void };
export function WorldScene({ state, gifts, items, timeZone, now, owner, bestStreakDays, wakeSignal, onPlace }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), root = useRef<HTMLDivElement>(null);
  const engine = useRef<Awaited<ReturnType<typeof createMapEngine>> | null>(null);
  const time = useRef(now);
  useEffect(() => { time.current = now; engine.current?.setTime(now); }, [now]);
  const previousWake = useRef(wakeSignal), pendingWake = useRef(0);
  const { lampOn, dusk } = habitatLighting(now, timeZone);
  const latest = useRef({ state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace });
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    latest.current = { state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    engine.current?.update({ lampOn, dusk, paused: false, view: "world", reducedMotion: media.matches, worldState: state, worldGifts: gifts, items, bestStreakDays, presenceKey: `zhiv:mochlik:presence:${owner}` });
  }, [state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace]);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const options = (): SceneOptions => ({ serverNow: time.current, lampOn: latest.current.lampOn, dusk: latest.current.dusk, paused: false, view: "world", reducedMotion: media.matches,
      worldState: latest.current.state, worldGifts: latest.current.gifts, items: latest.current.items,
      bestStreakDays: latest.current.bestStreakDays, presenceKey: `zhiv:mochlik:presence:${latest.current.owner}` });
    void import("./map-engine").then(module => {
      if (disposed) return null;
      return module.createMapEngine(canvas.current!, options(), place => latest.current.onPlace(place), Array.from(root.current!.querySelectorAll<HTMLElement>("[data-map-anchor]")), abort.signal);
    }).then(value => {
      if (!value) return;
      if (disposed) { value.dispose(); return; }
      engine.current = value; value.update(options()); value.setTime(time.current);
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
  }, [reload]);
  useEffect(() => {
    const taps = Math.max(0, wakeSignal - previousWake.current); previousWake.current = wakeSignal;
    if (engine.current) { for (let i = 0; i < taps; i++) engine.current.notice(); }
    else pendingWake.current += taps;
  }, [wakeSignal]);
  const journey = sceneJourney(state, now);
  const control = (action: MapAction) => engine.current?.control(action);
  return <div ref={root} className={styles.scene} style={{ backgroundImage: `url(${WORLD_ART.home})` }} data-ready={ready}>
    <canvas ref={canvas} tabIndex={0} role="img" aria-label="Лес Мохлика. Перетаскивайте карту, меняйте масштаб двумя пальцами или колёсиком. Стрелки двигают карту, плюс и минус меняют масштаб, Home возвращает к дому. Все места также доступны кнопками." />
    {!ready && <div className={styles.sceneLoading} role="status"><p>{!error && <LoaderCircle className={styles.loadingSpinner} size={23} />}{error ?? "Загружаем лес и Мохлика…"}</p>{error && <button onClick={() => { setReady(false); setError(null); setReload(value => value + 1); }}>Повторить загрузку</button>}</div>}
    <div className={styles.mapAnchors} hidden={!ready}>
      <button data-map-anchor data-kind="house" data-x={MAP_PLACES.house.marker.x} data-y={MAP_PLACES.house.marker.y} onClick={() => onPlace("house")} aria-label={`Домик ${state.houseLevel} уровня. Улучшить`} title="Домик" />
      <button data-map-anchor data-kind="bush" data-x={MAP_PLACES.bush.marker.x} data-y={MAP_PLACES.bush.marker.y} onClick={() => engine.current?.visitBush()} aria-label="Позвать Мохлика к кустику" title="Кустик" />
      <button data-map-anchor data-kind="cave" data-x={MAP_PLACES.cave.marker.x} data-y={MAP_PLACES.cave.marker.y} onClick={() => onPlace("cave")} aria-label="Войти в пещеру" title="Пещера" />
      <button data-map-anchor data-kind="fishing" data-x={MAP_PLACES.fishing.marker.x} data-y={MAP_PLACES.fishing.marker.y} onClick={() => onPlace("fishing")} aria-label="Открыть рыбалку" title="Рыбалка" />
    </div>
    <div className={styles.cameraControls} aria-label="Управление картой">
      <button onClick={() => control("in")} disabled={!ready} aria-label="Приблизить карту"><Plus size={19} /></button>
      <button onClick={() => control("out")} disabled={!ready} aria-label="Отдалить карту"><Minus size={19} /></button>
      <button onClick={() => control("overview")} disabled={!ready} aria-label="Показать всю карту" title="Вся карта"><Scan size={19} /></button>
      <button onClick={() => control("home")} disabled={!ready} aria-label="Вернуться камерой к дому"><LocateFixed size={19} /></button>
    </div>
    {journey && <button className={styles.away} onClick={() => onPlace("journeys")} aria-label="Открыть текущее путешествие"><JourneyProgress journey={journey} equipment={state.equipment} now={now} /></button>}
  </div>;
}
