"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Compass, X, Feather, Gem, Hammer, House, Leaf, LockKeyhole, Shirt, Sparkles, Sprout, Wind, Mountain } from "lucide-react";
import { GAME_ITEMS } from "@/features/game/game-rewards";
import type { WorldPortalProps } from "./world-portal";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorldScene } from "./world-scene";
import { canAfford, workshopLevel, worldCatalog as catalog } from "./model";
import type { WorldPlace } from "./map-engine";
import styles from "./world.module.css";
import { Materials, WorldJourneys } from "./world-journeys";
import { WorldFeedback } from "./world-feedback";
import { WorldBalances } from "./world-balances";

type Panel = "journeys" | "build" | "wardrobe" | "collection" | "stats" | "cave" | "fishing";
const findIcons = { leaf: Leaf, feather: Feather, sparkles: Sparkles, gem: Gem, wind: Wind };
export default function WorldView({ world, ownerPublicId, timeZone, onClose, displayName, level, wakeSignal, bestStreakDays, items }: WorldPortalProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const claim = useRef<{ id: string; owner: string } | null>(null);
  useEffect(() => {
    const pending = claim.current;
    if (!pending || world.busy || world.uncertain || !world.snapshot) return;
    if (pending.owner !== ownerPublicId || world.error) { claim.current = null; return; }
    if (!world.snapshot.state.journeys.some(journey => journey.id === pending.id)) {
      claim.current = null;
      const close = setTimeout(() => setPanel(null), 0);
      return () => clearTimeout(close);
    }
  }, [world.snapshot, world.busy, world.uncertain, world.error, ownerPublicId]);
  const confirming = (id: string) => { claim.current = { id, owner: ownerPublicId }; };
  const panelReturn = useRef<HTMLElement | null>(null);
  const openPanel = useCallback((next: Panel) => {
    if (panel === null) panelReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  }, [panel]);
  const [destination, setDestination] = useState<"trail" | "river">("trail");
  const onPlace = useCallback((place: WorldPlace) => {
    if (place === "cave" || place === "fishing") { openPanel(place); return; }
    if (place === "river" || place === "trail" || place === "journeys") { setDestination(place === "river" ? "river" : "trail"); openPanel("journeys"); }
    else openPanel(place === "wardrobe" ? "wardrobe" : "build");
  }, [openPanel]);
  const { snapshot, busy, uncertain, act } = world;
  if (!snapshot) return <section className={styles.loading} aria-live="polite"><button id="world-exit" onClick={onClose}><ArrowLeft size={18} />Назад</button><Compass size={32} /><h1>Лес Мохлика</h1>
    <p>{world.error ?? "Открываем вашу полянку…"}</p>{world.error && <button onClick={() => void world.retry()}>Попробовать ещё раз</button>}</section>;
  const state = snapshot.state;
  const shopLevel = workshopLevel(state);
  const shopCost = catalog.workshopUpgrades.find(c => c.level === shopLevel + 1);
  const locked = busy || uncertain;
  const houseCost = catalog.houseUpgrades.find(c => c.level === state.houseLevel + 1);
  const goal = !state.firstJourneyCompleted ? "Отправьте Мохлика на первую прогулку. Через минуту он принесёт материалы для домика."
    : state.houseLevel === 1 ? "Улучшите домик, чтобы открыть рыбалку у берега."
      : !state.workshop ? "Постройте мастерскую, чтобы делать одежду и пробовать новые цвета мха."
        : state.collection.length < catalog.finds.length ? "Исследуйте разные маршруты. За полный альбом Мохлик получит шляпу следопыта."
          : "Альбом собран! Примерьте шляпу следопыта и обустройте домик до пятого уровня.";
  return <section className={styles.world} aria-label="Лес Мохлика">
    <WorldScene state={state} gifts={snapshot.gifts} items={items} owner={ownerPublicId} now={world.now} timeZone={timeZone}
      onPlace={onPlace} bestStreakDays={bestStreakDays} wakeSignal={wakeSignal} />
    <header className={styles.hud}>
      <div className={styles.playerBar}>
        <button id="world-exit" onClick={onClose} aria-label="Вернуться к отметке Я живой"><ArrowLeft size={22} /></button>
        <button className={styles.player} onClick={() => openPanel("stats")} aria-label={`Статистика Мохлика. ${displayName}, уровень ${level}`}>
          <GameLevelIcon level={level} size={23} /><span><strong>{displayName}</strong><small>Уровень {level}</small></span>
        </button>
        <button className={styles.checkIn} onClick={() => openPanel("collection")} aria-label="Открыть коллекции"><BookOpen size={21} /><span>Коллекции</span></button>
      </div>
      <WorldBalances key={ownerPublicId} value={state.resources} />
    </header>
    {panel === null && <WorldFeedback world={world} />}
    <div className={styles.bottomHud}>
      <button className={styles.goalChip} onClick={() => openPanel(!state.firstJourneyCompleted ? "journeys" : state.houseLevel < 5 ? "build" : "collection")}><Sprout size={18} /><span>{!state.firstJourneyCompleted ? "Первая прогулка" : state.houseLevel < 5 ? "Обустроить дом" : "Лесной альбом"}</span><ChevronRight size={16} /></button>
      <nav className={styles.gameDock} aria-label="Действия в игре">
        <button onClick={() => openPanel("build")}><Hammer size={23} /><span>Строить</span></button>
        <button onClick={() => openPanel("wardrobe")}><Shirt size={23} /><span>Гардероб</span></button>
        <button onClick={() => openPanel("journeys")}><Compass size={23} /><span>В путь</span></button>
      </nav>
    </div>
    <Dialog open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
      <DialogPortal>
      <DialogOverlay className={styles.sheetScrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.sheet}
        onCloseAutoFocus={event => { event.preventDefault(); if (panelReturn.current?.isConnected) panelReturn.current.focus(); else document.getElementById("world-exit")?.focus(); }}>
        <div className={styles.sheetHeader}>
          <DialogTitle>{panel === "cave" ? "Пещера" : panel === "fishing" ? "Рыбалка" : panel === "build" ? "Постройки" : panel === "wardrobe" ? "Гардероб" : panel === "collection" ? "Коллекции" : panel === "stats" ? "Мой Мохлик" : "Путешествия"}</DialogTitle>
          <button onClick={() => setPanel(null)} aria-label="Закрыть панель"><X size={21} /></button>
        </div>
        <DialogDescription className={styles.sr}>Управление домом и путешествиями Мохлика</DialogDescription>
        <div className={styles.sheetBody}>
          {panel === "cave" && <div className={styles.destination}>
            <Mountain size={48} aria-hidden="true" />
            <h2>В разработке</h2>
            <p>Здесь появится новая карта пещеры.</p>
            <button onClick={() => setPanel(null)}><ArrowLeft size={18} />Вернуться в лес</button>
          </div>}
          {panel === "build" && <p className={styles.hint}>{goal}</p>}
          {panel === "journeys" && <WorldJourneys key={destination} world={world} destination={destination} onClaim={confirming} />}
          {panel === "fishing" && <WorldJourneys world={world} destination="river" onClaim={confirming} />}
        {panel === "build" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>СВОЁ МЕСТО В ЛЕСУ</span><h2>Больше уюта</h2><p>Улучшения открывают новые возможности.</p></div>
          {snapshot.gifts.length > 0 && <article className={styles.card}><h3>Подарки за отметки</h3><p>Уже украшают домик: {GAME_ITEMS.filter(item => snapshot.gifts.includes(item.id)).map(item => item.title.toLowerCase()).join(", ")}. Полученные подарки остаются и в этом мире.</p></article>}
          <article className={styles.card}><House className={styles.cardIcon} /><h3>Домик Мохлика <span className={styles.kicker}>ур. {state.houseLevel}/5</span></h3>
            <p>{state.houseLevel === 1 ? "Второй уровень открывает рыбалку у берега." : state.houseLevel < 5 ? "Развивайте домик и продолжайте исследовать лес." : "Достигнут максимальный уровень домика."} Новый внешний вид уровней пока в разработке.</p>
            {houseCost ? <><Materials cost={houseCost} /><button className={styles.primary} disabled={locked || !canAfford(state.resources, houseCost)} onClick={() => act("upgrade_house")}>{canAfford(state.resources, houseCost) ? `Улучшить до ${houseCost.level} уровня` : "Нужны материалы из путешествий"}</button></> : <span className={styles.kicker}><Check size={16} />Все улучшения открыты</span>}</article>
          <article className={styles.card}><Hammer className={styles.cardIcon} /><h3>Лесная мастерская <span className={styles.kicker}>{state.workshop ? `ур. ${shopLevel}/3` : "Ещё не построена"}</span></h3><p>Шарфы, головные уборы и новые оттенки мха. Всё сделанное остаётся в гардеробе.</p>
            {state.workshop ? <>
              <p>{shopCost ? "Мастерскую можно улучшить до следующего уровня." : "Достигнут максимальный уровень мастерской."}</p>
              {shopCost && <><Materials cost={shopCost} /><button className={styles.primary} disabled={locked || !canAfford(state.resources, shopCost)} onClick={() => act("upgrade_workshop")}>Улучшить до {shopCost.level} уровня</button></>}
              <button onClick={() => openPanel("wardrobe")}>Выбрать, что изготовить<ArrowRight size={16} /></button></> : <><Materials cost={catalog.workshop} /><button disabled={locked || !canAfford(state.resources, catalog.workshop)} onClick={() => act("build_workshop")}>{canAfford(state.resources, catalog.workshop) ? "Построить мастерскую" : "Накопите материалы на мастерскую"}</button></>}</article>
        </div>}
        {panel === "wardrobe" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ХАРАКТЕР В ДЕТАЛЯХ</span><h2>Твой Мохлик</h2><p>Одежда и оттенки мха видны и здесь, и в круглой кнопке.</p></div>
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
        {panel === "stats" && <div className={styles.statsPanel}>
          <div className={styles.statsIdentity}><GameLevelIcon level={level} size={42} /><h2>{displayName}</h2><span>Уровень {level}</span></div>
          <dl><div><dt>Домик</dt><dd>{state.houseLevel} / 5</dd></div><div><dt>Мастерская</dt><dd>{state.workshop ? `${shopLevel} / 3` : "Не построена"}</dd></div>
          <div><dt>Путешествия</dt><dd>{state.completedJourneys}</dd></div><div><dt>Лесные находки</dt><dd>{state.collection.length} / {catalog.finds.length}</dd></div>
          <div><dt>Гардероб</dt><dd>{state.inventory.length} вещей</dd></div><div><dt>Лучшая серия отметок</dt><dd>{bestStreakDays} дн.</dd></div></dl>
          <button onClick={() => openPanel("build")}><House size={18} />Обустроить дом</button>
        </div>}
        {panel === "collection" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ПАМЯТЬ О ПУТЕШЕСТВИЯХ</span><h2>Лесной альбом <small>{state.collection.length}/{catalog.finds.length}</small></h2><p>Каждый маршрут сначала приносит недостающие находки. Собери все шесть — получишь шляпу следопыта.</p></div>
          <div className={styles.collection}>{catalog.finds.map(find => {
            const owned = state.collection.includes(find.id), Icon = findIcons[find.symbol as keyof typeof findIcons] ?? Leaf;
            return <article key={find.id} className={styles.find} data-owned={owned}><Icon size={32} /><h3>{find.name}</h3><p>{find.description}</p><span className={styles.kicker}>{owned ? <><Check size={13} />В альбоме</> : "Ждёт на лесной тропе"}</span></article>;
          })}</div><p className={styles.hint}>Завершено путешествий: {state.completedJourneys}. Находки остаются навсегда.</p>
          <details className={styles.details}><summary>Подарки Мохлику · {snapshot.gifts.length}/{GAME_ITEMS.length}</summary>
            <div className={styles.collection}>{GAME_ITEMS.map(item => <article className={styles.find} data-owned={snapshot.gifts.includes(item.id)} key={item.id}>
              <h3>{item.title}</h3><span className={styles.kicker}>{snapshot.gifts.includes(item.id) ? "Украшает домик" : `За ${item.days} дней отметок подряд`}</span>
            </article>)}</div>
          </details>
        </div>}
          {panel === "stats" && <details className={styles.details}><summary><Sparkles size={16} />Откуда берутся искры?</summary>
            <p>Каждые {catalog.tapsPerSpark} засчитанных игровых тапов дают 1 искру. Сегодня получено {snapshot.dailySparksEarned} из {catalog.dailySparkLimit}. Лимит обновляется в 00:00 UTC.</p>
            <p>Материалы и дополнительные искры Мохлик приносит из путешествий.</p>
          </details>}
          <WorldFeedback world={world} />
        </div>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  </section>;
}
