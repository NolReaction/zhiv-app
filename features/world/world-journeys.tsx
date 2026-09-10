"use client";
import { useState } from "react";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Clock3, FlaskConical, Gem, Leaf, LockKeyhole, Sparkles, Trees } from "lucide-react";
import { worldCatalog as catalog, type WorldResources } from "./model";
import type { WorldController } from "./use-world";
import { JourneyProgress } from "./journey-progress";
import { WORLD_ART } from "./art";
import { isFishingJourney, journeyPhaseLabel } from "./journey-timeline";
import styles from "./world.module.css";

export function Materials({ cost }: { cost: WorldResources }) {
  return <span className={styles.materials}>
    {cost.sparks > 0 && <span><Sparkles size={14} aria-hidden />{cost.sparks}<span className={styles.sr}> искр</span></span>}
    {cost.wood > 0 && <span><Trees size={14} aria-hidden />{cost.wood}<span className={styles.sr}> древесины</span></span>}
    {cost.stone > 0 && <span><Gem size={14} aria-hidden />{cost.stone}<span className={styles.sr}> камня</span></span>}
  </span>;
}
export function WorldJourneys({ world, destination, onClaim }: { world: WorldController; destination: "trail" | "river"; onClaim?: (id: string) => void }) {
  const [selected, setSelected] = useState(destination);
  const [recalling, setRecalling] = useState<string | null>(null);
  const [fishingMinutes, setFishingMinutes] = useState(15);
  if (!world.snapshot) return null;
  const state = world.snapshot.state, locked = world.busy || world.uncertain;
  const routes = catalog.routes.filter(route => (selected === "river" ? route.id === `fishing_${fishingMinutes}` : !isFishingJourney({ routeId: route.id })) && (!route.once || !state.firstJourneyCompleted));
  const switchRoute = () => setSelected(value => value === "river" ? "trail" : "river");
  return <div className={styles.panel}>
    <div className={styles.routeChooser}>
      {selected === "river" ? <div className={styles.fishingPreview} style={{ backgroundImage: `url(${WORLD_ART.map})` }} role="img" aria-label="Берег для рыбалки на карте Мохлика" />
        : <Image src={WORLD_ART.routes.trail} alt="" width={600} height={400} unoptimized />}
      <div><button onClick={switchRoute} aria-label={selected === "trail" ? "Выбрать рыбалку" : "Выбрать лесную тропу"}><ArrowLeft size={20} /></button>
        <span aria-live="polite"><strong>{selected === "trail" ? "Лесная тропа" : "Рыбалка у берега"}</strong><small>{selected === "trail" ? "1 / 2" : "2 / 2"}</small></span>
        <button onClick={switchRoute} aria-label={selected === "trail" ? "Выбрать рыбалку" : "Выбрать лесную тропу"}><ArrowRight size={20} /></button></div>
    </div>
    {state.journeys.map(journey => {
      const ready = world.now >= Date.parse(journey.finishesAt);
      return <article className={`${styles.card} ${styles.activeTrip}`} key={journey.id}>
        <JourneyProgress journey={journey} equipment={state.equipment} now={world.now} />
        <p className={styles.tripStatus}>{journeyPhaseLabel(journey, world.now)}{!ready && ` · ещё ${Math.ceil((Date.parse(journey.finishesAt) - world.now) / 60000)} мин`}</p>
        {ready ? <button className={styles.primary} disabled={locked} onClick={() => { onClaim?.(journey.id); world.act("claim_journey", journey.id); }}>Подтвердить возвращение<ArrowRight size={16} /></button>
          : recalling === journey.id ? <div><p>Вернуть домой без награды?</p><button disabled={locked} onClick={() => { world.act("recall_journey", journey.id); setRecalling(null); }}>Вернуть</button><button onClick={() => setRecalling(null)}>Продолжить путь</button></div>
            : <button className={styles.textButton} disabled={locked} onClick={() => setRecalling(journey.id)}>Позвать домой</button>}
      </article>;
    })}
    {selected === "river" && <>
      <div className={styles.fishingModes} role="group" aria-label="Длительность рыбалки вместе с дорогой">
        {[5, 15, 30, 60].map(minutes => <button key={minutes} aria-pressed={minutes === fishingMinutes} onClick={() => setFishingMinutes(minutes)}>{minutes} мин</button>)}
      </div>
      <p className={styles.hint}>45 секунд до берега, рыбалка и 45 секунд домой — всё входит в выбранное время. Удочка с собой; рыбок Мохлик отпускает, материалы собирает по дороге.</p>
    </>}
    {routes.map(route => {
      const gate = route.houseLevel > state.houseLevel;
      return <article className={styles.card} key={route.id}>
        <div className={styles.cardTop}><h3>{route.name}</h3><span className={styles.kicker}><Clock3 size={14} />{route.seconds / 60} мин</span></div>
        <Materials cost={route} />
        <div className={styles.routeFinds}>{route.finds.map(id => <span key={id}>{state.collection.includes(id) ? <Check size={12} /> : <Leaf size={12} />}{catalog.finds.find(find => find.id === id)?.name}</span>)}</div>
        <button className={styles.primary} disabled={locked || gate || state.journeys.length > 0} onClick={() => world.act("start_journey", route.id)}>
          {gate ? <><LockKeyhole size={15} />Нужен дом {route.houseLevel} уровня</> : state.journeys.length ? "Сначала завершите прогулку" : <>{selected === "river" ? "На рыбалку" : "Отправиться"}<ChevronRight size={16} /></>}
        </button>
      </article>;
    })}
    {process.env.NODE_ENV === "development" && world.snapshot.devTools && <div className={styles.devTools}>
      <button disabled={locked} onClick={() => world.act("dev_grant_resources")}><FlaskConical size={17} />Тест: +50 каждого ресурса</button>
      <small>Искры, дерево и камень · только локальная разработка</small>
    </div>}
  </div>;
}
