"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { FishingSceneCanvas } from "@/features/economy/ui/boat/scene/fishing-scene-canvas";
import type { FishingSceneFrame } from "@/features/economy/ui/boat/scene/fishing-scene-types";
import styles from "./boat-water-preview.module.css";

type PreviewStage = "waiting" | "casting" | "soaking" | "bite" | "reeling";
type PreviewSession = { stage: PreviewStage; held: boolean; paused: boolean; castKey?: string; revision: number };

const captions: Record<PreviewStage, string> = {
  waiting: "Лодка спокойно покачивается на воде",
  casting: "Заброс — смотри на отклик корпуса",
  soaking: "Поплавок на воде, ждём поклёвку",
  bite: "Поклёвка — почувствуй движение лодки",
  reeling: "Меняй усилие и наблюдай за лодкой",
};
const daylight = { day: Date.UTC(2026, 6, 14, 9), evening: Date.UTC(2026, 6, 14, 17) };

/** Presentation-only harness. It has no economy controller, saved player data, or catch completion. */
export function BoatWaterPreview() {
  const [session, setSession] = useState<PreviewSession>({ stage: "waiting", held: false, paused: false, revision: 0 });
  const [repaired, setRepaired] = useState(false);
  const [crate, setCrate] = useState(false);
  const [light, setLight] = useState<keyof typeof daylight>("day");
  const castCounter = useRef(0);
  const flight = useRef({ key: "", remaining: 1200 });

  useEffect(() => {
    if (session.stage !== "casting" || session.paused || !session.castKey) return;
    const key = session.castKey;
    const timing = flight.current.key === key ? flight.current : { key, remaining: 1200 };
    flight.current = timing;
    const started = performance.now();
    const timeout = window.setTimeout(() => {
      timing.remaining = 0;
      setSession(current => current.castKey === key && current.stage === "casting" && !current.paused
        ? { ...current, stage: "soaking" } : current);
    }, timing.remaining);
    return () => {
      window.clearTimeout(timeout);
      timing.remaining = Math.max(0, timing.remaining - (performance.now() - started));
    };
  }, [session.stage, session.paused, session.castKey]);

  const frame = useMemo<FishingSceneFrame>(() => ({
    stage: session.paused ? "paused" : session.stage,
    held: session.held,
    castKey: session.castKey,
    sceneKey: `boat-water-preview.${session.revision}`,
    ambience: { now: daylight[light], timeZone: "Europe/Moscow" },
    resistance: "steady",
    resistancePhase: session.held ? "surging" : "cruising",
    reel: session.stage === "bite" || session.stage === "reeling"
      ? { bar: session.held ? 5200 : 4600, fish: 5800, progress: 4000, zoneWidth: 3200 } : undefined,
    boat: { repaired, upgrades: crate ? ["crate"] : [] },
  }), [session, repaired, crate, light]);

  const cast = () => {
    castCounter.current += 1;
    setSession(current => ({ ...current, stage: "casting", held: false, paused: false, castKey: `water-demo-cast.${castCounter.current}` }));
  };
  const act = (stage: PreviewStage, held: boolean) => setSession(current => current.paused ? current : { ...current, stage, held });
  const hasLine = Boolean(session.castKey) && session.stage !== "casting";
  const canPull = session.stage === "bite" || session.stage === "reeling";

  return <main className={styles.page} data-boat-water-preview>
    <FishingSceneCanvas frame={frame} className={styles.canvas} />
    <header className={styles.header}>
      <div className={styles.heading}>
        <h1>Проверка плавания</h1>
        <p>Демонстрационная сцена, без выдачи наград</p>
      </div>
      <nav className={styles.navigation} aria-label="Переходы">
        <Link href="/prototype/boat-workshop">Мастерская</Link>
        <Link href="/">В игру</Link>
      </nav>
    </header>
    <section className={styles.dock} aria-label="Управление лодкой">
      <p className={styles.caption} role="status" aria-live="polite">
        {session.paused ? "Пауза — продолжи с того же движения" : captions[session.stage]}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={cast} disabled={session.paused}>Забросить</button>
        <button type="button" onClick={() => act("bite", false)} disabled={session.paused || !hasLine}>Поклёвка</button>
        <button type="button" onClick={() => act("reeling", true)} disabled={session.paused || !canPull} aria-pressed={session.held}>Тянуть</button>
        <button type="button" onClick={() => act("reeling", false)} disabled={session.paused || !canPull}>Отпустить</button>
        <button type="button" onClick={() => setSession(current => ({ ...current, paused: !current.paused }))} aria-pressed={session.paused}>
          {session.paused ? "Продолжить" : "Пауза"}
        </button>
        <button type="button" onClick={() => setSession(current => ({ stage: "waiting", held: false, paused: false, revision: current.revision + 1 }))}>Сбросить</button>
      </div>
      <div className={styles.options}>
        <fieldset className={styles.optionGroup}>
          <legend className={styles.srOnly}>Корпус</legend><span className={styles.optionName} aria-hidden="true">Корпус</span>
          <button type="button" onClick={() => setRepaired(false)} aria-pressed={!repaired} aria-label="Корпус L0">L0</button>
          <button type="button" onClick={() => setRepaired(true)} aria-pressed={repaired} aria-label="Корпус L1">L1</button>
        </fieldset>
        <fieldset className={styles.optionGroup}>
          <legend className={styles.srOnly}>Освещение</legend>
          <button type="button" onClick={() => setLight("day")} aria-pressed={light === "day"}>День</button>
          <button type="button" onClick={() => setLight("evening")} aria-pressed={light === "evening"}>Вечер</button>
        </fieldset>
        <label className={styles.holdUpgrade}><input type="checkbox" checked={crate} onChange={event => setCrate(event.target.checked)} />Улучшенный трюм</label>
      </div>
    </section>
  </main>;
}
