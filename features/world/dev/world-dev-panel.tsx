"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, FlaskConical, RotateCcw, X } from "lucide-react";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { worldCatalog } from "../model";
import { TILED_WORLD } from "../presentation";
import { clearingRouteDiagnostics } from "../clearing-activity";
import type { WorldController } from "../use-world";
import { WORLD_DEV_DEFAULTS, WORLD_DEV_ENABLED, WORLD_DEV_POSES, worldDevStore, type WorldDevLifeAction, type WorldDevState } from "./world-dev-store";
import styles from "./world-dev-panel.module.css";

export type WorldDevPanelProps = {
  world: WorldController;
  active?: boolean;
  worldView?: boolean;
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
const clearingRoutes = clearingRouteDiagnostics(TILED_WORLD);
const routeReasons: Record<string, string> = {
  "missing-actor": "Нет корректной точки Мохлика.", "invalid-points": "Нужны от 2 до 64 вершин линии.",
  "start-away-from-spawn": "Первая вершина должна совпадать с точкой Мохлика.", "invalid-focus": "Проверьте область фокуса круга.",
  "invalid-activity": "Неизвестное занятие в конце маршрута.", "invalid-pause": "Пауза должна быть от 2 до 20 секунд.",
  "outside-clearing-radius": "Маршрут уходит слишком далеко от домашней точки.", "outside-map": "Герой выходит за край карты.",
  "outside-focus": "Герой не помещается в круг главного экрана.", "building-collision": "Лапы пересекают коллизию здания.",
  "water-collision": "Маршрут проходит по воде.", "invalid-length": "Маршрут слишком короткий или длинный для полянки.",
};
const DIRECTIONS = [["front", "Лицом"], ["back", "Спиной"], ["left", "Влево"], ["right", "Вправо"]] as const;
const LIFE_ACTIONS = [
  ["butterfly", "Поиграть с бабочкой"], ["firefly", "Поиграть со светлячком"],
  ["mushroom", "Съесть гриб"], ["grow-mushrooms", "Вырастить грибы"], ["idle", "Отменить сценку"],
] as const satisfies readonly (readonly [WorldDevLifeAction, string])[];

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

/** The whole drawer is absent from production; visual settings never become game commands. */
export function WorldDevPanel(props: WorldDevPanelProps) {
  return WORLD_DEV_ENABLED ? <DevelopmentPanel {...props} /> : null;
}

function DevelopmentPanel({ world, active = true, worldView = false, onOpenWorld, onOpenCalendar, onOpenGame, onOpenStatus, onOpenWardrobe, onOpenCollection }: WorldDevPanelProps) {
  const state = useSyncExternalStore(worldDevStore.subscribe, worldDevStore.getSnapshot, worldDevStore.getServerSnapshot);
  const prefersReducedMotion = useSyncExternalStore(subscribeMotion, systemMotion, serverMotion);
  const [open, setOpen] = useState(false);
  const [collapseOnPlay, setCollapseOnPlay] = useState(false);
  const [lastAction, setLastAction] = useState<ManualAction | null>(null);
  const [feedback, setFeedback] = useState("");
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
    : reduced ? "Для анимаций выберите «Выключить» в настройке «Меньше движения»." : null;
  const heroUnavailable = motionUnavailable ?? (!state.showHero ? "Мохлик скрыт. Включите «Показывать Мохлика»." : null);
  const birdsUnavailable = motionUnavailable ?? (state.birds === "off" ? "Птицы выключены. Выберите «Авто» или «Включить»." : null);
  function unavailable(action: ManualAction) {
    if (action.kind === "birds") return birdsUnavailable;
    if (action.kind === "pose") return heroUnavailable;
    if (action.action === "idle") return null;
    if (action.action === "grow-mushrooms") return motionUnavailable;
    if (heroUnavailable) return heroUnavailable;
    if (action.action === "butterfly" && state.butterflies === "off") return "Бабочки выключены. Выберите «Авто» или «Включить».";
    if (action.action === "firefly" && state.fireflies === "off") return "Светлячки выключены. Выберите «Авто» или «Включить».";
    return null;
  }
  const repeatUnavailable = lastAction ? unavailable(lastAction) : null;
  const repeatLabel = lastAction?.kind === "pose" ? POSE_LABELS[lastAction.pose]
    : lastAction?.kind === "life" ? LIFE_ACTIONS.find(([kind]) => kind === lastAction.action)![1] : "Сценарий с птицами";
  const locked = world.busy || world.uncertain;
  const canGrant = process.env.NODE_ENV === "development" && world.snapshot?.devTools === true;
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
    if (action.kind === "birds") {
      worldDevStore.triggerBirds(); setFeedback("Птицы: пролёт, посадка на дерево и взлёт");
    } else if (action.kind === "life") {
      worldDevStore.triggerLife(action.action);
      setFeedback(action.action === "idle" ? "Сценка отменена. Автоматические сценки выключены."
        : `Лесная сценка: ${LIFE_ACTIONS.find(([kind]) => kind === action.action)![1].toLowerCase()}`);
    } else {
      worldDevStore.triggerPose(action.pose); setFeedback(`Анимация: ${POSE_LABELS[action.pose].toLowerCase()}`);
    }
    setLastAction(action);
    if (collapseOnPlay && open) close();
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
      <header className={styles.header}><div><h2 id={titleId}>Проверка леса</h2><p>Круг и большая карта · локальный режим</p></div>
        <button ref={closeButton} type="button" className={styles.iconButton} onClick={close} aria-label="Закрыть панель разработчика"><X size={20} aria-hidden /></button>
      </header>
      <div className={styles.body}>
        <p className={styles.scope}>Вид меняется только в этой вкладке. Закрытие панели сохраняет настройки, перезагрузка сбрасывает.</p>
        {state.artError && <p className={styles.error} role="alert">Не удалось показать графику: {state.artError}</p>}
        <div className={styles.globalControls}>
          <Toggle label="Пауза сцены" checked={state.paused} onChange={paused => change({ paused }, paused ? "Сцена на паузе" : "Сцена продолжена")} />
          <Select label="Меньше движения" value={state.reducedMotion} values={MODES} onChange={reducedMotion => change({ reducedMotion })} />
        </div>
        <Toggle label="Сворачивать при запуске" checked={collapseOnPlay} onChange={setCollapseOnPlay} />
        {(state.paused || reduced) && <p className={styles.hint}>{state.paused ? "Сцена на паузе. Снимите паузу для проигрывания событий." : "Движение ограничено. Показан статичный кадр; для анимаций выберите «Выключить»."}</p>}
        {prefersReducedMotion && state.reducedMotion === "off" && <p className={styles.hint}>Для предпросмотра включена анимация, хотя в системе выбрано меньше движения.</p>}

        <Section title="Погода и живность" initiallyOpen>
          <Select label="Погода" value={state.weather} values={WEATHER} onChange={weather => change({ weather })} />
          <Select label="Освещение" value={state.timeOfDay} values={TIME} onChange={timeOfDay => change({ timeOfDay })} />
          <div className={styles.columns}>
            <Select label="Бабочки" value={state.butterflies} values={MODES} onChange={butterflies => change({ butterflies })} />
            <Select label="Светлячки" value={state.fireflies} values={MODES} onChange={fireflies => change({ fireflies })} />
          </div>
          <Select label="Птицы" value={state.birds} values={MODES} onChange={birds => change({ birds })} />
          <Toggle label="Лужи после дождя" checked={state.puddles} onChange={puddles => change({ puddles })} />
          <button type="button" disabled={Boolean(birdsUnavailable)} onClick={() => play({ kind: "birds" })}>Сценарий с птицами</button>
          {birdsUnavailable && <p className={styles.hint}>{birdsUnavailable}</p>}
          <p className={styles.hint}>Птицы садятся на деревья, осматриваются и снова взлетают. Полная сценка длится около полуминуты. Дождевые круги на реке видны на большой карте.</p>
        </Section>

        <Section title="Лесные сценки" initiallyOpen>
          <Toggle label="Автоматические сценки" checked={state.autoLife} onChange={autoLife => change({ autoLife })} />
          <p className={styles.hint}>Включает прогулки по полянке и занятия на остановках. Выключение останавливает Мохлика на текущем месте; включение продолжает прогулку.</p>
          <div className={styles.lifeActions}>
            {LIFE_ACTIONS.map(([action, label]) => {
              const reason = unavailable({ kind: "life", action });
              const reasonId = `${id}-life-${action}-reason`;
              return <div key={action}>
                <button type="button" disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined}
                  onClick={() => play({ kind: "life", action })}>{label}</button>
                {reason && <p id={reasonId} className={styles.hint}>{reason}</p>}
              </div>;
            })}
          </div>
          <p className={styles.hint}>«Вырастить грибы» показывает быстрый рост из маленьких. «Съесть гриб» подготавливает один гриб для сценки. Наград и изменений инвентаря нет.</p>
          <p className={styles.hint}>В режиме «Авто» насекомое доступно для ручной сценки в любое время. Если Мохлик гуляет, он сначала вернётся к домашней точке по своей тропке. «Отменить сценку» останавливает его и выключает автоматические сценки.</p>
          <details><summary>Маршруты полянки · {clearingRoutes.filter(route => route.valid).length} доступны</summary>
            {clearingRoutes.length ? clearingRoutes.map(route => <p key={route.id} className={route.valid ? styles.hint : styles.error}>
              <strong>{route.id}</strong>: {route.valid ? "Готов к прогулке" : routeReasons[route.reason ?? ""] ?? "Проверьте разметку маршрута."}
            </p>) : <p className={styles.hint}>Добавьте линию с behavior = clearing в Tiled. Пока доступны только занятия на месте.</p>}
          </details>
        </Section>

        <Section title="Мохлик и анимации">
          <div className={styles.columns}>
            <Toggle label="Показывать Мохлика" checked={state.showHero} onChange={showHero => change({ showHero })} />
            <Toggle label="Тень под лапами" checked={state.heroShadow} onChange={heroShadow => change({ heroShadow })} />
          </div>
          <Select label="Повторять позу" value={state.pose} values={[["auto", "Обычное поведение"], ...WORLD_DEV_POSES.map(pose => [pose, POSE_LABELS[pose]] as const)]}
            onChange={pose => change({ pose, animation: null })} />
          <fieldset className={styles.fieldset}><legend>Поворот</legend><div className={styles.directions}>
            {DIRECTIONS.map(([direction, label]) => <button key={direction} type="button" aria-pressed={state.direction === direction} onClick={() => change({ direction })}>{label}</button>)}
          </div></fieldset>
          <Field label={`Размер · ${Math.round(state.heroScale * 100)}%`}><input type="range" min="0.5" max="2" step="0.05" value={state.heroScale}
            onChange={event => change({ heroScale: Number(event.target.value) })} /></Field>
          <fieldset className={styles.fieldset}><legend>Проиграть один раз</legend><div className={styles.poseGrid}>
            {WORLD_DEV_POSES.map(pose => <button type="button" key={pose} disabled={Boolean(heroUnavailable)}
              aria-describedby={heroUnavailable ? `${id}-pose-reason` : undefined} onClick={() => play({ kind: "pose", pose })}>{POSE_LABELS[pose]}</button>)}
          </div></fieldset>
          {heroUnavailable && <p id={`${id}-pose-reason`} className={styles.hint}>{heroUnavailable}</p>}
          <p className={styles.hint}>Ручная поза проигрывается на текущем месте. Для прогулок выберите «Обычное поведение» и включите автоматические сценки. Линии проверяются в редакторе карты.</p>
          <fieldset className={styles.fieldset}><legend>Примерка · без выдачи предметов</legend>
            {([['palette', 'Цвет мха'], ['head', 'Головной убор'], ['neck', 'Шарф']] as const).map(([slot, label]) =>
              <Field key={slot} label={label}><select value={appearance[slot] ?? ""} onChange={event => outfit(slot, event.target.value)}>
                {slot !== "palette" && <option value="">Без предмета</option>}
                {worldCatalog.items.filter(item => item.slot === slot).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select></Field>)}
            <button type="button" disabled={state.equipment === null} onClick={() => change({ equipment: null }, "Вернули одежду игрока")}>Одежда игрока</button>
            <p className={styles.hint}>Ивовая удочка показана в позах «Рыбачить» и «Идти с удочкой».</p>
          </fieldset>
        </Section>

        <Section title="Постройки и разметка">
          <Toggle label="Показывать постройки" checked={state.showBuildings} onChange={showBuildings => change({ showBuildings })} />
          <Toggle label="Тени у основания" checked={state.buildingShadow} onChange={buildingShadow => change({ buildingShadow })} />
          <Toggle label="Границы и точки карты" checked={state.debug} onChange={debug => change({ debug })} />
          {TILED_WORLD.sites.map(site => <Field key={site.id} label={site.label}>
            <select value={state.levels[site.id] ?? site.initialLevel} onChange={event => change({ levels: { ...state.levels, [site.id]: Number(event.target.value) } })}>
              {site.states.map(visual => <option key={visual.level} value={visual.level}>{visual.label} · уровень {visual.level}</option>)}
            </select>
          </Field>)}
          <p className={styles.hint}>Меняется только рисунок. Уровни и покупки игрока сохраняются.</p>
        </Section>

        <Section title="Тестовые ресурсы">
          <p className={styles.scope}>Выдача меняет баланс аккаунта в локальном API. Сброс вида её не отменяет.</p>
          {world.snapshot && <dl className={styles.resources}>
            <div><dt>Искры</dt><dd>{world.snapshot.state.resources.sparks.toLocaleString("ru-RU")}</dd></div>
            <div><dt>Дерево</dt><dd>{world.snapshot.state.resources.wood.toLocaleString("ru-RU")}</dd></div>
            <div><dt>Камень</dt><dd>{world.snapshot.state.resources.stone.toLocaleString("ru-RU")}</dd></div>
          </dl>}
          <button type="button" disabled={!canGrant || locked} onClick={() => { if (!canGrant || locked) return; world.act("dev_grant_resources"); setFeedback("Запрос на выдачу отправлен"); }}>
            {world.busy ? "Отправляем…" : "+50 искр, дерева и камня"}
          </button>
          {!canGrant && <p className={styles.hint}>{world.snapshot ? "Тестовая выдача недоступна на этом сервере." : "Ожидаем загрузку мира…"}</p>}
          {world.uncertain && <><p className={styles.hint}>Ответ не получен. Проверьте результат тем же запросом перед новой выдачей.</p>
            <button type="button" disabled={world.busy} onClick={() => { void world.retry(); setFeedback("Проверяем результат запроса"); }}>Проверить результат</button></>}
          {world.error && <p className={styles.error} role="alert">{world.error}</p>}
          {world.notice && <p className={styles.hint} role="status">{world.notice}</p>}
        </Section>

        <Section title="Открыть в приложении">
          {worldView && <fieldset className={styles.fieldset}><legend>Камера карты</legend><div className={styles.shortcuts}>
            {([["in", "Приблизить"], ["out", "Отдалить"], ["overview", "Вся карта"], ["pet", "Найти Мохлика"]] as const).map(([action, label]) =>
              <button type="button" key={action} onClick={() => { worldDevStore.triggerCamera(action); setFeedback(`Камера: ${label.toLowerCase()}`); }}>{label}</button>)}
          </div></fieldset>}
          <div className={styles.shortcuts}>
            {([["Большая карта", onOpenWorld], ["Календарь", onOpenCalendar], ["Игра и рейтинг", onOpenGame], ["Мой статус", onOpenStatus], ["Гардероб", onOpenWardrobe], ["Коллекции", onOpenCollection]] as const)
              .filter(([, callback]) => callback).map(([label, callback]) => <button key={label} type="button" onClick={() => { if (callback) shortcut(callback); }}>{label}</button>)}
            <a href="/prototype/tiled-world">Карта и маршруты ↗</a>
          </div>
        </Section>
        <p className={styles.pending}>Фонари и игровые улучшения новой карты появятся после адаптации.</p>
      </div>
      <footer className={styles.footer}>
        <p role="status" aria-live="polite">{repeatUnavailable ?? (feedback || (overrides ? `Изменений вида: ${overrides}` : "Обычный вид леса"))}</p>
        <button type="button" onClick={() => { worldDevStore.reset(); setLastAction(null); setFeedback("Все настройки вида сброшены"); }}><RotateCcw size={16} aria-hidden />Сбросить вид</button>
      </footer>
    </section>}
  </aside>;
}

export default WorldDevPanel;
