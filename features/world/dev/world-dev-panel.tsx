"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, FlaskConical, RotateCcw, X } from "lucide-react";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { worldCatalog } from "../model";
import { TILED_WORLD } from "../presentation";
import { clearingRouteDiagnostics } from "../clearing-activity";
import { compileWorldInteractions, WORLD_INTERACTION_LIMITS } from "../interaction-navigation";
import { previewWorldScene } from "../tiled/preview-state";
import type { WorldController } from "../use-world";
import { WorldAiDiagnostics } from "./world-ai-diagnostics";
import { ForestGardenDiagnostics } from "./forest-ai-diagnostics";
import { useForestObservation } from "../use-forest-observation";
import type { ForestGardenObservation, ForestObservation } from "../forest-observer";
import { WORLD_DEV_DEFAULTS, WORLD_DEV_ENABLED, WORLD_DEV_POSES, worldDevStore, type WorldDevLifeAction, type WorldDevState } from "./world-dev-store";
import styles from "./world-dev-panel.module.css";

export type WorldDevPanelProps = {
  world: WorldController;
  active?: boolean;
  worldView?: boolean;
  presenceKey?: string;
  onOpenWorld?: () => void;
  onOpenCalendar?: () => void;
  onOpenGame?: () => void;
  onOpenStatus?: () => void;
  onOpenWardrobe?: () => void;
  onOpenCollection?: () => void;
};
type ManualAction = { kind: "pose"; pose: PixelPose } | { kind: "birds" } | { kind: "life"; action: WorldDevLifeAction };

const POSE_LABELS: Record<PixelPose, string> = {
  idle: "Покой", walk: "Шаги", blink: "Моргнуть", sleep: "Сон", drowsy: "Дремота",
  stretch: "Потянуться", crouch: "Присесть", jump: "Прыжок", groom: "Умыться", greet: "Приветствие",
  sniff: "Принюхаться", reach: "Потянуть лапы", hold: "Держать", chew: "Жевать", swallow: "Проглотить",
  scratch: "Почесаться", yawn: "Зевнуть", shake: "Отряхнуться", sneeze: "Чихнуть", wonder: "Удивиться",
  carry: "Нести", toss: "Подбросить", present: "Показать находку", fish: "Рыбачить", "fishing-walk": "Идти с удочкой",
};
const WEATHER = [["auto", "По расписанию"], ["clear", "Ясно"], ["drizzle", "Морось"], ["rain", "Дождь"], ["downpour", "Ливень"]] as const;
const TIME = [["auto", "По времени профиля"], ["day", "День"], ["night", "Ночь"]] as const;
const MODES = [["auto", "Авто"], ["on", "Включить"], ["off", "Выключить"]] as const;
const routeReasons: Record<string, string> = {
  "missing-actor": "Нет корректной точки Мохлика.", "invalid-points": "Нужны от 2 до 64 вершин линии.",
  "start-away-from-spawn": "Первая вершина должна совпадать с точкой Мохлика.", "invalid-focus": "Проверьте область фокуса круга.",
  "invalid-activity": "Неизвестное занятие в конце маршрута.", "invalid-pause": "Пауза должна быть от 2 до 20 секунд.",
  "outside-clearing-radius": "Маршрут уходит слишком далеко от домашней точки.", "outside-map": "Герой выходит за край карты.",
  "outside-focus": "Герой не помещается в круг главного экрана.", "building-collision": "Лапы пересекают коллизию здания.",
  "invalid-home-site": "Домашнему маршруту нужен siteId = home.", "missing-home-site": "Не найден дом или точка входа.",
  "home-end-away-from-entry": "Последняя вершина должна совпадать с home-entry.",
  "invalid-doorway": `Порог должен находиться не дальше ${WORLD_INTERACTION_LIMITS.homeThreshold.toLocaleString("ru-RU")} ед. карты от входа.`,
  "missing-bush": "Маршруту нужны behavior = clearing и bushId существующего куста.",
  "invalid-bush": "Проверьте контур и точки куста: укрытие должно находиться внутри контура.",
  "bush-end-away-from-entry": "Последняя вершина маршрута должна совпадать с точкой входа в куст.",
  "invalid-bush-corridor": `От входа в куст до укрытия должно быть не меньше 0,1 размера Мохлика и не больше ${WORLD_INTERACTION_LIMITS.bushJump.toLocaleString("ru-RU")} ед. карты.`,
  "water-collision": "Маршрут проходит по воде.", "invalid-length": "Маршрут слишком короткий или длинный для полянки.",
  "missing-navigation": "Нужны доступная WalkAreas и корректный размер Мохлика.",
  "unreachable-door-entry": "Подведите WalkAreas ближе к home-entry; снаружи порога нужен запас для лап.",
  "unreachable-bush-entry": "Точка входа в куст должна стоять на свободной земле с запасом для лап.",
  "blocked-doorway": "Переход через порог пересекает воду, препятствие или другое здание.",
  "blocked-bush-corridor": "Прыжку в куст мешают вода, препятствие или здание.",
};
const DIRECTIONS = [["front", "Лицом"], ["back", "Спиной"], ["left", "Влево"], ["right", "Вправо"]] as const;
const LIFE_ACTIONS = [
  ["butterfly", "Поиграть с бабочкой"], ["firefly", "Поиграть со светлячком"],
  ["mushroom", "Съесть гриб"], ["leaf", "Рассмотреть листик"],
  ["bush", "Спрятаться в кусте"],
  ["home-sleep", "Отправиться спать домой"], ["wake", "Разбудить Мохлика"], ["grow-mushrooms", "Вырастить грибы"], ["idle", "Отменить сценку"],
] as const satisfies readonly (readonly [WorldDevLifeAction, string])[];
const GARDEN_ACTIONS = [["water-bush", "Полить куст"], ["harvest-berries", "Собрать ягоды"],
  ["grow-berries", "Созреть ягодам · DEV"], ["idle", "Отменить занятие"]] as const satisfies readonly (readonly [WorldDevLifeAction, string])[];
const lifeActionLabel = (action: WorldDevLifeAction) => [...LIFE_ACTIONS, ...GARDEN_ACTIONS].find(([kind]) => kind === action)?.[1] ?? action;

/** Only known current constraints are disabled here; pathfinding remains the director's responsibility. */
export function gardenDevActionUnavailable(action: WorldDevLifeAction, garden: ForestGardenObservation | undefined, state: WorldDevState) {
  if (!["water-bush", "harvest-berries", "grow-berries"].includes(action)) return null;
  if (!garden) return "Дождитесь загрузки ягодного куста и корзинки.";
  if (!garden.bushes.length) return "Нет ягодного куста с точкой подхода. Проверьте Bushes в Tiled.";
  if (action === "grow-berries") return null;
  if (state.navigationMode === "routes") return "Для занятий с кустом выберите Отладка → Пути → Свободная полянка.";
  if (state.weather === "rain" || state.weather === "downpour") return "Во время сильного дождя Мохлик не занимается кустом.";
  return action === "water-bush" ? garden.waterReason : garden.harvestReason;
}

function subscribeMotion(listener: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const systemMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const serverMotion = () => false;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className={styles.toggle}><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function Select<T extends string>({ label, value, values, onChange }: {
  label: string; value: T; values: readonly (readonly [T, string])[]; onChange: (value: T) => void;
}) {
  return <Field label={label}><select value={value} onChange={event => onChange(event.target.value as T)}>
    {values.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
  </select></Field>;
}

function Section({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  return <details className={styles.section} open={initiallyOpen || undefined}>
    <summary>{title}<ChevronDown size={16} aria-hidden /></summary><div className={styles.sectionBody}>{children}</div>
  </details>;
}

const DEV_TABS = [["mochlik", "Мохлик"], ["world", "Мир"], ["buildings", "Здания"], ["ai", "AI"], ["debug", "Отладка"]] as const;
const MOCHLIK_TABS = [["scenes", "Сценки"], ["activities", "Занятия"], ["animation", "Анимации"], ["appearance", "Внешность"]] as const;
const DEBUG_TABS = [["overlays", "Разметка"], ["routes", "Пути"], ["app", "Приложение"]] as const;
type DevTab = typeof DEV_TABS[number][0];
type MochlikTab = typeof MOCHLIK_TABS[number][0];
type DebugTab = typeof DEBUG_TABS[number][0];
type DevPage = Exclude<DevTab, "mochlik" | "debug"> | MochlikTab | DebugTab;

/** Automatic activation: arrow keys move within this tablist; Tab enters its panel. */
export function WorldDevTabs<T extends string>({ id, label, tabs, selected, onSelect, secondary = false }: {
  id: string; label: string; tabs: readonly (readonly [T, string])[]; selected: T;
  onSelect: (tab: T) => void; secondary?: boolean;
}) {
  function navigate(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    onSelect(tabs[next][0]);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus({ preventScroll: true });
  }
  return <div className={secondary ? styles.subtabs : styles.tabs} role="tablist" aria-label={label}>
    {tabs.map(([tab, title], index) => <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`}
      aria-selected={selected === tab} aria-controls={`${id}-panel-${tab}`} tabIndex={selected === tab ? 0 : -1}
      onClick={() => onSelect(tab)} onKeyDown={event => navigate(event, index)}>{title}</button>)}
  </div>;
}

/** The whole drawer is absent from production; visual settings never become game commands. */
export function WorldDevPanel(props: WorldDevPanelProps) {
  return WORLD_DEV_ENABLED ? <DevelopmentPanel {...props} /> : null;
}

function DevelopmentPanel({ world, active = true, worldView = false, presenceKey, onOpenWorld, onOpenCalendar, onOpenGame, onOpenStatus, onOpenWardrobe, onOpenCollection }: WorldDevPanelProps) {
  const state = useSyncExternalStore(worldDevStore.subscribe, worldDevStore.getSnapshot, worldDevStore.getServerSnapshot);
  const prefersReducedMotion = useSyncExternalStore(subscribeMotion, systemMotion, serverMotion);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DevTab>("mochlik");
  const [mochlikTab, setMochlikTab] = useState<MochlikTab>("scenes");
  const [debugTab, setDebugTab] = useState<DebugTab>("overlays");
  const [selectedPose, setSelectedPose] = useState<PixelPose>("greet");
  const scrollPositions = useRef<Partial<Record<DevPage, number>>>({});
  const page: DevPage = tab === "mochlik" ? mochlikTab : tab === "debug" ? debugTab : tab;
  const [lastAction, setLastAction] = useState<ManualAction | null>(null);
  const [feedback, setFeedback] = useState("");
  const observation = useForestObservation(active && (open || lastAction?.kind === "life"
    && ["water-bush", "harvest-berries", "grow-berries"].includes(lastAction.action)) ? presenceKey : undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const titleId = `${id}-title`, drawerId = `${id}-drawer`;

  useEffect(() => {
    if (!active || !open) return;
    closeButton.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      setOpen(false); trigger.current?.focus({ preventScroll: true });
    };
    // Run before the enclosing Radix world dialog's document capture listener.
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open, active]);

  if (!active) return null;

  const overrides = (Object.keys(WORLD_DEV_DEFAULTS) as (keyof WorldDevState)[])
    .filter(key => !["animation", "lifeEvent", "birdEvent", "cameraEvent", "artError"].includes(key)
      && JSON.stringify(state[key]) !== JSON.stringify(WORLD_DEV_DEFAULTS[key])).length;
  const reduced = state.reducedMotion === "on" || state.reducedMotion === "auto" && prefersReducedMotion;
  const motionUnavailable = state.paused ? "Сцена на паузе. Снимите паузу для проигрывания событий."
    : reduced ? "Для анимаций: Мир → Меньше движения → Выключить." : null;
  const heroUnavailable = motionUnavailable ?? (!state.showHero ? "Мохлик скрыт. Включите «Показывать Мохлика»." : null);
  const birdsUnavailable = motionUnavailable ?? (state.birds === "off" ? "Птицы выключены. Выберите «Авто» или «Включить»." : null);
  function unavailable(action: ManualAction) {
    if (action.kind === "birds") return birdsUnavailable;
    if (action.kind === "pose") return heroUnavailable;
    if (action.action === "idle") return null;
    if (action.action === "grow-mushrooms") return motionUnavailable;
    if (action.action === "grow-berries") return motionUnavailable ?? gardenDevActionUnavailable(action.action, observation?.diagnostics.garden, state);
    if (heroUnavailable) return heroUnavailable;
    const gardenReason = gardenDevActionUnavailable(action.action, observation?.diagnostics.garden, state);
    if (gardenReason) return gardenReason;
    if (action.action === "bush" && !TILED_WORLD.bushes?.length) return "Добавьте куст и точки входа в Tiled.";
    if (action.action === "home-sleep" && !state.showBuildings) return "Дом скрыт. Включите «Показывать здания».";
    if (action.action === "butterfly" && state.butterflies === "off") return "Бабочки выключены. Выберите «Авто» или «Включить».";
    if (action.action === "firefly" && state.fireflies === "off") return "Светлячки выключены. Выберите «Авто» или «Включить».";
    return null;
  }
  const repeatUnavailable = lastAction ? unavailable(lastAction) : null;
  const repeatLabel = lastAction?.kind === "pose" ? POSE_LABELS[lastAction.pose]
    : lastAction?.kind === "life" ? lifeActionLabel(lastAction.action) : "Сценарий с птицами";
  const appearance = state.equipment ?? world.snapshot?.state.equipment ?? { palette: "moss", head: null, neck: null };
  function change(patch: Partial<WorldDevState>, message = "Предпросмотр обновлён") {
    worldDevStore.patch(patch); setFeedback(message);
  }
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  function shortcut(callback: () => void) { callback(); }
  function outfit(slot: "palette" | "head" | "neck", value: string) {
    change({ equipment: { palette: appearance.palette, head: appearance.head, neck: appearance.neck, [slot]: value || null } }, "Примерка включена. Инвентарь сохранён");
  }
  function play(action: ManualAction) {
    if (unavailable(action)) return;
    if (action.kind === "birds") {
      worldDevStore.triggerBirds(); setFeedback("Птицы: пролёт, посадка на дерево и взлёт");
    } else if (action.kind === "life") {
      worldDevStore.triggerLife(action.action);
      setFeedback(action.action === "idle" ? "Сценка отменена. Автоматические сценки выключены."
        : action.action === "butterfly" || action.action === "firefly" ? "Запрошена встреча с доступной особью. Если подходящей рядом нет, сценка не начнётся."
        : action.action === "grow-berries" ? "Созревание ускорено в DEV. Память аккаунта отключена для этой проверки."
        : `Запрошено занятие: ${lifeActionLabel(action.action).toLowerCase()}`);
    } else {
      worldDevStore.triggerPose(action.pose); setFeedback(`Анимация: ${POSE_LABELS[action.pose].toLowerCase()}`);
    }
    setLastAction(action);
  }

  return <aside className={styles.root} aria-label="Инструменты разработчика">
    <div className={styles.toolbar}>
      {lastAction && <button type="button" className={styles.repeat} disabled={Boolean(repeatUnavailable)}
        aria-label={`Повторить: ${repeatLabel}`} title={repeatUnavailable ?? repeatLabel} onClick={() => play(lastAction)}><RotateCcw size={15} aria-hidden />Повторить</button>}
      <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} aria-controls={drawerId}
        aria-label={`Панель разработчика${overrides ? `, изменений: ${overrides}` : ""}`} onClick={() => setOpen(value => !value)}>
        <FlaskConical size={16} aria-hidden /><strong>DEV</strong>{overrides > 0 && <span className={styles.count}>{overrides}</span>}
      </button>
    </div>
    {!open && lastAction && <p className={styles.closedFeedback} role="status">{repeatUnavailable ?? feedback}</p>}
    {open && <section id={drawerId} className={styles.drawer} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div><h2 id={titleId}>Проверка леса</h2><p>Круг и карта · локальный режим</p></div>
        <button type="button" className={styles.headerButton} onClick={() => { worldDevStore.reset(); setLastAction(null); setFeedback("Все настройки вида сброшены"); }}
          title="Вернуть настройки вида. Память Мохлика и ресурсы сохранятся."><RotateCcw size={15} aria-hidden />Сброс вида</button>
        <button ref={closeButton} type="button" className={styles.headerButton} onClick={close} aria-label="Закрыть панель разработчика"><X size={16} aria-hidden />Закрыть</button>
      </header>
      <div className={styles.globalControls}>
        <button type="button" data-paused={state.paused} aria-label={state.paused ? "Продолжить сцену" : "Пауза сцены"} onClick={() => change({ paused: !state.paused }, state.paused ? "Сцена продолжена" : "Сцена на паузе")}>
          {state.paused ? "Продолжить" : "Пауза"}
        </button>
        <label className={styles.timeControl}><span>Свет</span><select aria-label="Свет" value={state.timeOfDay} onChange={event => change({ timeOfDay: event.target.value as WorldDevState["timeOfDay"] })}>
          {TIME.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
      <WorldDevTabs id={id} label="Разделы DEV" tabs={DEV_TABS} selected={tab} onSelect={setTab} />
      {DEV_TABS.map(([section]) => <div key={section} role="tabpanel" id={`${id}-panel-${section}`} aria-labelledby={`${id}-tab-${section}`}
        hidden={tab !== section} className={styles.workspace}>
        {tab === section && <>
          {tab === "mochlik" && <WorldDevTabs id={`${id}-mochlik`} label="Проверки Мохлика" tabs={MOCHLIK_TABS} selected={mochlikTab} onSelect={setMochlikTab} secondary />}
          {tab === "debug" && <WorldDevTabs id={`${id}-debug`} label="Инструменты отладки" tabs={DEBUG_TABS} selected={debugTab} onSelect={setDebugTab} secondary />}
          {(tab === "mochlik" ? MOCHLIK_TABS : tab === "debug" ? DEBUG_TABS : [[page, ""]] as const).map(([subpage]) => <div key={subpage}
            role={tab === "mochlik" || tab === "debug" ? "tabpanel" : "region"}
            id={tab === "mochlik" || tab === "debug" ? `${id}-${tab}-panel-${subpage}` : undefined}
            aria-labelledby={tab === "mochlik" || tab === "debug" ? `${id}-${tab}-tab-${subpage}` : `${id}-tab-${tab}`}
            hidden={page !== subpage} className={styles.body} tabIndex={page === subpage ? 0 : -1}
            ref={node => { if (node && page === subpage) node.scrollTop = scrollPositions.current[subpage] ?? 0; }}
            onScroll={event => { scrollPositions.current[subpage] = event.currentTarget.scrollTop; }}>
            {page === subpage && <WorldDevPanelContent world={world} worldView={worldView} presenceKey={presenceKey}
              onOpenWorld={onOpenWorld} onOpenCalendar={onOpenCalendar} onOpenGame={onOpenGame} onOpenStatus={onOpenStatus} onOpenWardrobe={onOpenWardrobe} onOpenCollection={onOpenCollection}
              state={state} observation={observation} page={page} id={id} selectedPose={selectedPose} onSelectPose={setSelectedPose}
              heroUnavailable={heroUnavailable} birdsUnavailable={birdsUnavailable} unavailable={unavailable}
              change={change} play={play} outfit={outfit} shortcut={shortcut} onFeedback={setFeedback} prefersReducedMotion={prefersReducedMotion} />}
          </div>)}
        </>}
      </div>)}
      <footer className={styles.footer}>
        <p role="status" aria-live="polite">{repeatUnavailable ?? (feedback || (overrides ? `Изменений вида: ${overrides}` : "Обычный вид леса"))}</p>
        {state.artError && <p className={styles.error} role="alert">Не удалось показать графику: {state.artError}</p>}
      </footer>
    </section>}
  </aside>;
}

/** Stateless controls: navigation never patches the world or launches a scene. */
export function WorldDevPanelContent({ world, worldView, presenceKey, onOpenWorld, onOpenCalendar, onOpenGame, onOpenStatus, onOpenWardrobe, onOpenCollection,
  state, observation, page, id, selectedPose, onSelectPose, heroUnavailable, birdsUnavailable, unavailable, change, play, outfit, shortcut, onFeedback, prefersReducedMotion,
}: WorldDevPanelProps & {
  state: WorldDevState; observation?: ForestObservation | null; page: DevPage; id: string; selectedPose: PixelPose; onSelectPose: (pose: PixelPose) => void;
  heroUnavailable: string | null; birdsUnavailable: string | null; unavailable: (action: ManualAction) => string | null;
  change: (patch: Partial<WorldDevState>, message?: string) => void; play: (action: ManualAction) => void;
  outfit: (slot: "palette" | "head" | "neck", value: string) => void; shortcut: (callback: () => void) => void;
  onFeedback: (message: string) => void; prefersReducedMotion: boolean;
}) {
  const locked = world.busy || world.uncertain;
  const canGrant = process.env.NODE_ENV === "development" && world.snapshot?.devTools === true;
  const appearance = state.equipment ?? world.snapshot?.state.equipment ?? { palette: "moss", head: null, neck: null };
  const previewScene = page === "routes" ? previewWorldScene(TILED_WORLD, state.levels) : null;
  const clearingRoutes = previewScene ? clearingRouteDiagnostics(previewScene) : [];
  const interactionDiagnostics = previewScene ? compileWorldInteractions(previewScene).diagnostics : [];
  const lifeReasons = page === "scenes"
    ? [...new Set(LIFE_ACTIONS.map(([action]) => unavailable({ kind: "life", action })).filter((reason): reason is string => Boolean(reason)))] : [];
  const gardenReasons = page === "activities"
    ? [...new Set(GARDEN_ACTIONS.map(([action]) => unavailable({ kind: "life", action })).filter((reason): reason is string => Boolean(reason)))] : [];
  return <div className={styles.pageContent}>
    {page === "scenes" && <>
      <h3 className={styles.pageTitle}>Лесные сценки</h3>
      <Toggle label="Автоматические сценки" checked={state.autoLife} onChange={autoLife => change({ autoLife })} />
      <p className={styles.hint}>Выключите, чтобы Мохлик ждал на месте между проверками.</p>
      {lifeReasons.map((reason, index) => <p key={reason} id={`${id}-life-reason-${index}`} className={styles.hint}>{reason}</p>)}
      <div className={styles.lifeActions}>
        {LIFE_ACTIONS.map(([action, label]) => {
          const reason = unavailable({ kind: "life", action });
          return <button key={action} type="button" disabled={Boolean(reason)} aria-describedby={reason ? `${id}-life-reason-${lifeReasons.indexOf(reason)}` : undefined}
            onClick={() => play({ kind: "life", action })}>{label}</button>;
        })}
      </div>
      <Section title="Как работают сценки">
      <p className={styles.hint}>Автоматические сценки включают прогулки по полянке и занятия на остановках. Выключение останавливает Мохлика на текущем месте; включение продолжает прогулку.</p>
      <p className={styles.hint}>«Отправиться спать домой» проверяет весь путь без ожидания трёх минут. Нажмите на дом или круг, чтобы разбудить. «Вырастить грибы» показывает быстрый рост из маленьких. «Съесть гриб» выбирает уже выросший гриб с доступным подходом. Наград и изменений инвентаря нет.</p>
      <p className={styles.hint}>Встречи с бабочкой и светлячком выбирают уже существующую свободную особь поблизости. Новое насекомое по кнопке не появляется. Учитываются погода, освещение и занятость участников; если подходящей особи нет, запрос не запускает сценку. «Отменить сценку» останавливает Мохлика и выключает автоматические сценки.</p>
      </Section>
    </>}
    {page === "activities" && <>
      <h3 className={styles.pageTitle}>Занятия на полянке</h3>
      <p className={styles.hint}>Полив → медленное созревание → сбор в корзинку. Мохлик сам выбирает подходящий момент; здесь можно проверить каждый шаг.</p>
      <div className={styles.lifeActions}>
        {GARDEN_ACTIONS.map(([action, label]) => {
          const reason = unavailable({ kind: "life", action });
          return <button key={action} type="button" disabled={Boolean(reason)} aria-describedby={reason ? `${id}-garden-reason-${gardenReasons.indexOf(reason)}` : undefined}
            onClick={() => { if (!reason) play({ kind: "life", action }); }}>{label}</button>;
        })}
      </div>
      {gardenReasons.map((reason, index) => <p key={reason} id={`${id}-garden-reason-${index}`} className={styles.hint}>{reason}</p>)}
      {observation && <div className={styles.aiIntention}><strong>{observation.activity}</strong><p>{observation.diagnostics.reason}</p></div>}
      <ForestGardenDiagnostics garden={observation?.diagnostics.garden} />
      <p className={styles.hint}>Ручной запуск и ускорение роста отключают запись памяти аккаунта для тестовой сцены. Просмотр показателей безопасен. «Отменить занятие» также выключает автоматические сценки.</p>
    </>}
    {page === "animation" && <>
      <h3 className={styles.pageTitle}>Анимации Мохлика</h3>
      <Select label="Повторять позу" value={state.pose} values={[["auto", "Обычное поведение"], ...WORLD_DEV_POSES.map(pose => [pose, POSE_LABELS[pose]] as const)]}
        onChange={pose => change({ pose, animation: null })} />
      <fieldset className={styles.fieldset}><legend>Поворот</legend><div className={styles.directions}>
        {DIRECTIONS.map(([direction, label]) => <button key={direction} type="button" aria-pressed={state.direction === direction} onClick={() => change({ direction })}>{label}</button>)}
      </div></fieldset>
      <div className={styles.oneShot}>
        <Select label="Анимация один раз" value={selectedPose} values={WORLD_DEV_POSES.map(pose => [pose, POSE_LABELS[pose]] as const)} onChange={onSelectPose} />
        <button type="button" disabled={Boolean(heroUnavailable)} aria-describedby={heroUnavailable ? `${id}-pose-reason` : undefined}
          onClick={() => play({ kind: "pose", pose: selectedPose })}>Проиграть: {POSE_LABELS[selectedPose]}</button>
      </div>
      {heroUnavailable && <p id={`${id}-pose-reason`} className={styles.hint}>{heroUnavailable}</p>}
      <p className={styles.hint}>Ручная поза проигрывается на текущем месте. Для прогулок выберите «Обычное поведение» и включите автоматические сценки. Линии проверяются в редакторе карты.</p>
    </>}
    {page === "appearance" && <>
      <h3 className={styles.pageTitle}>Внешность Мохлика</h3>
      <div className={styles.columns}>
        <Toggle label="Показывать Мохлика" checked={state.showHero} onChange={showHero => change({ showHero })} />
        <Toggle label="Тень под лапами" checked={state.heroShadow} onChange={heroShadow => change({ heroShadow })} />
      </div>
      <Field label={`Размер · ${Math.round(state.heroScale * 100)}%`}><input type="range" min="0.5" max="2" step="0.05" value={state.heroScale}
        onChange={event => change({ heroScale: Number(event.target.value) })} /></Field>
      <p className={styles.hint}>Это визуальный масштаб. Физический размер задаётся в Actor.size в Tiled.</p>
      <fieldset className={styles.fieldset}><legend>Примерка · без выдачи предметов</legend>
        {([['palette', 'Цвет мха'], ['head', 'Головной убор'], ['neck', 'Шарф']] as const).map(([slot, label]) =>
          <Field key={slot} label={label}><select value={appearance[slot] ?? ""} onChange={event => outfit(slot, event.target.value)}>
            {slot !== "palette" && <option value="">Без предмета</option>}
            {worldCatalog.items.filter(item => item.slot === slot).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select></Field>)}
        <button type="button" disabled={state.equipment === null} onClick={() => change({ equipment: null }, "Вернули одежду игрока")}>Одежда игрока</button>
        <p className={styles.hint}>Ивовая удочка показана в позах «Рыбачить» и «Идти с удочкой».</p>
      </fieldset>
    </>}
    {page === "world" && <>
      <h3 className={styles.pageTitle}>Погода и живность</h3>
      <Select label="Погода" value={state.weather} values={WEATHER} onChange={weather => change({ weather })} />
      <div className={styles.columns}>
        <Select label="Бабочки" value={state.butterflies} values={MODES} onChange={butterflies => change({ butterflies })} />
        <Select label="Светлячки" value={state.fireflies} values={MODES} onChange={fireflies => change({ fireflies })} />
      </div>
      <Select label="Птицы" value={state.birds} values={MODES} onChange={birds => change({ birds })} />
      <Toggle label="Лужи после дождя" checked={state.puddles} onChange={puddles => change({ puddles })} />
      <button type="button" disabled={Boolean(birdsUnavailable)} onClick={() => play({ kind: "birds" })}>Сценарий с птицами</button>
      {birdsUnavailable && <p className={styles.hint}>{birdsUnavailable}</p>}
      <p className={styles.hint}>Птицы садятся на деревья, осматриваются и снова взлетают. Полная сценка длится около полуминуты. Дождевые круги на реке видны на большой карте.</p>
      <Select label="Меньше движения" value={state.reducedMotion} values={MODES} onChange={reducedMotion => change({ reducedMotion })} />
      {prefersReducedMotion && state.reducedMotion === "off" && <p className={styles.hint}>Для предпросмотра включена анимация, хотя в системе выбрано меньше движения.</p>}
    </>}
    {page === "buildings" && <>
      <h3 className={styles.pageTitle}>Постройки</h3>
      <Toggle label="Показывать постройки" checked={state.showBuildings} onChange={showBuildings => change({ showBuildings })} />
      <Toggle label="Тени у основания" checked={state.buildingShadow} onChange={buildingShadow => change({ buildingShadow })} />
      {TILED_WORLD.sites.map(site => <Field key={site.id} label={site.label}>
        <select value={state.levels[site.id] ?? site.initialLevel} onChange={event => change({ levels: { ...state.levels, [site.id]: Number(event.target.value) } })}>
          {site.states.map(visual => <option key={visual.level} value={visual.level}>{visual.label} · уровень {visual.level}</option>)}
        </select>
      </Field>)}
      <p className={styles.hint}>Предпросмотр меняет рисунок, тени и точки подхода уровня. Уровни и покупки аккаунта сохраняются.</p>
    </>}
    {page === "ai" && <>
      <h3 className={styles.pageTitle}>Мышление и память</h3>
      <WorldAiDiagnostics presenceKey={presenceKey} />
    </>}
    {page === "overlays" && <>
      <h3 className={styles.pageTitle}>Разметка сцены</h3>
      <Toggle label="Границы и точки карты" checked={state.debug} onChange={debug => change({ debug })} />
      <Toggle label="Границы воды" checked={state.debugWater} onChange={debugWater => change({ debugWater })} />
      {state.debugWater && <p className={styles.hint}>Голубой контур — вода. Коралловый пунктир — исключения: листья, камни и другие предметы над водой.</p>}
      <Toggle label="Проходимость и цель Мохлика" checked={state.debugNavigation} onChange={debugNavigation => change({ debugNavigation })} />
      {state.debugNavigation && <p className={styles.hint}>Зелёный — разрешённая область и безопасные точки сетки, красный — препятствия, голубой — вода. Жёлтый — путь и цель; круг под лапами показывает радиус обхода.</p>}
      <Toggle label="Особи и их цели" checked={state.debugFauna} onChange={debugFauna => change({ debugFauna })} />
      {state.debugFauna && <p className={styles.hint}>Подписи показывают постоянный ID, состояние и цель особи. Фиолетовый пунктир — территория, красный — вычтенная из неё область. Подпись встречи указывает участника и фазу. Бабочки активны днём, светлячки — ночью.</p>}
    </>}
    {page === "routes" && <>
      <h3 className={styles.pageTitle}>Навигация и входы</h3>
      <Select label="Способ прогулки" value={state.navigationMode} values={[["auto", "Свободная полянка"], ["routes", "Прежние маршруты"]]}
        onChange={navigationMode => change({ navigationMode }, "Способ прогулки изменится после возвращения к домашней точке")} />
      <p className={styles.hint}>Переключение позволяет сравнить прогулки. Мохлик сначала безопасно возвращается к домашней точке.</p>
      <details><summary>Входы дома и кустов · {interactionDiagnostics.filter(item => item.valid).length} готовы</summary>
        <p className={styles.hint}>На свободной полянке путь строится от текущего места. Здесь проверяются точки входа; доступность всего пути зависит от положения Мохлика.</p>
        {interactionDiagnostics.map(item => <p key={item.id} className={item.valid ? styles.hint : styles.error}>
          <strong>{item.id}</strong>: {item.valid ? "Точки перехода готовы" : routeReasons[item.reason ?? ""] ?? "Проверьте точки перехода в Tiled."}
        </p>)}
      </details>
      <details><summary>Прежние маршруты · {clearingRoutes.filter(route => route.valid).length} доступны</summary>
        {clearingRoutes.length ? clearingRoutes.map(route => <p key={route.id} className={route.valid ? styles.hint : styles.error}>
          <strong>{route.id}</strong>: {route.valid ? "Готов к прогулке" : routeReasons[route.reason ?? ""] ?? "Проверьте разметку маршрута."}
        </p>) : <p className={styles.hint}>Авторских линий нет. Свободная полянка использует WalkAreas и точки входов.</p>}
      </details>
    </>}
    {page === "app" && <>
      <h3 className={styles.pageTitle}>Приложение и тесты</h3>
      {worldView && <fieldset className={styles.fieldset}><legend>Камера карты</legend><div className={styles.shortcuts}>
        {([["in", "Приблизить"], ["out", "Отдалить"], ["overview", "Вся карта"], ["pet", "Найти Мохлика"]] as const).map(([action, label]) =>
          <button type="button" key={action} onClick={() => { worldDevStore.triggerCamera(action); onFeedback(`Камера: ${label.toLowerCase()}`); }}>{label}</button>)}
      </div></fieldset>}
      <div className={styles.shortcuts}>
        {([["Большая карта", onOpenWorld], ["Календарь", onOpenCalendar], ["Игра и рейтинг", onOpenGame], ["Мой статус", onOpenStatus], ["Гардероб", onOpenWardrobe], ["Коллекции", onOpenCollection]] as const)
          .filter(([, callback]) => callback).map(([label, callback]) => <button key={label} type="button" onClick={() => { if (callback) shortcut(callback); }}>{label}</button>)}
        <a href="/prototype/tiled-world">Карта и маршруты ↗</a>
      </div>
      <Section title="Тестовые ресурсы">
      <p className={styles.scope}>Выдача меняет баланс аккаунта в локальном API. Сброс вида её не отменяет.</p>
      {world.snapshot && <dl className={styles.resources}>
        <div><dt>Искры</dt><dd>{world.snapshot.state.resources.sparks.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Дерево</dt><dd>{world.snapshot.state.resources.wood.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Камень</dt><dd>{world.snapshot.state.resources.stone.toLocaleString("ru-RU")}</dd></div>
      </dl>}
      <button type="button" disabled={!canGrant || locked} onClick={() => { if (!canGrant || locked) return; world.act("dev_grant_resources"); onFeedback("Запрос на выдачу отправлен"); }}>
        {world.busy ? "Отправляем…" : "+50 искр, дерева и камня"}
      </button>
      {!canGrant && <p className={styles.hint}>{world.snapshot ? "Тестовая выдача недоступна на этом сервере." : "Ожидаем загрузку мира…"}</p>}
      {world.uncertain && <><p className={styles.hint}>Ответ не получен. Проверьте результат тем же запросом перед новой выдачей.</p>
        <button type="button" disabled={world.busy} onClick={() => { void world.retry(); onFeedback("Проверяем результат запроса"); }}>Проверить результат</button></>}
      {world.error && <p className={styles.error} role="alert">{world.error}</p>}
      {world.notice && <p className={styles.hint} role="status">{world.notice}</p>}
      </Section>
      <Section title="О DEV и ограничениях">
        <p className={styles.scope}>Настройки DEV действуют в этой вкладке и сбрасываются при перезагрузке. Память Мохлика хранится отдельно; сброс вида её не удаляет.</p>
        <p className={styles.pending}>Фонари и игровые улучшения новой карты появятся после адаптации.</p>
      </Section>
    </>}
  </div>;
}

export default WorldDevPanel;
