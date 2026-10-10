"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, Crosshair, Download, Expand, Footprints, Hand, LoaderCircle, Move, RotateCcw, Upload, ZoomIn, ZoomOut } from "lucide-react";
import sceneData from "@/features/world/tiled/forest.generated.json";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { PhaserLabMode, PhaserSiteTransform, PhaserWorldHandle, PhaserWorldOptions, PhaserWorldStatus } from "./contracts";
import { applyPhaserOptions, getSiteTransform, initialPhaserOptions, PHASER_DRAFT_MAX_BYTES, PHASER_TRANSFORM_LIMITS, readPhaserDraft, sanitizePhaserTransform, serializePhaserDraft, transformKey } from "./model";
import styles from "./phaser-world-lab.module.css";

const source = sceneData as FixedWorldScene;
const STORAGE_KEY = "zhiv:phaser-lab:v1";
const initialStatus: PhaserWorldStatus = { loading: true, error: null, message: "Подготавливаем лес…", renderer: "—", fps: 0, zoom: 1, moving: false, actor: null };
const modes: { id: PhaserLabMode; label: string; icon: typeof Hand; hint: string }[] = [
  { id: "inspect", label: "Осмотреть", icon: Hand, hint: "Нажми на здание, чтобы выбрать его. Потяни карту, чтобы осмотреть лес." },
  { id: "walk", label: "Гулять", icon: Footprints, hint: "Нажми на доступную землю — Мохлик найдёт путь. Перетаскивание двигает камеру." },
  { id: "place", label: "Разместить", icon: Move, hint: "Потяни здание: рисунок, опора, вход и препятствие переместятся вместе. За пустое место двигай карту." },
];

function pointLabel(point: WorldPoint | undefined): string {
  return point ? `${Math.round(point.x)}, ${Math.round(point.y)}` : "—";
}

function footprintLabel(points: WorldPoint[]): string {
  if (!points.length) return "не задано";
  return `${Math.round(Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)))} × ${Math.round(Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)))}`;
}

function TransformField({ label, field, value, min, max, step, onChange }: { label: string; field: keyof PhaserSiteTransform; value: number; min: number; max: number; step: number; onChange(value: number): void }) {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(String(value)); }, [value]);
  return <label className={styles.field}>{label}<input type="number" data-testid={`transform-${field}`} value={text} min={min} max={max} step={step}
    onFocus={() => { editing.current = true; }}
    onChange={event => {
      const next = event.target.value;
      setText(next);
    }}
    onBlur={() => {
      editing.current = false;
      const next = text.trim() && Number.isFinite(Number(text)) ? Math.min(max, Math.max(min, Number(text))) : value;
      setText(String(next));
      onChange(next);
    }}
    onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
  /></label>;
}

export function PhaserWorldLab() {
  const stage = useRef<HTMLDivElement>(null);
  const runtime = useRef<PhaserWorldHandle | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importSequence = useRef(0);
  const [options, setOptions] = useState<PhaserWorldOptions>(() => initialPhaserOptions(source));
  const latestOptions = useRef(options);
  const [status, setStatus] = useState<PhaserWorldStatus>(initialStatus);
  const [retryKey, setRetryKey] = useState(0);
  const [storageReady, setStorageReady] = useState(false);
  const [storagePaused, setStoragePaused] = useState(false);
  const [rejectedDraft, setRejectedDraft] = useState<string | null>(null);
  const [storageNote, setStorageNote] = useState("Изменения сохраняются только в этом браузере.");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const effectiveScene = useMemo(() => applyPhaserOptions(source, options), [options]);
  const selected = effectiveScene.sites.find(site => site.id === options.selectedSiteId);
  const sourceSelected = source.sites.find(site => site.id === options.selectedSiteId);
  const selectedLevel = sourceSelected ? options.levels[sourceSelected.id] ?? sourceSelected.initialLevel : 0;
  const transform = sourceSelected ? getSiteTransform(options.transforms, sourceSelected.id, selectedLevel) : { dx: 0, dy: 0, scale: 1 };
  const ready = !status.loading && !status.error;

  useEffect(() => {
    // Restore the browser-only draft after hydration; Strict Mode cleanup cancels the first task.
    const restore = window.setTimeout(() => {
      let saved: string | null = null;
      try {
        saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const draft = readPhaserDraft(source, saved);
          setOptions(current => ({ ...current, ...draft }));
          setStorageNote("Восстановлен черновик этого браузера.");
        }
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : "Не удалось прочитать локальный черновик.");
        if (saved) {
          setStoragePaused(true);
          setRejectedDraft(saved);
          setStorageNote("Автосохранение приостановлено. Прежний черновик сохранён; скачай его перед началом нового.");
        }
      }
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const desktop = window.matchMedia("(min-width: 960px)");
    const onMotion = () => setOptions(current => ({ ...current, reducedMotion: motion.matches }));
    const onLayout = () => setInspectorOpen(desktop.matches);
    onMotion(); onLayout();
    motion.addEventListener("change", onMotion);
    desktop.addEventListener("change", onLayout);
    return () => {
      motion.removeEventListener("change", onMotion);
      desktop.removeEventListener("change", onLayout);
    };
  }, []);

  useEffect(() => {
    if (!storageReady || storagePaused) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, serializePhaserDraft(source, { ...latestOptions.current, levels: options.levels, transforms: options.transforms }));
        setStorageNote("Черновик сохранён в этом браузере.");
      } catch {
        setStorageNote("Браузер не разрешил сохранение. Скачай JSON, чтобы оставить черновик.");
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [storageReady, storagePaused, options.levels, options.transforms]);

  useEffect(() => {
    latestOptions.current = options;
    runtime.current?.update(options);
  }, [options]);

  useEffect(() => {
    const parent = stage.current;
    if (!parent) return;
    const controller = new AbortController();
    let handle: PhaserWorldHandle | null = null;
    setStatus(initialStatus);
    void import("./runtime").then(({ createPhaserWorld }) => {
      if (controller.signal.aborted) return;
      handle = createPhaserWorld(parent, source, latestOptions.current, {
        onSelect: id => {
          if (!controller.signal.aborted) setOptions(current => ({ ...current, selectedSiteId: id }));
        },
        onTransform: (siteId, level, next) => {
          if (!controller.signal.aborted) setOptions(current => ({ ...current, transforms: { ...current.transforms, [transformKey(siteId, level)]: sanitizePhaserTransform(next) } }));
        },
        onStatus: next => { if (!controller.signal.aborted) setStatus(next); },
      }, controller.signal);
      if (controller.signal.aborted) { handle.dispose(); return; }
      runtime.current = handle;
      handle.update(latestOptions.current);
    }).catch(error => {
      if (!controller.signal.aborted) setStatus(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Не удалось запустить Phaser." }));
    });
    return () => {
      controller.abort();
      handle?.dispose();
      if (runtime.current === handle) runtime.current = null;
    };
  }, [retryKey]);

  useEffect(() => () => { importSequence.current += 1; }, []);

  function changeTransform(field: keyof PhaserSiteTransform, numeric: number) {
    if (!sourceSelected || !Number.isFinite(numeric)) return;
    const key = transformKey(sourceSelected.id, selectedLevel);
    setOptions(current => ({ ...current, transforms: { ...current.transforms, [key]: sanitizePhaserTransform({ ...getSiteTransform(current.transforms, sourceSelected.id, selectedLevel), [field]: numeric }) } }));
  }

  function resetSelected() {
    if (!sourceSelected) return;
    const key = transformKey(sourceSelected.id, selectedLevel);
    setOptions(current => {
      const transforms = { ...current.transforms };
      delete transforms[key];
      return { ...current, transforms };
    });
  }

  function resetScene() {
    importSequence.current += 1;
    setOptions(current => ({ ...initialPhaserOptions(source), reducedMotion: current.reducedMotion }));
    setDraftError(null);
    setRejectedDraft(null);
    setStoragePaused(false);
    runtime.current?.reset();
  }

  function downloadDraft(contents: string, filename: string) {
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportDraft() {
    downloadDraft(serializePhaserDraft(source, latestOptions.current), "forest-phaser-draft.json");
    if (storagePaused) return;
    setStorageNote("JSON скачан. Его можно прислать для переноса разметки в Tiled.");
  }

  async function importDraft(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const sequence = ++importSequence.current;
    try {
      if (file.size > PHASER_DRAFT_MAX_BYTES) throw new Error(`Черновик слишком большой: максимум ${PHASER_DRAFT_MAX_BYTES / 1024} КБ.`);
      const draft = readPhaserDraft(source, await file.text());
      if (importSequence.current !== sequence) return;
      setOptions(current => ({ ...current, ...draft }));
      setDraftError(null);
      setRejectedDraft(null);
      setStoragePaused(false);
      setStorageNote("Черновик импортирован. Он появится только в этой лаборатории.");
    } catch (error) {
      if (importSequence.current === sequence) setDraftError(error instanceof Error ? error.message : "Не удалось прочитать JSON.");
    }
  }

  function toggle(key: "grid" | "geometry" | "shadows" | "night" | "snap") {
    setOptions(current => ({ ...current, [key]: !current[key] }));
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false} className={styles.back} aria-label="Вернуться в приложение"><ArrowLeft size={20} aria-hidden /></Link>
      <div className={styles.heading}><p>Мир Мохлика · Phaser</p><h1>Лесная лаборатория</h1></div>
      <span className={styles.badge}>Эксперимент</span>
    </header>
    <div className={styles.layout}>
      <section className={styles.world} aria-label="Экспериментальная сцена Phaser">
        <div className={styles.sceneHeader}>
          <div><span className={styles.dot} /> Лесная долина <span className={styles.sceneSource}>из Tiled</span></div>
          <span className={styles.renderer} data-testid="phaser-renderer">{status.renderer}</span>
        </div>
        <div className={styles.modes} role="group" aria-label="Действие на карте">
          {modes.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={options.mode === id} data-testid={`mode-${id}`} onClick={() => setOptions(current => ({ ...current, mode: id }))}><Icon size={17} aria-hidden />{label}</button>)}
        </div>
        <div className={styles.viewport}>
          <div ref={stage} className={styles.stage} data-testid="phaser-stage" data-ready={ready} data-actor-x={status.actor?.x} data-actor-y={status.actor?.y} data-zoom={status.zoom} data-moving={status.moving} role="group" aria-label="Карта леса. Управление описано под картой." />
          {(status.loading || status.error) && <div className={styles.overlay} role="status">
            {status.loading ? <><LoaderCircle size={30} className={styles.spinner} aria-hidden /><strong>Собираем лес…</strong><span>Загружаем карту, постройки и Мохлика.</span></> : <><strong>Сцену не удалось открыть</strong><span>{status.error}</span><button type="button" onClick={() => setRetryKey(current => current + 1)}>Попробовать ещё раз</button></>}
          </div>}
          <div className={styles.cameraTools} role="group" aria-label="Камера">
            <button type="button" disabled={!ready} onClick={() => runtime.current?.zoom(1.2)} aria-label="Приблизить" title="Приблизить"><ZoomIn size={20} aria-hidden /></button>
            <button type="button" disabled={!ready} onClick={() => runtime.current?.zoom(1 / 1.2)} aria-label="Отдалить" title="Отдалить"><ZoomOut size={20} aria-hidden /></button>
            <button type="button" disabled={!ready} onClick={() => runtime.current?.focus("world")} aria-label="Вся карта" title="Вся карта"><Expand size={19} aria-hidden /></button>
            <button type="button" disabled={!ready} onClick={() => runtime.current?.focus("actor")} aria-label="Найти Мохлика" title="Найти Мохлика"><Footprints size={20} aria-hidden /></button>
          </div>
          <div className={styles.zoomLabel} aria-hidden>{Math.round(status.zoom * 100)}%</div>
        </div>
        <p className={styles.interactionHint}>{modes.find(mode => mode.id === options.mode)?.hint}</p>
        <div className={styles.sceneFooter}>
          <p role="status" aria-live="polite" data-testid="phaser-status">{status.message}</p>
          <span className={styles.metrics} aria-label={`Частота кадров: ${Math.round(status.fps)}`}>{Math.round(status.fps)} FPS · {status.moving ? "Мохлик идёт" : "Мохлик отдыхает"}</span>
        </div>
      </section>

      <aside className={styles.sidebar}>
        <details className={styles.inspector} open={inspectorOpen}>
          <summary onClick={event => { event.preventDefault(); setInspectorOpen(current => !current); }}><span>Настройка сцены <small>{sourceSelected?.label ?? "Выбери объект"}</small></span><ChevronDown size={20} aria-hidden /></summary>
          <div className={styles.inspectorContent}>
            <section className={styles.section} aria-label="Выбранный объект">
              <label className={styles.field}>Объект<select data-testid="site-select" value={options.selectedSiteId ?? ""} onChange={event => setOptions(current => ({ ...current, selectedSiteId: event.target.value || null }))}>
                <option value="">Не выбран</option>{source.sites.map(site => <option key={site.id} value={site.id}>{site.label}</option>)}
              </select></label>
              {sourceSelected && <>
                <label className={styles.field}>Уровень рисунка<select data-testid="level-select" value={selectedLevel} onChange={event => setOptions(current => ({ ...current, levels: { ...current.levels, [sourceSelected.id]: Number(event.target.value) } }))}>{sourceSelected.states.map(state => <option key={state.level} value={state.level}>{state.level} · {state.label}</option>)}</select></label>
                <button type="button" className={styles.wideButton} disabled={!ready} onClick={() => runtime.current?.focus(sourceSelected.id)}><Crosshair size={16} aria-hidden />Показать объект</button>
                <div className={styles.transformFields}>
                  <TransformField key={`${sourceSelected.id}:${selectedLevel}:dx`} label="Сдвиг X" field="dx" value={transform.dx} min={-PHASER_TRANSFORM_LIMITS.offset} max={PHASER_TRANSFORM_LIMITS.offset} step={1} onChange={value => changeTransform("dx", value)} />
                  <TransformField key={`${sourceSelected.id}:${selectedLevel}:dy`} label="Сдвиг Y" field="dy" value={transform.dy} min={-PHASER_TRANSFORM_LIMITS.offset} max={PHASER_TRANSFORM_LIMITS.offset} step={1} onChange={value => changeTransform("dy", value)} />
                  <TransformField key={`${sourceSelected.id}:${selectedLevel}:scale`} label="Масштаб" field="scale" value={transform.scale} min={PHASER_TRANSFORM_LIMITS.minScale} max={PHASER_TRANSFORM_LIMITS.maxScale} step={0.05} onChange={value => changeTransform("scale", value)} />
                </div>
                <button type="button" className={styles.textButton} onClick={resetSelected}><RotateCcw size={15} aria-hidden />Вернуть этот уровень на место</button>
                <dl className={styles.geometryValues}><div><dt>Опора</dt><dd>{pointLabel(selected?.anchor)}</dd></div><div><dt>Вход</dt><dd>{pointLabel(selected?.entry)}</dd></div><div><dt>Занятое место</dt><dd>{footprintLabel(selected?.collision ?? [])}</dd></div></dl>
                <p className={styles.note}>Сдвиг и масштаб относятся к выбранному уровню. Координаты — в единицах карты. Сетка помогает выравнивать, но не меняет форму препятствий.</p>
              </>}
            </section>
            <section className={styles.section} aria-label="Отображение и разметка">
              <h2>Вид и разметка</h2>
              <div className={styles.toggles}>
                {([["grid", "Сетка"], ["geometry", "Геометрия"], ["shadows", "Тени у земли"], ["night", "Ночь"], ["snap", "Привязка к сетке"]] as const).map(([key, label]) => <label key={key} className={styles.toggle}><input type="checkbox" checked={options[key]} onChange={() => toggle(key)} data-testid={`toggle-${key}`} /><span>{label}</span></label>)}
              </div>
              <label className={styles.field}>Шаг сетки<select value={options.gridSize} onChange={event => setOptions(current => ({ ...current, gridSize: Number(event.target.value) }))}>{[16, 32, 64].map(size => <option key={size} value={size}>{size} единиц</option>)}</select></label>
              <p className={styles.note}>Привязка действует при перетаскивании. Масштаб меняет рисунок и всю связанную геометрию вокруг опоры.</p>
              <div className={styles.legend} aria-label="Обозначения геометрии"><span><i className={styles.anchor} />Опора</span><span><i className={styles.entry} />Вход</span><span><i className={styles.collision} />Препятствие</span><span><i className={styles.hit} />Область нажатия</span></div>
            </section>
            <section className={styles.section} aria-label="Черновик разметки">
              <h2>Черновик разметки</h2>
              <p className={styles.note}>{storageNote}</p>
              <div className={styles.draftTools}>
                <button type="button" onClick={exportDraft}><Download size={16} aria-hidden />Скачать JSON</button>
                <button type="button" onClick={() => importInput.current?.click()}><Upload size={16} aria-hidden />Открыть JSON</button>
              </div>
              <input ref={importInput} className={styles.hiddenInput} type="file" accept=".json,application/json" aria-label="Открыть черновик JSON" onChange={event => { void importDraft(event); }} data-testid="draft-input" />
              {draftError && <div className={styles.error} role="alert"><p>{draftError}</p><p>Текущая разметка не заменена этим файлом.</p>
                {rejectedDraft && <button type="button" onClick={() => downloadDraft(rejectedDraft, "forest-phaser-previous-draft.json")}>Скачать прежний черновик</button>}
                <button type="button" onClick={() => { setDraftError(null); setRejectedDraft(null); setStoragePaused(false); }}>{storagePaused ? "Начать новый черновик" : "Понятно"}</button>
              </div>}
              <button type="button" className={styles.textButton} data-testid="reset-scene" onClick={resetScene}><RotateCcw size={15} aria-hidden />Сбросить всю лабораторию</button>
            </section>
          </div>
        </details>
        <div className={styles.scopeNote}><span className={styles.scopeDot} /><p>Отдельная сцена для экспериментов.<br />Прогресс игрока и исходная карта остаются прежними.</p></div>
      </aside>
    </div>
    <details className={styles.guide}>
      <summary>С чего начать проверку</summary>
      <ol><li>Выбери мастерскую и нажми «Показать объект». Включи геометрию и посмотри, где её опора, вход и занятое место.</li><li>Перейди в «Разместить», подвинь здание, измени масштаб или уровень. В «Гулять» направь Мохлика рядом с ним.</li><li>Сравни день и ночь, отключи тени, проверь масштаб на телефоне. При удачном расположении скачай JSON.</li></ol>
      <p>Колесо мыши и жест двумя пальцами меняют масштаб. Стрелки двигают карту, +/− приближают и отдаляют, когда карта в фокусе. Это первый этап переноса: ночная подсветка и тени у основания не заменяют normal map и падающие тени.</p>
    </details>
  </main>;
}
