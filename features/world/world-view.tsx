"use client";
import { useCallback, useState } from "react";
import { ArrowRight, BookOpen, Check, ChevronRight, Clock3, Compass, Feather, Gem, Hammer, House, Leaf, LockKeyhole, RefreshCw, Shirt, Sparkles, Sprout, Trees, Wind } from "lucide-react";
import { GAME_ITEMS } from "@/lib/game-rewards";
import { useWorld } from "./use-world";
import { WorldScene } from "./world-scene";
import { canAfford, worldCatalog as catalog, type WorldResources } from "./model";
import type { WorldPlace } from "./engine";
import styles from "./world.module.css";

type Panel = "journeys" | "build" | "wardrobe" | "collection";
const panels = [{ id: "journeys", name: "Карта", icon: Compass }, { id: "build", name: "Постройки", icon: House },
  { id: "wardrobe", name: "Гардероб", icon: Shirt }, { id: "collection", name: "Альбом", icon: BookOpen }] as const;
const findIcons = { leaf: Leaf, feather: Feather, sparkles: Sparkles, gem: Gem, wind: Wind };
function Materials({ cost }: { cost: WorldResources }) {
  return <span className={styles.materials}>
    {cost.sparks > 0 && <span><Sparkles size={14} aria-hidden />{cost.sparks}<span className={styles.sr}> искр</span></span>}
    {cost.wood > 0 && <span><Trees size={14} aria-hidden />{cost.wood}<span className={styles.sr}> древесины</span></span>}
    {cost.stone > 0 && <span><Gem size={14} aria-hidden />{cost.stone}<span className={styles.sr}> камня</span></span>}
  </span>;
}
const duration = (seconds: number) => seconds < 60 ? `${Math.max(0, seconds)} с` : `${Math.ceil(seconds / 60)} мин`;

export default function WorldView({ ownerPublicId, timeZone, onSessionLost }: { ownerPublicId: string; timeZone: string; onSessionLost: () => void }) {
  const world = useWorld(ownerPublicId, onSessionLost);
  const [panel, setPanel] = useState<Panel>("journeys");
  const [recalling, setRecalling] = useState<string | null>(null);
  const onPlace = useCallback((place: WorldPlace) => { setPanel(place === "journeys" ? "journeys" : "build"); document.getElementById("world-controls")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, []);
  const { snapshot, busy, uncertain, act } = world;
  if (!snapshot) return <section className={styles.loading} aria-live="polite"><Compass size={32} /><h1>Мир Мохлика</h1>
    <p>{world.error ?? "Открываем вашу полянку…"}</p>{world.error && <button onClick={world.retry}>Попробовать ещё раз</button>}</section>;
  const state = snapshot.state;
  const locked = busy || uncertain;
  const houseCost = catalog.houseUpgrades.find(c => c.level === state.houseLevel + 1);
  let hour = 12;
  try { hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(world.now)); } catch { /* Unknown legacy time zone uses daylight. */ }
  const goal = !state.firstJourneyCompleted ? "Отправьте Мохлика на первую прогулку. Через минуту он принесёт материалы для домика."
    : state.houseLevel === 1 ? "Улучшите домик: у Мохлика появится веранда, а на карте откроется ручей."
      : !state.workshop ? "Постройте мастерскую, чтобы делать одежду и пробовать новые цвета мха."
        : state.collection.length < catalog.finds.length ? "Исследуйте разные маршруты. За полный альбом Мохлик получит шляпу следопыта."
          : "Альбом собран! Примерьте шляпу следопыта и обустройте домик до третьего уровня.";
  return <section className={styles.world} aria-labelledby="world-title">
    <div className={styles.heading}><div><span className={styles.eyebrow}>МАЛЕНЬКИЙ ГЕРОЙ · БОЛЬШОЙ ЛЕС</span><h1 id="world-title">Твой мир растёт</h1></div>
      <button className={styles.refresh} onClick={() => void world.refresh()} disabled={busy} aria-label="Обновить мир"><RefreshCw size={18} /></button></div>
    <div className={styles.balances} aria-label="Ресурсы в аккаунте">
      <div><Sparkles /><span><strong>{state.resources.sparks}</strong> искры</span></div>
      <div><Trees /><span><strong>{state.resources.wood}</strong> дерево</span></div>
      <div><Gem /><span><strong>{state.resources.stone}</strong> камень</span></div>
    </div>
    <div className={styles.layout}>
      <div className={styles.plot}>
        <WorldScene state={state} gifts={snapshot.gifts} night={hour < 7 || hour >= 19} onPlace={onPlace} />
        <div className={styles.sceneActions}><button onClick={() => setPanel("build")}><House size={17} />Домик · {state.houseLevel} ур.</button>
          <button onClick={() => setPanel("wardrobe")}><Shirt size={17} />Переодеть</button><button onClick={() => setPanel("journeys")}><Compass size={17} />В путь</button></div>
        <p className={styles.hint}>Нажми на траву — Мохлик подойдёт. Нажми на него — поздоровается.</p>
        <div className={styles.goal}><Sprout size={22} /><div><strong>Следующий маленький шаг</strong><p>{goal}</p></div></div>
        <details className={styles.details}><summary><Sparkles size={16} />Откуда берутся искры?</summary>
          <p>Каждые {catalog.tapsPerSpark} засчитанных игровых тапов дают 1 искру. Сегодня получено {snapshot.dailySparksEarned} из {catalog.dailySparkLimit}. Новый лимит начинается в 00:00 UTC.</p>
          <p>Материалы и дополнительные искры Мохлик приносит из путешествий. Искры — внутренняя игровая валюта.</p>
        </details>
      </div>
      <div className={styles.controls} id="world-controls">
        <div className={styles.tabs} aria-label="Разделы мира">{panels.map(({ id, name, icon: Icon }) => <button key={id} aria-pressed={panel === id} onClick={() => setPanel(id)}><Icon size={20} /><span>{name}</span></button>)}</div>
        <div className={styles.feedback} aria-live="polite" aria-atomic="true">
          {world.error ? <p className={styles.error}>{world.error} <button disabled={busy} onClick={world.retry}>{uncertain ? "Проверить результат" : "Обновить"}</button></p>
            : <p>{busy ? "Сохраняем…" : world.notice}</p>}
        </div>
        {panel === "journeys" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>КАРТА ОКРЕСТНОСТЕЙ</span><h2>За поворотом тропы</h2><p>Выбери маршрут. Путешествие продолжается, даже когда приложение закрыто.</p></div>
          {state.journeys.map(j => {
            const seconds = Math.max(0, Math.ceil((Date.parse(j.finishesAt) - world.now) / 1000));
            const route = catalog.routes.find(r => r.id === j.routeId);
            return <article className={`${styles.card} ${styles.activeTrip}`} key={j.id}><span className={styles.kicker}><Clock3 size={15} />{seconds ? "Мохлик в пути" : "Мохлик вернулся"}</span>
              <h3>{route?.name ?? "Лесное путешествие"}</h3><p>{seconds ? `До возвращения ${duration(seconds)}` : "Пора узнать, что он нашёл!"}</p>
              <Materials cost={j.rewards} /><progress max={1} value={Math.min(1, Math.max(0, (world.now - Date.parse(j.startedAt)) / (Date.parse(j.finishesAt) - Date.parse(j.startedAt))))} aria-label="Пройденная часть маршрута" />
              {!seconds ? <button className={styles.primary} disabled={locked} onClick={() => act("claim_journey", j.id)}>Встретить Мохлика<ArrowRight size={16} /></button>
                : recalling === j.id ? <div><p>Вернуть домой сейчас? Материалы и находка останутся в лесу.</p><button disabled={locked} onClick={() => { act("recall_journey", j.id); setRecalling(null); }}>Вернуть без награды</button><button onClick={() => setRecalling(null)}>Продолжить путь</button></div>
                  : <button className={styles.textButton} disabled={locked} onClick={() => setRecalling(j.id)}>Позвать домой раньше</button>}</article>;
          })}
          <div className={styles.routeList}>{catalog.routes.filter(r => !r.once || !state.firstJourneyCompleted).map((route, index) => {
            const gate = route.houseLevel > state.houseLevel;
            return <article className={styles.card} key={route.id}><div className={styles.cardTop}><span className={styles.routeNumber}>0{index + 1}</span><span className={styles.kicker}><Clock3 size={14} />{duration(route.seconds)}</span></div>
              <h3>{route.name}</h3><p>{route.description}</p><Materials cost={route} />
              <div className={styles.routeFinds}>{route.finds.map(id => <span key={id}>{state.collection.includes(id) ? <Check size={12} /> : <Leaf size={12} />}{catalog.finds.find(f => f.id === id)?.name}</span>)}</div>
              <button className={route.once ? styles.primary : undefined} disabled={locked || gate || state.journeys.length > 0} onClick={() => act("start_journey", route.id)}>
                {gate ? <><LockKeyhole size={15} />Домик {route.houseLevel} уровня</> : state.journeys.length ? "Дождитесь Мохлика" : <>Отправиться<ChevronRight size={16} /></>}</button>
            </article>;
          })}</div>
        </div>}
        {panel === "build" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>СВОЁ МЕСТО В ЛЕСУ</span><h2>Больше уюта</h2><p>Постройки меняют полянку и открывают новые возможности.</p></div>
          {snapshot.gifts.length > 0 && <article className={styles.card}><h3>Подарки за отметки</h3><p>Уже украшают домик: {GAME_ITEMS.filter(item => snapshot.gifts.includes(item.id)).map(item => item.title.toLowerCase()).join(", ")}. Полученные подарки остаются и в этом мире.</p></article>}
          <article className={styles.card}><House className={styles.cardIcon} /><h3>Домик Мохлика <span className={styles.kicker}>ур. {state.houseLevel}/3</span></h3>
            <p>{state.houseLevel === 1 ? "Уютная веранда и маршрут к ручью откроются на втором уровне." : state.houseLevel === 2 ? "Третий уровень — большой лесной дом с башенкой и своим садиком." : "Большой лесной дом готов. Здесь Мохлика всегда ждут."}</p>
            {houseCost ? <><Materials cost={houseCost} /><button className={styles.primary} disabled={locked || !canAfford(state.resources, houseCost)} onClick={() => act("upgrade_house")}>{canAfford(state.resources, houseCost) ? `Улучшить до ${houseCost.level} уровня` : "Нужны материалы из путешествий"}</button></> : <span className={styles.kicker}><Check size={16} />Все улучшения открыты</span>}</article>
          <article className={styles.card}><Hammer className={styles.cardIcon} /><h3>Лесная мастерская</h3><p>Шарфы, головные уборы и новые оттенки мха. Всё сделанное остаётся в гардеробе.</p>
            {state.workshop ? <button onClick={() => setPanel("wardrobe")}>Выбрать, что изготовить<ArrowRight size={16} /></button> : <><Materials cost={catalog.workshop} /><button disabled={locked || !canAfford(state.resources, catalog.workshop)} onClick={() => act("build_workshop")}>{canAfford(state.resources, catalog.workshop) ? "Построить мастерскую" : "Накопите материалы на мастерскую"}</button></>}</article>
        </div>}
        {panel === "wardrobe" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ХАРАКТЕР В ДЕТАЛЯХ</span><h2>Твой Мохлик</h2><p>Первый янтарный шарф уже в рюкзаке. Примерь его!</p></div>
          <div className={styles.wardrobe}>{catalog.items.map(item => {
            const owned = state.inventory.includes(item.id), equipped = Object.values(state.equipment).includes(item.id);
            return <article key={item.id} className={styles.item} data-owned={owned}><span className={styles.itemSwatch} style={{ background: item.color }}><span>{item.slot === "palette" ? <Leaf /> : item.slot === "head" ? <Compass /> : <Shirt />}</span></span>
              <div><h3>{item.name}</h3><p>{item.slot === "palette" ? "Цвет мха" : item.slot === "head" ? "Головной убор" : "Шарф"}</p></div>
              {owned ? <button disabled={locked || equipped && item.slot === "palette"} onClick={() => act("equip", equipped ? `remove_${item.slot}` : item.id)}>{equipped ? item.slot === "palette" ? "Выбран" : "Снять" : "Надеть"}</button>
                : item.id === "explorer_cap" ? <span className={styles.kicker}><LockKeyhole size={13} />За полный альбом</span>
                  : <button disabled={locked || !state.workshop || state.resources.sparks < item.sparks} onClick={() => act("craft", item.id)}>{!state.workshop ? "Нужна мастерская" : <>Создать · {item.sparks}<Sparkles size={13} /></>}</button>}
            </article>;
          })}</div>
        </div>}
        {panel === "collection" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ПАМЯТЬ О ПУТЕШЕСТВИЯХ</span><h2>Лесной альбом <small>{state.collection.length}/{catalog.finds.length}</small></h2><p>Каждый маршрут сначала приносит недостающие находки. Собери все шесть — получишь шляпу следопыта.</p></div>
          <div className={styles.collection}>{catalog.finds.map(find => {
            const owned = state.collection.includes(find.id), Icon = findIcons[find.symbol as keyof typeof findIcons] ?? Leaf;
            return <article key={find.id} className={styles.find} data-owned={owned}><Icon size={32} /><h3>{find.name}</h3><p>{find.description}</p><span className={styles.kicker}>{owned ? <><Check size={13} />В альбоме</> : "Ждёт на лесной тропе"}</span></article>;
          })}</div><p className={styles.hint}>Завершено путешествий: {state.completedJourneys}. Находки остаются навсегда.</p>
        </div>}
      </div>
    </div>
  </section>;
}
