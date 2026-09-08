"use client";
import { useEffect, useRef, useState } from "react";
import { Compass, Hammer, House, LocateFixed, Minus, Plus, Waves } from "lucide-react";
import { habitatLighting } from "@/lib/mochlik/lighting";
import { journeyLabel } from "@/lib/mochlik/home-state";
import type { GameItemId } from "@/lib/game-rewards";
import type { SceneOptions } from "@/lib/mochlik/scene";
import type { WorldState } from "./model";
import type { createMapEngine, MapAction, WorldPlace } from "./map-engine";
import styles from "./world.module.css";

type Props = { state: WorldState; gifts: readonly string[]; items?: readonly GameItemId[]; timeZone: string; now: number; owner: string; bestStreakDays: number; wakeSignal: number; onPlace: (place: WorldPlace) => void };
export function WorldScene({ state, gifts, items, timeZone, now, owner, bestStreakDays, wakeSignal, onPlace }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), root = useRef<HTMLDivElement>(null);
  const engine = useRef<Awaited<ReturnType<typeof createMapEngine>> | null>(null);
  const previousWake = useRef(wakeSignal), pendingWake = useRef(0);
  const { lampOn, dusk } = habitatLighting(now, timeZone);
  const latest = useRef({ state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace });
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    latest.current = { state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    engine.current?.update({ lampOn, dusk, paused: false, reducedMotion: media.matches, worldState: state, worldGifts: gifts, items, bestStreakDays, presenceKey: `zhiv:mochlik:presence:${owner}` });
  }, [state, gifts, items, owner, bestStreakDays, lampOn, dusk, onPlace]);
  useEffect(() => {
    let disposed = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const options = (): SceneOptions => ({ lampOn: latest.current.lampOn, dusk: latest.current.dusk, paused: false, reducedMotion: media.matches,
      worldState: latest.current.state, worldGifts: latest.current.gifts, items: latest.current.items,
      bestStreakDays: latest.current.bestStreakDays, presenceKey: `zhiv:mochlik:presence:${latest.current.owner}` });
    void import("./map-engine").then(module => {
      if (disposed) return null;
      return module.createMapEngine(canvas.current!, options(), place => latest.current.onPlace(place), Array.from(root.current!.querySelectorAll<HTMLElement>("[data-map-anchor]")));
    }).then(value => {
      if (!value) return;
      if (disposed) { value.dispose(); return; }
      engine.current = value; value.update(options());
      for (let i = 0; i < pendingWake.current; i++) value.notice(); pendingWake.current = 0;
      setReady(true); setError(null);
    }).catch(() => { if (!disposed) setError("Карта не загрузилась. Управление постройками и путешествиями доступно внизу."); });
    const change = () => engine.current?.update(options()); media.addEventListener("change", change);
    return () => { disposed = true; media.removeEventListener("change", change); engine.current?.dispose(); engine.current = null; };
  }, [reload]);
  useEffect(() => {
    const taps = Math.max(0, wakeSignal - previousWake.current); previousWake.current = wakeSignal;
    if (engine.current) { for (let i = 0; i < taps; i++) engine.current.notice(); }
    else pendingWake.current += taps;
  }, [wakeSignal]);
  const control = (action: MapAction) => engine.current?.control(action);
  return <div ref={root} className={styles.scene} data-ready={ready}>
    <canvas ref={canvas} tabIndex={0} role="img" aria-label="Лес Мохлика. Перетаскивайте карту, меняйте масштаб двумя пальцами или колёсиком. Стрелки двигают карту, плюс и минус меняют масштаб, Home возвращает к дому. Все места также доступны кнопками." />
    {!ready && <div className={styles.sceneLoading} role="status"><p>{error ?? "Раскрываем лес…"}</p>{error && <button onClick={() => setReload(value => value + 1)}>Загрузить карту</button>}</div>}
    <div className={styles.mapAnchors} hidden={!ready}>
      <button data-map-anchor data-x="463" data-y="290" onClick={() => onPlace("house")}><House size={15} /><span>Дом · {state.houseLevel} ур.</span></button>
      <button data-map-anchor data-x="260" data-y="430" onClick={() => onPlace("workshop")}><Hammer size={15} /><span>{state.workshop ? "Мастерская" : "Построить"}</span></button>
      <button data-map-anchor data-x="653" data-y="140" onClick={() => onPlace("journeys")}><Waves size={15} /><span>{state.houseLevel >= 2 ? "К ручью" : "Ручей · дом 2 ур."}</span></button>
      <button data-map-anchor data-x="640" data-y="550" onClick={() => onPlace("journeys")}><Compass size={15} /><span>Лесные тропы</span></button>
    </div>
    <div className={styles.cameraControls} aria-label="Управление картой">
      <button onClick={() => control("in")} disabled={!ready} aria-label="Приблизить карту"><Plus size={19} /></button>
      <button onClick={() => control("out")} disabled={!ready} aria-label="Отдалить карту"><Minus size={19} /></button>
      <button onClick={() => control("home")} disabled={!ready} aria-label="Вернуться камерой к дому"><LocateFixed size={19} /></button>
    </div>
    {journeyLabel(state, now) && <button className={styles.away} onClick={() => onPlace("journeys")}><Compass size={15} />{journeyLabel(state, now)}</button>}
  </div>;
}
