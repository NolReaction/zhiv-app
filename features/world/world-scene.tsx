"use client";
import { useEffect, useRef, useState } from "react";
import type { WorldState } from "./model";
import type { createWorldEngine, WorldPlace } from "./engine";
import styles from "./world.module.css";

export function WorldScene({ state, night, onPlace, gifts }: { state: WorldState; gifts: readonly string[]; night: boolean; onPlace: (place: WorldPlace) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Awaited<ReturnType<typeof createWorldEngine>> | null>(null);
  const latest = useRef({ state, night, onPlace, gifts });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { latest.current = { state, night, onPlace, gifts }; engine.current?.update(state, night, gifts); }, [state, night, onPlace, gifts]);
  useEffect(() => {
    let disposed = false;
    const node = canvas.current!;
    void import("./engine").then(module => module.createWorldEngine(node, latest.current.state, {
      night: latest.current.night, gifts: latest.current.gifts, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onPlace: place => latest.current.onPlace(place),
    })).then(value => {
      if (disposed) { value.dispose(); return; }
      engine.current = value; value.update(latest.current.state, latest.current.night, latest.current.gifts); setReady(true);
    }).catch(() => { if (!disposed) setError("Полянка не загрузилась. Постройки и путешествия доступны ниже."); });
    return () => { disposed = true; engine.current?.dispose(); engine.current = null; };
  }, []);
  return <div className={styles.scene} aria-busy={!ready && !error}>
    <canvas ref={canvas} width={320} height={320} tabIndex={0} role="img"
      aria-label={`Личная полянка. Домик уровня ${state.houseLevel}. ${state.journeys.length ? "Мохлик в путешествии." : "Нажмите на траву или используйте стрелки, чтобы Мохлик подошёл. Нажмите на него, чтобы поздороваться."} Постройки также доступны кнопками под полянкой.`} />
    {!ready && <p className={styles.sceneLoading} role="status">{error ?? "Открываем лесную тропинку…"}</p>}
    <div className={styles.sceneTitle}><span>{night ? "Ночной лес" : "Солнечная полянка"}</span><strong>Дом Мохлика</strong></div>
    {state.journeys.length > 0 && <div className={styles.away}>Мохлик исследует лес · полянка ждёт его</div>}
  </div>;
}
