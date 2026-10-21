"use client";

import { useEffect, useRef, useState } from "react";
import { WORLD_DEV_SCENE_ACTORS, type WorldDevSceneActor } from "./forest-scene-preview";
import { RESIDENT_STAND_ACTIONS, RESIDENT_STAND_DIRECTIONS, RESIDENT_STAND_FRAMES, RESIDENT_STAND_LABELS,
  advanceResidentStand, residentStandSprite, stepResidentStand } from "./resident-animation-stand";
import styles from "./world-dev-animation-stand.module.css";

const directionLabels = { front: "Спереди", back: "Сзади", left: "Слева", right: "Справа" };

export function WorldDevAnimationStand() {
  const [actor, setActor] = useState<WorldDevSceneActor>("lopukh"), [action, setAction] = useState("idle");
  const [paused, setPaused] = useState(true), [speed, setSpeed] = useState(1), [frame, setFrame] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d"); if (!context) return;
    context.clearRect(0, 0, 192, 48); context.imageSmoothingEnabled = false;
    for (const [index, direction] of RESIDENT_STAND_DIRECTIONS.entries())
      context.drawImage(residentStandSprite(actor, action, direction, frame), index * 48, 0);
  }, [actor, action, frame]);
  useEffect(() => {
    if (paused) return;
    let scheduled = 0, previous: number | null = null;
    const tick = (now: number) => {
      const delta = previous === null ? 0 : (now - previous) / 1000; previous = now;
      setFrame(current => advanceResidentStand(current, delta, speed, false, document.hidden));
      scheduled = requestAnimationFrame(tick);
    };
    const visibility = () => { previous = null; };
    document.addEventListener("visibilitychange", visibility); scheduled = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(scheduled); document.removeEventListener("visibilitychange", visibility); };
  }, [paused, speed]);
  return <section className={styles.stand} aria-label="Стенд анимаций жителей">
    <h4>Стенд анимаций</h4>
    <p>Все четыре поворота рядом, исходные пиксели увеличены. Часы карты и занятия жителей не меняются.</p>
    <div className={styles.fields}>
      <label>Житель<select value={actor} onChange={event => { setActor(event.target.value as WorldDevSceneActor); setAction("idle"); setFrame(0); }}>
        {WORLD_DEV_SCENE_ACTORS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>Действие<select value={action} onChange={event => { setAction(event.target.value); setFrame(0); }}>
        {RESIDENT_STAND_ACTIONS[actor].map(value => <option key={value} value={value}>{RESIDENT_STAND_LABELS[value]}</option>)}
      </select></label>
    </div>
    <div className={styles.viewport}><canvas ref={canvas} width={192} height={48} role="img" aria-label={`${WORLD_DEV_SCENE_ACTORS.find(item => item.id === actor)!.label}: четыре направления`} />
      <div className={styles.labels}>{RESIDENT_STAND_DIRECTIONS.map(direction => <span key={direction}>{directionLabels[direction]}</span>)}</div>
    </div>
    <div className={styles.controls}>
      <button type="button" onClick={() => setPaused(current => !current)}>{paused ? "Воспроизвести" : "Пауза"}</button>
      <button type="button" aria-label="Предыдущий кадр" onClick={() => { setPaused(true); setFrame(current => stepResidentStand(current, -1)); }}>← Кадр</button>
      <button type="button" aria-label="Следующий кадр" onClick={() => { setPaused(true); setFrame(current => stepResidentStand(current, 1)); }}>Кадр →</button>
    </div>
    <label className={styles.speed}>Скорость<select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
      <option value={1}>1×</option><option value={.5}>½×</option><option value={.25}>¼×</option>
    </select><output>Кадр {Math.floor(frame) + 1}/{RESIDENT_STAND_FRAMES}</output></label>
  </section>;
}
