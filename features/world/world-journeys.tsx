"use client";
import { useState } from "react";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Clock3, FlaskConical, Gem, Leaf, LockKeyhole, Sparkles, Trees } from "lucide-react";
import { worldCatalog as catalog, type WorldResources } from "./model";
import type { WorldController } from "./use-world";
import { JourneyProgress } from "./journey-progress";
import styles from "./world.module.css";

export function Materials({ cost }: { cost: WorldResources }) {
  return <span className={styles.materials}>
    {cost.sparks > 0 && <span><Sparkles size={14} aria-hidden />{cost.sparks}<span className={styles.sr}> искр</span></span>}
    {cost.wood > 0 && <span><Trees size={14} aria-hidden />{cost.wood}<span className={styles.sr}> древесины</span></span>}
    {cost.stone > 0 && <span><Gem size={14} aria-hidden />{cost.stone}<span className={styles.sr}> камня</span></span>}
  </span>;
}
export function WorldJourneys({ world, destination }: { world: WorldController; destination: "trail" | "river" }) {
  const [selected, setSelected] = useState(destination);
  const [recalling, setRecalling] = useState<string | null>(null);
  if (!world.snapshot) return null;
  const state = world.snapshot.state, locked = world.busy || world.uncertain;
  const routes = catalog.routes.filter(route => (selected === "river" ? route.id === "brook_path" : route.id !== "brook_path") && (!route.once || !state.firstJourneyCompleted));
  const switchRoute = () => setSelected(value => value === "river" ? "trail" : "river");
  return <div className={styles.panel}>
    <div className={styles.routeChooser}>
      <Image src={`/world/route-${selected}.webp`} alt="" width={600} height={400} unoptimized />
      <div><button onClick={switchRoute} aria-label={selected === "trail" ? "Выбрать реку" : "Выбрать лесную тропу"}><ArrowLeft size={20} /></button>
        <span aria-live="polite"><strong>{selected === "trail" ? "Лесная тропа" : "Река и ручей"}</strong><small>{selected === "trail" ? "1 / 2" : "2 / 2"}</small></span>
        <button onClick={switchRoute} aria-label={selected === "trail" ? "Выбрать реку" : "Выбрать лесную тропу"}><ArrowRight size={20} /></button></div>
    </div>
    {state.journeys.map(journey => {
      const ready = world.now >= Date.parse(journey.finishesAt);
      return <article className={`${styles.card} ${styles.activeTrip}`} key={journey.id}>
        <JourneyProgress journey={journey} equipment={state.equipment} now={world.now} />
        {ready ? <button className={styles.primary} disabled={locked} onClick={() => world.act("claim_journey", journey.id)}>Забрать находки<ArrowRight size={16} /></button>
          : recalling === journey.id ? <div><p>Вернуть домой без награды?</p><button disabled={locked} onClick={() => { world.act("recall_journey", journey.id); setRecalling(null); }}>Вернуть</button><button onClick={() => setRecalling(null)}>Продолжить путь</button></div>
            : <button className={styles.textButton} disabled={locked} onClick={() => setRecalling(journey.id)}>Позвать домой</button>}
      </article>;
    })}
    {routes.map(route => {
      const gate = route.houseLevel > state.houseLevel;
      return <article className={styles.card} key={route.id}>
        <div className={styles.cardTop}><h3>{route.name}</h3><span className={styles.kicker}><Clock3 size={14} />{route.seconds / 60} мин</span></div>
        <Materials cost={route} />
        <div className={styles.routeFinds}>{route.finds.map(id => <span key={id}>{state.collection.includes(id) ? <Check size={12} /> : <Leaf size={12} />}{catalog.finds.find(find => find.id === id)?.name}</span>)}</div>
        <button className={styles.primary} disabled={locked || gate || state.journeys.length > 0} onClick={() => world.act("start_journey", route.id)}>
          {gate ? <><LockKeyhole size={15} />Нужен дом {route.houseLevel} уровня</> : state.journeys.length ? "Мохлик в пути" : <>Отправиться<ChevronRight size={16} /></>}
        </button>
      </article>;
    })}
    {process.env.NODE_ENV === "development" && world.snapshot.devTools && <div className={styles.devTools}>
      <button disabled={locked} onClick={() => world.act("dev_grant_resources")}><FlaskConical size={17} />Тест: +50 каждого ресурса</button>
      <small>Искры, дерево и камень · только локальная разработка</small>
    </div>}
  </div>;
}
