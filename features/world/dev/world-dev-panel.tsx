"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, FlaskConical, RotateCcw, X } from "lucide-react";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { PleskAction } from "../plesk-resident";
import type { BuilderAction } from "../builder-types";
import type { EconomyController } from "@/features/economy/use-economy";
import { worldCatalog } from "../model";
import { TILED_WORLD } from "../presentation";
import { clearingRouteDiagnostics } from "../clearing-activity";
import { compileWorldInteractions, WORLD_INTERACTION_LIMITS } from "../interaction-navigation";
import { previewWorldScene } from "../tiled/preview-state";
import { interactiveMapObjects, type MapObjectPlace } from "../site-interactions";
import type { WorldController } from "../use-world";
import { WorldAiDiagnostics } from "./world-ai-diagnostics";
import { ForestGardenDiagnostics } from "./forest-ai-diagnostics";
import { WorldDevCheats } from "./world-dev-cheats";
import { WorldDevFishing } from "./world-dev-fishing";
import { WorldDevBuilderPoints } from "./world-dev-builder-points";
import { useForestObservation } from "../use-forest-observation";
import type { ForestGardenObservation, ForestObservation } from "../forest-observer";
import { WORLD_DEV_DEFAULTS, WORLD_DEV_ENABLED, WORLD_DEV_POSES, WORLD_DEV_RESIDENT_ACTIONS, WORLD_DEV_BUILDER_ACTIONS, WORLD_DEV_COOKING_ACTIONS, WORLD_DEV_SCENARIOS, worldDevStore, type WorldDevLifeAction, type WorldDevState, type WorldDevScenario, type WorldDevCookingPreview } from "./world-dev-store";
import styles from "./world-dev-panel.module.css";

export type WorldDevPanelProps = {
  world: WorldController;
  economy?: EconomyController;
  active?: boolean;
  initiallyOpen?: boolean;
  worldView?: boolean;
  presenceKey?: string;
  onOpenWorld?: () => void;
  onOpenCalendar?: () => void;
  onOpenGame?: () => void;
  onOpenStatus?: () => void;
  onOpenWardrobe?: () => void;
  onOpenCollection?: () => void;
  onOpenObject?: (place: MapObjectPlace) => void;
};
type ManualAction = { kind: "scenario"; scenario: WorldDevScenario } | { kind: "pose"; pose: PixelPose }
  | { kind: "builder"; action: BuilderAction; repeat?: boolean }
  | { kind: "cooking"; action: WorldDevCookingPreview["action"]; repeat?: boolean }
  | { kind: "resident"; action: "routine" | PleskAction; repeat?: boolean } | { kind: "birds" } | { kind: "life"; action: WorldDevLifeAction };

const POSE_LABELS: Record<PixelPose, string> = {
  idle: "Покой", walk: "Шаги", blink: "Моргнуть", sleep: "Сон", drowsy: "Дремота",
  stretch: "Потянуться", crouch: "Присесть", jump: "Прыжок", groom: "Умыться", greet: "Приветствие",
  sniff: "Принюхаться", reach: "Потянуть лапы", hold: "Держать", chew: "Жевать", swallow: "Проглотить",
  scratch: "Почесаться", yawn: "Зевнуть", shake: "Отряхнуться", sneeze: "Чихнуть", wonder: "Удивиться",
  carry: "Нести", toss: "Подбросить", present: "Показать находку", fish: "Рыбачить", "fishing-walk": "Идти с удочкой",
};
const RESIDENT_LABELS: Record<PleskAction | "routine", string> = {
  routine: "Демонстрация занятий", idle: "Осмотреться", walk: "Шаги", cast: "Забросить удочку", fish: "Ждать поклёвку",
  bite: "Поклёвка", reel: "Вытянуть рыбу", catch: "Показать улов", pack: "Уложить рыбу", trade: "Предложить улов",
  rest: "Отдохнуть", greet: "Помахать лапой",
};
const COOKING_LABELS: Record<WorldDevCookingPreview["action"], string> = {
  sequence: "Приготовить обед", prepare: "Подготовить продукты", stir: "Помешать в котелке", taste: "Попробовать суп", serve: "Подать обед",
};
const BUILDER_LABELS: Record<BuilderAction, string> = {
  idle: "Осмотреться", walk: "Бежать", work: "Работать молотком", inspect: "Проверить инструменты",
  finish: "Закончить работу", greet: "Поздороваться",
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
  "campfire-collision": "Путь проходит через очаг — передвиньте костёр или маршрут.",
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
  ["campfire", "Погреться у костра"], ["bush", "Спрятаться в кусте"], ["watch-birds", "Понаблюдать за птицей"],
  ["home-sleep", "Отправиться спать домой"], ["wake", "Разбудить Мохлика"], ["grow-mushrooms", "Вырастить грибы"], ["idle", "Отменить сценку"],
] as const satisfies readonly (readonly [WorldDevLifeAction, string])[];
const GARDEN_ACTIONS = [["water-bush", "Полить куст"], ["harvest-berries", "Собрать ягоды"],
  ["grow-berries", "Созреть ягодам · DEV"], ["idle", "Отменить занятие"]] as const satisfies readonly (readonly [WorldDevLifeAction, string])[];
const lifeActionLabel = (action: WorldDevLifeAction) => [...LIFE_ACTIONS, ...GARDEN_ACTIONS].find(([kind]) => kind === action)?.[1] ?? action;

/** Only known current constraints are disabled here; pathfinding remains the director's responsibility. */
export function gardenDevActionUnavailable(action: WorldDevLifeAction, garden: ForestGardenObservation | undefined, state: WorldDevState) {
  if (!["water-bush", "harvest-berries", "grow-berries"].includes(action)) return null;
  if (!garden) return "Дождитесь загрузки ягодного куста и корзинки.";
  if (garden.managed && action === "grow-berries") return "Рост задан таймером хозяйства. Для проверки: Читы → Таймеры заданий → Только производство → Убрать ожидание, затем «Собрать» в меню куста.";
  if (garden.managed && action === "harvest-berries") return "Запустите сбор кнопкой «Собрать» в меню куста. Этот DEV-показ не завершает задание хозяйства.";
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

const DEV_TABS = [["cheats", "Читы"], ["mochlik", "Герои"], ["scene", "Сцена"], ["debug", "Отладка"]] as const;
const MOCHLIK_TABS = [["scenes", "Мохлик"], ["animation", "Анимации"], ["appearance", "Внешность"], ["plesk", "Плёска"], ["builder", "Шишколап"]] as const;
const SCENE_TABS = [["scenarios", "Сценарии"], ["world", "Погода"], ["activities", "Сад"], ["buildings", "Здания"]] as const;
const DEBUG_TABS = [["ai", "Мышление"], ["overlays", "Разметка"], ["routes", "Пути"], ["fishing", "Рыбалка"], ["app", "Приложение"]] as const;
type DevTab = typeof DEV_TABS[number][0];
type MochlikTab = typeof MOCHLIK_TABS[number][0];
type SceneTab = typeof SCENE_TABS[number][0];
type DebugTab = typeof DEBUG_TABS[number][0];
type DevPage = "cheats" | MochlikTab | SceneTab | DebugTab;

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
  return <div className={secondary ? styles.subtabs : styles.tabs} role="tablist" aria-label={label} data-tabs-count={tabs.length}>
    {tabs.map(([tab, title], index) => <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`}
      aria-selected={selected === tab} aria-controls={`${id}-panel-${tab}`} tabIndex={selected === tab ? 0 : -1}
      onClick={() => onSelect(tab)} onKeyDown={event => navigate(event, index)}>{title}</button>)}
  </div>;
}

/** Absent from production. Visual previews and account-changing cheats stay in separate tabs. */
export function WorldDevPanel(props: WorldDevPanelProps) {
  return WORLD_DEV_ENABLED ? <DevelopmentPanel {...props} /> : null;
}

function DevelopmentPanel({ world, economy, active = true, initiallyOpen = false, worldView = false, presenceKey, onOpenWorld, onOpenCalendar, onOpenGame, onOpenStatus, onOpenWardrobe, onOpenCollection, onOpenObject }: WorldDevPanelProps) {
  const state = useSyncExternalStore(worldDevStore.subscribe, worldDevStore.getSnapshot, worldDevStore.getServerSnapshot);
  const prefersReducedMotion = useSyncExternalStore(subscribeMotion, systemMotion, serverMotion);
  const [open, setOpen] = useState(initiallyOpen);
  const [tab, setTab] = useState<DevTab>("cheats");
  const [mochlikTab, setMochlikTab] = useState<MochlikTab>("scenes");
  const [sceneTab, setSceneTab] = useState<SceneTab>("scenarios");
  const [debugTab, setDebugTab] = useState<DebugTab>("overlays");
  const [selectedPose, setSelectedPose] = useState<PixelPose>("greet");
  const scrollPositions = useRef<Partial<Record<DevPage, number>>>({});
  const page: DevPage = tab === "mochlik" ? mochlikTab : tab === "debug" ? debugTab : tab === "scene" ? sceneTab : tab;
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
    .filter(key => !["scenarioEvent", "animation", "lifeEvent", "birdEvent", "cameraEvent", "artError"].includes(key)
      && JSON.stringify(state[key]) !== JSON.stringify(WORLD_DEV_DEFAULTS[key])).length;
  const reduced = state.reducedMotion === "on" || state.reducedMotion === "auto" && prefersReducedMotion;
  const motionUnavailable = state.paused ? "Сцена на паузе. Снимите паузу для проигрывания событий."
    : reduced ? "Для анимаций: Мир → Меньше движения → Выключить." : null;
  const heroUnavailable = motionUnavailable ?? (!state.showHero ? "Мохлик скрыт. Включите «Показывать Мохлика»." : null);
  const birdsUnavailable = motionUnavailable ?? (state.birds === "off" ? "Птицы выключены. Выберите «Авто» или «Включить»." : null);
  function unavailable(action: ManualAction) {
    if (action.kind === "scenario") return null;
    if (action.kind === "resident" || action.kind === "builder") return motionUnavailable;
    if (action.kind === "birds") return birdsUnavailable;
    if (action.kind === "cooking") return heroUnavailable ?? (economy?.snapshot?.jobs.some(job =>
      job.kind === "exploration" && economy.now < Date.parse(job.finishesAt) || job.collection?.startedAt)
      ? "Мохлик занят поручением. Дождитесь его возвращения и доставки припасов." : null);
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
    if (action.action === "watch-birds") return birdsUnavailable ?? (state.timeOfDay === "night" ? "Дождитесь дня и посадки птицы рядом." : null);
    if (action.action === "firefly" && state.fireflies === "off") return "Светлячки выключены. Выберите «Авто» или «Включить».";
    return null;
  }
  const repeatUnavailable = lastAction ? unavailable(lastAction) : null;
  const repeatLabel = lastAction?.kind === "scenario" ? WORLD_DEV_SCENARIOS.find(item => item.id === lastAction.scenario)!.label : lastAction?.kind === "pose" ? POSE_LABELS[lastAction.pose]
    : lastAction?.kind === "cooking" ? COOKING_LABELS[lastAction.action]
    : lastAction?.kind === "resident" ? `Плёска: ${RESIDENT_LABELS[lastAction.action]}`
    : lastAction?.kind === "builder" ? `Шишколап: ${BUILDER_LABELS[lastAction.action]}`
    : lastAction?.kind === "life" ? lifeActionLabel(lastAction.action) : "Сценарий с птицами";
  const appearance = state.equipment ?? world.snapshot?.state.equipment ?? { palette: "moss", head: null, neck: null };
  function change(patch: Partial<WorldDevState>, message = "Предпросмотр обновлён") {
    worldDevStore.patch(patch); setFeedback(message);
  }
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  function shortcut(callback: () => void) { setOpen(false); callback(); }
  function outfit(slot: "palette" | "head" | "neck", value: string) {
    change({ equipment: { palette: appearance.palette, head: appearance.head, neck: appearance.neck, [slot]: value || null } }, "Примерка включена. Инвентарь сохранён");
  }
  function play(action: ManualAction) {
    if (unavailable(action)) return;
    if (action.kind === "scenario") {
      worldDevStore.triggerScenario(action.scenario);
      setFeedback(`${WORLD_DEV_SCENARIOS.find(item => item.id === action.scenario)!.label}: условия применены. Память аккаунта отключена для тестовой сессии.`);
    } else if (action.kind === "resident") {
      worldDevStore.triggerResident(action.action, action.repeat ?? false);
      setFeedback(`Плёска: ${RESIDENT_LABELS[action.action].toLowerCase()}${action.repeat ? " · повтор" : ""}. Камера направлена к пирсу; панель остаётся открытой.`);
    } else if (action.kind === "builder") {
      worldDevStore.triggerBuilder(action.action, action.repeat ?? false);
      setFeedback(`Шишколап: ${BUILDER_LABELS[action.action].toLowerCase()}${action.repeat ? " · повтор" : ""}. Поза для проверки; поручение продолжается.`);
    } else if (action.kind === "cooking") {
      worldDevStore.triggerCooking(action.action, action.repeat ?? false);
      setFeedback(`${COOKING_LABELS[action.action]}${action.repeat ? " · повтор" : ""}. Проверка начнётся на свободном месте; продукты аккаунта не расходуются.`);
    } else if (action.kind === "birds") {
      worldDevStore.triggerBirds(); setFeedback("Птицы: новый визит на деревья или землю и последующий взлёт");
    } else if (action.kind === "life") {
      worldDevStore.triggerLife(action.action);
      setFeedback(action.action === "idle" ? "Сценка отменена. Автоматические сценки выключены."
        : action.action === "butterfly" || action.action === "firefly" ? "Запрошена встреча с доступной особью. Если подходящей рядом нет, сценка не начнётся."
        : action.action === "watch-birds" ? "Наблюдает только за сидящей рядом птицей. Можно запустить сценарий с птицами и дождаться посадки."
        : action.action === "grow-berries" ? "Созревание ускорено в DEV. Память аккаунта отключена для этой проверки."
        : `Запрошено занятие: ${lifeActionLabel(action.action).toLowerCase()}`);
    } else {
      worldDevStore.triggerPose(action.pose); setFeedback(`Анимация: ${POSE_LABELS[action.pose].toLowerCase()}`);
    }
    setLastAction(action);
  }

  return <aside className={styles.root} data-world-view={worldView || undefined} aria-label="Инструменты разработчика">
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
        <div><h2 id={titleId}>Мастерская DEV</h2><p>{tab === "cheats" ? "Тестовый профиль · изменения сохраняются" : tab === "debug" ? "Диагностика мира и приложения" : "Предпросмотр · без выдачи наград"}</p></div>
        <button type="button" className={styles.headerButton} onClick={() => { worldDevStore.reset(); setLastAction(null); setFeedback("Все настройки вида сброшены"); }}
          title="Вернуть настройки вида. Память Мохлика и ресурсы сохранятся."><RotateCcw size={15} aria-hidden />Сброс вида</button>
        <button ref={closeButton} type="button" className={styles.headerButton} onClick={close} aria-label="Закрыть панель разработчика"><X size={16} aria-hidden />Закрыть</button>
      </header>
      {tab !== "cheats" && <div className={styles.globalControls}>
        <button type="button" data-paused={state.paused} aria-label={state.paused ? "Продолжить сцену" : "Пауза сцены"} onClick={() => change({ paused: !state.paused }, state.paused ? "Сцена продолжена" : "Сцена на паузе")}>
          {state.paused ? "Продолжить" : "Пауза"}
        </button>
        <label className={styles.timeControl}><span>Свет</span><select aria-label="Свет" value={state.timeOfDay} onChange={event => change({ timeOfDay: event.target.value as WorldDevState["timeOfDay"] })}>
          {TIME.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>}
      <WorldDevTabs id={id} label="Разделы DEV" tabs={DEV_TABS} selected={tab} onSelect={setTab} />
      {DEV_TABS.map(([section]) => <div key={section} role="tabpanel" id={`${id}-panel-${section}`} aria-labelledby={`${id}-tab-${section}`}
        hidden={tab !== section} className={styles.workspace}>
        {tab === section && <>
          {tab === "mochlik" && <WorldDevTabs id={`${id}-mochlik`} label="Персонажи и движения" tabs={MOCHLIK_TABS} selected={mochlikTab} onSelect={setMochlikTab} secondary />}
          {tab === "scene" && <WorldDevTabs id={`${id}-scene`} label="Сцена и окружение" tabs={SCENE_TABS} selected={sceneTab} onSelect={setSceneTab} secondary />}
          {tab === "debug" && <WorldDevTabs id={`${id}-debug`} label="Инструменты отладки" tabs={DEBUG_TABS} selected={debugTab} onSelect={setDebugTab} secondary />}
          {(tab === "mochlik" ? MOCHLIK_TABS : tab === "debug" ? DEBUG_TABS : tab === "scene" ? SCENE_TABS : [[page, ""]] as const).map(([subpage]) => <div key={subpage}
            role={tab !== "cheats" ? "tabpanel" : "region"}
            id={tab !== "cheats" ? `${id}-${tab}-panel-${subpage}` : undefined}
            aria-labelledby={tab !== "cheats" ? `${id}-${tab}-tab-${subpage}` : `${id}-tab-${tab}`}
            hidden={page !== subpage} className={styles.body} tabIndex={page === subpage ? 0 : -1}
            ref={node => { if (node && page === subpage) node.scrollTop = scrollPositions.current[subpage] ?? 0; }}
            onScroll={event => { scrollPositions.current[subpage] = event.currentTarget.scrollTop; }}>
            {page === subpage && <WorldDevPanelContent world={world} economy={economy} worldView={worldView} presenceKey={presenceKey}
              onOpenWorld={onOpenWorld} onOpenCalendar={onOpenCalendar} onOpenGame={onOpenGame} onOpenStatus={onOpenStatus} onOpenWardrobe={onOpenWardrobe} onOpenCollection={onOpenCollection}
              onOpenObject={onOpenObject}
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
export function WorldDevPanelContent({ world, economy, worldView, presenceKey, onOpenWorld, onOpenCalendar, onOpenGame, onOpenStatus, onOpenWardrobe, onOpenCollection, onOpenObject,
  state, observation, page, id, selectedPose, onSelectPose, heroUnavailable, birdsUnavailable, unavailable, change, play, outfit, shortcut, onFeedback, prefersReducedMotion,
}: WorldDevPanelProps & {
  state: WorldDevState; observation?: ForestObservation | null; page: DevPage; id: string; selectedPose: PixelPose; onSelectPose: (pose: PixelPose) => void;
  heroUnavailable: string | null; birdsUnavailable: string | null; unavailable: (action: ManualAction) => string | null;
  change: (patch: Partial<WorldDevState>, message?: string) => void; play: (action: ManualAction) => void;
  outfit: (slot: "palette" | "head" | "neck", value: string) => void; shortcut: (callback: () => void) => void;
  onFeedback: (message: string) => void; prefersReducedMotion: boolean;
}) {
  const appearance = state.equipment ?? world.snapshot?.state.equipment ?? { palette: "moss", head: null, neck: null };
  const previewScene = page === "routes" ? previewWorldScene(TILED_WORLD, state.levels) : null;
  const clearingRoutes = previewScene ? clearingRouteDiagnostics(previewScene) : [];
  const interactionDiagnostics = previewScene ? compileWorldInteractions(previewScene).diagnostics : [];
  const lifeReasons = page === "scenes"
    ? [...new Set(LIFE_ACTIONS.map(([action]) => unavailable({ kind: "life", action })).filter((reason): reason is string => Boolean(reason)))] : [];
  const gardenReasons = page === "activities"
    ? [...new Set(GARDEN_ACTIONS.map(([action]) => unavailable({ kind: "life", action })).filter((reason): reason is string => Boolean(reason)))] : [];
  const cookingReason = page === "animation" ? unavailable({ kind: "cooking", action: "sequence" }) : null;
  return <div className={styles.pageContent}>
    {page === "fishing" && <>
      <h3 className={styles.pageTitle}>Расчёт улова</h3>
      <WorldDevFishing state={economy?.snapshot} />
    </>}
    {page === "cheats" && <>
      <h3 className={styles.pageTitle}>Читы хозяйства</h3>
      <WorldDevCheats world={world} economy={economy} previewBuildings={state.previewBuildings}
        onShowAccountBuildings={() => change({ previewBuildings: false }, "Карта показывает настоящие уровни хозяйства")} />
    </>}
    {page === "scenarios" && <>
      <h3 className={styles.pageTitle}>Готовые сценарии</h3>
      <p className={styles.hint}>Один запуск задаёт погоду, время и нужное занятие, снимает паузу. Положение Мохлика, выбранный дом и масштаб сохраняются.</p>
      <div className={styles.scenarioList}>{WORLD_DEV_SCENARIOS.map(scenario => <button key={scenario.id} type="button"
        data-last-run={state.scenarioEvent?.kind === scenario.id || undefined} onClick={() => play({ kind: "scenario", scenario: scenario.id })}>
        <strong>{scenario.label}</strong><span>{scenario.description}</span>
      </button>)}</div>
      <button type="button" onClick={() => play({ kind: "life", action: "idle" })}>Остановить тестовую рыбалку Мохлика</button>
      <p className={styles.hint}>Уменьшенное движение сохраняется: для анимаций проверьте эту настройку в разделе «Мир». Сценарии отключают сохранение тестовой сессии; после проверки перезагрузите страницу для обычной игры.</p>
    </>}
    {page === "plesk" && <>
      <h3 className={styles.pageTitle}>Плёска · рыбачка и торговка</h3>
      <p className={styles.hint}>Программная жительница верхнего пирса. Проверки меняют только её показ; Мохлик продолжает свои занятия.</p>
      {observation?.resident && <section className={styles.aiIntention} aria-label="Внутреннее состояние Плёски">
        <strong>{RESIDENT_LABELS[observation.resident.action as PleskAction] ?? "Выбирает занятие"}</strong>
        <p>{observation.resident.reason}</p>
        <div className={styles.aiNeeds}>{([["energy", "Энергия"], ["patience", "Терпение"], ["social", "Желание общаться"]] as const).map(([key, label]) =>
          <label className={styles.aiNeed} key={key}><span>{label} · {Math.round(observation.resident!.needs[key] * 100)}%</span>
            <meter aria-label={`Плёска: ${label}`} min={0} max={1} value={observation.resident!.needs[key]} /></label>)}</div>
        <p>Свой улов: {observation.resident.catchCount} · Выборов занятия: {observation.resident.decisions}</p>
        {state.residentPreview && <p>Включён показ анимаций. «Свободное поведение» вернёт на экран её текущее занятие.</p>}
      </section>}
      <div className={styles.shortcuts}>
        <button type="button" onClick={() => { change({ residentPreview: null }, "Плёска сама выбирает занятие по своему состоянию"); worldDevStore.triggerCamera("plesk"); }}>Свободное поведение</button>
        <button type="button" onClick={() => play({ kind: "scenario", scenario: "plesk" })}>Показать все занятия</button>
        <button type="button" onClick={() => { worldDevStore.triggerCamera("plesk"); onFeedback("Камера направлена к Плёске"); }}>Найти Плёску</button>
      </div>
      {!worldView && <p className={styles.hint}>Пирс находится за пределами домашнего круга. Откройте большую карту, чтобы увидеть проверку.</p>}
      <fieldset className={styles.fieldset}><legend>Поворот Плёски</legend><div className={styles.directions}>
        {DIRECTIONS.map(([direction, label]) => <button key={direction} type="button" aria-pressed={state.residentDirection === direction}
          onClick={() => change({ residentDirection: direction })}>{label}</button>)}
      </div></fieldset>
      <Select label="Повторять действие Плёски" value={state.residentPreview?.repeat ? state.residentPreview.action : "auto"}
        values={[["auto", "Свободное поведение"], ["routine", RESIDENT_LABELS.routine], ...WORLD_DEV_RESIDENT_ACTIONS.map(action => [action, RESIDENT_LABELS[action]] as const)]}
        onChange={action => { if (action === "auto") change({ residentPreview: null }, "Плёска вернулась к своему распорядку");
          else if (!unavailable({ kind: "resident", action })) play({ kind: "resident", action, repeat: true }); }} />
      {unavailable({ kind: "resident", action: "idle" }) && <p id={`${id}-resident-reason`} className={styles.hint}>{unavailable({ kind: "resident", action: "idle" })}</p>}
      <div className={styles.lifeActions}>
        {WORLD_DEV_RESIDENT_ACTIONS.map(action => {
          const reason = unavailable({ kind: "resident", action });
          return <button key={action} type="button" data-resident-action={action} disabled={Boolean(reason)} aria-describedby={reason ? `${id}-resident-reason` : undefined}
            onClick={() => { if (!reason) play({ kind: "resident", action }); }}>{RESIDENT_LABELS[action]}</button>;
        })}
      </div>
      <div className={styles.shortcuts}>
        <button type="button" onClick={() => change({ residentPreview: null }, "Проверка Плёски отменена; обычный распорядок продолжен")}>Отменить проверку</button>
        <button type="button" onClick={() => change({ residentPreview: null, residentDirection: "front" }, "Показ Плёски сброшен")}>Сброс Плёски</button>
      </div>
      <p className={styles.hint}>Кнопка проигрывает действие один раз; «Повторить» сверху запускает его заново. Поворот относится к отдельным действиям — в распорядке Плёска сама смотрит по ходу движения и на воду. Улов здесь не пополняет кладовую и не изменяет задания.</p>
    </>}
    {page === "builder" && <>
      <h3 className={styles.pageTitle}>Шишколап · строитель</h3>
      <p className={styles.hint}>Проверка поз и молотка. Путь и поручение продолжаются; «Пауза» остановит движение для осмотра.</p>
      <div className={styles.shortcuts}>
        <button type="button" onClick={() => { change({ builderPreview: null }, "Шишколап показывает своё текущее занятие"); worldDevStore.triggerCamera("builder"); }}>Свободное поведение</button>
        <button type="button" onClick={() => { worldDevStore.triggerCamera("builder"); onFeedback("Камера направлена к Шишколапу"); }}>Найти Шишколапа</button>
      </div>
      {!worldView && <p className={styles.hint}>На большой карте виден весь путь строителя.</p>}
      <fieldset className={styles.fieldset}><legend>Поворот Шишколапа</legend><div className={styles.directions}>
        {DIRECTIONS.map(([direction, label]) => <button key={direction} type="button" aria-pressed={state.builderDirection === direction}
          onClick={() => change({ builderDirection: direction })}>{label}</button>)}
      </div></fieldset>
      <Select label="Повторять действие Шишколапа" value={state.builderPreview?.repeat ? state.builderPreview.action : "auto"}
        values={[["auto", "Свободное поведение"], ...WORLD_DEV_BUILDER_ACTIONS.map(action => [action, BUILDER_LABELS[action]] as const)]}
        onChange={action => { if (action === "auto") change({ builderPreview: null }, "Шишколап показывает своё текущее занятие");
          else if (!unavailable({ kind: "builder", action })) play({ kind: "builder", action, repeat: true }); }} />
      {unavailable({ kind: "builder", action: "idle" }) && <p id={`${id}-builder-reason`} className={styles.hint}>{unavailable({ kind: "builder", action: "idle" })}</p>}
      <div className={styles.lifeActions}>{WORLD_DEV_BUILDER_ACTIONS.map(action => {
        const reason = unavailable({ kind: "builder", action });
        return <button key={action} type="button" data-builder-action={action} disabled={Boolean(reason)} aria-describedby={reason ? `${id}-builder-reason` : undefined}
          onClick={() => { if (!reason) play({ kind: "builder", action }); }}>{BUILDER_LABELS[action]}</button>;
      })}</div>
      <div className={styles.shortcuts}>
        <button type="button" onClick={() => change({ builderPreview: null }, "Проверка Шишколапа отменена")}>Отменить проверку</button>
        <button type="button" onClick={() => change({ builderPreview: null, builderDirection: "front" }, "Показ Шишколапа сброшен")}>Сброс Шишколапа</button>
      </div>
      <p className={styles.hint}>Кнопки проигрывают действие один раз. Завершение работы здесь — только жест: стройка и ресурсы не меняются.</p>
      <WorldDevBuilderPoints source={TILED_WORLD} preview={state} houseLevel={world.snapshot?.state.houseLevel}
        economy={economy?.snapshot} now={economy?.now ?? world.now} />
    </>}
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
      <Section title="Приготовление еды" initiallyOpen>
        <p className={styles.hint}>Подготовка продуктов, котелок, проба и подача. Пока это проверка анимаций: еда не расходуется и не выдаётся.</p>
        <div className={styles.lifeActions}>{WORLD_DEV_COOKING_ACTIONS.map(action => <button key={action} type="button"
          data-cooking-action={action} disabled={Boolean(cookingReason)} aria-describedby={cookingReason ? `${id}-cooking-reason` : undefined}
          onClick={() => { if (!cookingReason) play({ kind: "cooking", action }); }}>{COOKING_LABELS[action]}</button>)}</div>
        {cookingReason && <p id={`${id}-cooking-reason`} className={styles.hint}>{cookingReason}</p>}
        <Select label="Повторять приготовление" value={state.cookingPreview?.repeat ? state.cookingPreview.action : "off"}
          values={[["off", "Не повторять"], ...WORLD_DEV_COOKING_ACTIONS.map(action => [action, COOKING_LABELS[action]] as const)]}
          onChange={action => { if (action === "off") change({ cookingPreview: null }, "Проверка готовки отменена");
            else if (!cookingReason) play({ kind: "cooking", action, repeat: true }); }} />
        <button type="button" onClick={() => change({ cookingPreview: null }, "Проверка готовки отменена")}>Отменить приготовление</button>
      </Section>
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
      <Select label="Рыбы в воде" value={state.waterFish} values={[["auto", "Естественное поведение"], ["on", "Показать плавание и всплески"], ["off", "Выключить"]]}
        onChange={waterFish => change({ waterFish })} />
      <Toggle label="Бриз на воде" checked={state.waterBreeze} onChange={waterBreeze => change({ waterBreeze })} />
      <Toggle label="Течение и блики" checked={state.waterSurface} onChange={waterSurface => change({ waterSurface })} />
      <Select label="Ветер над водой" value={state.waterWind}
        values={[["auto", "По погоде"], ["calm", "Штиль"], ["breeze", "Лёгкий ветер"], ["windy", "Сильный ветер"]]}
        onChange={waterWind => change({ waterWind })} />
      <p className={styles.hint}>Сравните воду днём и ночью, в штиль и под дождём. Пауза и «Меньше движения» останавливают движение поверхности. Границы и исключения воды видны в «Разметке».</p>
      <Toggle label="Лужи после дождя" checked={state.puddles} onChange={puddles => change({ puddles })} />
      <button type="button" disabled={Boolean(birdsUnavailable)} onClick={() => play({ kind: "birds" })}>Сценарий с птицами</button>
      {birdsUnavailable && <p className={styles.hint}>{birdsUnavailable}</p>}
      <p className={styles.hint}>Птицы отдыхают на деревьях или ищут корм на земле. Для наземной сценки выберите «Птицы на земле» в сценариях. Полный визит длится около полуминуты.</p>
      <Select label="Меньше движения" value={state.reducedMotion} values={MODES} onChange={reducedMotion => change({ reducedMotion })} />
      {prefersReducedMotion && state.reducedMotion === "off" && <p className={styles.hint}>Для предпросмотра включена анимация, хотя в системе выбрано меньше движения.</p>}
    </>}
    {page === "buildings" && <>
      <h3 className={styles.pageTitle}>Постройки</h3>
      <Toggle label="Показывать постройки" checked={state.showBuildings} onChange={showBuildings => change({ showBuildings })} />
      <Toggle label="Тени у основания" checked={state.buildingShadow} onChange={buildingShadow => change({ buildingShadow })} />
      <Toggle label="Предпросмотр уровней" checked={state.previewBuildings} onChange={previewBuildings => change({ previewBuildings })} />
      {TILED_WORLD.sites.map(site => <Field key={site.id} label={site.label}>
        <select value={state.previewBuildings ? state.levels[site.id] ?? site.initialLevel : "account"} onChange={event => change(event.target.value === "account"
          ? { previewBuildings: false } : { previewBuildings: true, levels: { ...state.levels, [site.id]: Number(event.target.value) } })}>
          <option value="account">Уровень аккаунта</option>
          {site.states.map(visual => <option key={visual.level} value={visual.level}>{visual.label} · уровень {visual.level}</option>)}
        </select>
      </Field>)}
      <p className={styles.hint}>Предпросмотр меняет рисунок, тени и точки подхода уровня. Рецепты, ресурсы и стройка используют настоящий прогресс аккаунта; примерка уровня их не открывает.</p>
      {onOpenObject && <>
        <p className={styles.hint}><strong>Меню объектов</strong> · открыть тот же объект, что нажатием на карте.</p>
        <div className={styles.lifeActions}>
          {interactiveMapObjects(TILED_WORLD, { showBuildings: state.showBuildings }).map(object => <button key={object.id} type="button"
            data-dev-object={object.place} onClick={() => shortcut(() => onOpenObject(object.place))}>{object.label}</button>)}
        </div>
      </>}
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
      {state.debugNavigation && <p className={styles.hint}>Зелёный — разрешённая область и безопасные точки сетки, красный — препятствия, голубой — вода. Жёлтый — путь, цель и места назначения; круг под лапами показывает радиус обхода. Фиолетовый пунктир — перекрытие изображения; когда лапы достигают линии frontY или опускаются ниже, персонаж рисуется перед объектом.</p>}
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
        {([["in", "Приблизить"], ["out", "Отдалить"], ["overview", "Вся карта"], ["pet", "Найти Мохлика"], ["plesk", "Найти Плёску"], ["fishing", "Рыбацкий берег"]] as const).map(([action, label]) =>
          <button type="button" key={action} onClick={() => { worldDevStore.triggerCamera(action); onFeedback(`Камера: ${label.toLowerCase()}`); }}>{label}</button>)}
      </div></fieldset>}
      <div className={styles.shortcuts}>
        {([["Большая карта", onOpenWorld], ["Календарь", onOpenCalendar], ["Игра и рейтинг", onOpenGame], ["Мой статус", onOpenStatus], ["Гардероб", onOpenWardrobe], ["Коллекции", onOpenCollection]] as const)
          .filter(([, callback]) => callback).map(([label, callback]) => <button key={label} type="button" onClick={() => { if (callback) shortcut(callback); }}>{label}</button>)}
        <a href="/prototype/tiled-world">Карта и маршруты ↗</a>
      </div>
      <Section title="О DEV и ограничениях">
        <p className={styles.scope}>Настройки вида действуют в этой вкладке и сбрасываются при перезагрузке. «Читы» меняют ресурсы и постройки тестового профиля на сервере. Сброс вида не отменяет читы и не удаляет память Мохлика.</p>
        <p className={styles.hint}>Валюта, материалы и мгновенная постройка — в отдельной вкладке «Читы».</p>
      </Section>
    </>}
  </div>;
}

export default WorldDevPanel;
