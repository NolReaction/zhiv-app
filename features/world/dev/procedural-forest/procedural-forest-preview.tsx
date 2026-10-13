"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, Expand, Grid2X2, Hand, Leaf, Minus, MousePointer2, Plus, Redo2, RotateCcw, Shuffle, Sprout, Trees, Undo2, Upload, X } from "lucide-react";
import type { ForestStatus, ToolMode } from "./controller";
import { INITIAL_SEED, INITIAL_WIDTH, MAX_WIDTH, type ObjectKind } from "./objects";
import { EditorInspector, objectNames } from "./editor-inspector";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("./controller")["createForestController"]>;
const modes = [{ id: "select", label: "Выбрать", shortcut: "V", icon: MousePointer2 }, { id: "pan", label: "Осмотреть", shortcut: "H", icon: Hand }, { id: "plant", label: "Добавить", shortcut: "B", icon: Sprout }, { id: "erase", label: "Убрать", shortcut: "E", icon: X }] as const;
const kinds: ObjectKind[] = ["tree", "shrub", "rock", "ruins", "bridge", "jetty", "stump-house"];

export function ProceduralForestPreview() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneFile = useRef<HTMLInputElement>(null);
  const controller = useRef<Controller | null>(null);
  const [status, setStatus] = useState<ForestStatus>({ seed: INITIAL_SEED, width: INITIAL_WIDTH, objects: 0, zoom: 0, edited: 0, message: "Открываем карту…", selected: null, canUndo: false, canRedo: false, storage: "unavailable", brush: "tree", mode: "select", temporaryPan: false, trees: true, grid: false });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = status.mode;
  const activeMode = status.temporaryPan ? "pan" : mode;
  const trees = status.trees;
  const grid = status.grid;

  useEffect(() => {
    let cancelled = false;
    void import("./controller").then(({ createForestController }) => {
      if (cancelled || !canvas.current) return;
      controller.current = createForestController(canvas.current, next => { setStatus(next); setReady(true); });
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Не удалось открыть карту."); });
    return () => { cancelled = true; controller.current?.dispose(); controller.current = null; };
  }, []);

  function changeMode(next: ToolMode) { controller.current?.setMode(next); }
  function chooseKind(kind: ObjectKind) {
    controller.current?.setBrush(kind);
    if (!trees && (kind === "tree" || kind === "shrub")) controller.current?.setLayer("trees", true);
    changeMode("plant");
  }
  async function importScene(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("Файл сцены слишком большой. Выбери JSON до 2 МБ.");
      const imported = controller.current?.importScene(await file.text());
      if (imported) { setError(null); changeMode("select"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать сцену."); }
    if (sceneFile.current) sceneFile.current.value = "";
  }

  return (
    <main className={styles.page} data-forest-editor tabIndex={-1}>
      <header className={styles.header}>
        <Link href="/" prefetch={false} className={styles.back} aria-label="В приложение"><ArrowLeft size={20} /></Link>
        <div className={styles.brand}><Leaf size={24} strokeWidth={1.5} /><span>МОХЛИК <span className={styles.divider}>/</span> МАСТЕРСКАЯ МИРА</span></div>
        <span className={styles.badge}>ENGINE · РЕДАКТОР МИРА</span>
      </header>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.intro}><span className={styles.eyebrow}>МАСТЕРСКАЯ МИРА</span><h1>Собери свою карту.</h1><p>Выбери предмет, перетащи его и измени размер. Добавляй деревья, камни и постройки. Скачай сцену, чтобы продолжить на другом компьютере.</p></div>
          <div className={styles.section}>
            <span className={styles.label}>01 <span>ИНСТРУМЕНТ</span></span>
            <div className={styles.modes} role="group" aria-label="Инструмент карты">{modes.map(({ id, label, shortcut, icon: Icon }) => <EditorButton key={id} type="button" disabled={!ready} aria-label={label} aria-keyshortcuts={shortcut} title={label + " (" + shortcut + ")"} aria-pressed={activeMode === id} onClick={() => changeMode(id)}><Icon size={18} /><span>{label}</span><kbd aria-hidden="true">{shortcut}</kbd></EditorButton>)}</div>
            <p className={styles.small}>{mode === "select" ? "Нажми на предмет и перетащи его. За свободную землю можно двигать карту." : mode === "pan" ? "Перетаскивай карту. Колесо или два пальца — масштаб." : mode === "plant" ? objectNames[status.brush] + ": нажми на карту, чтобы добавить." : "Нажми на предмет, чтобы удалить. Можно отменить действие."}</p>
            <div className={styles.historyActions}><EditorButton type="button" aria-label="Отменить" disabled={!status.canUndo} onClick={() => controller.current?.undo()}><Undo2 size={16} /> Отменить</EditorButton><EditorButton type="button" aria-label="Повторить" disabled={!status.canRedo} onClick={() => controller.current?.redo()}><Redo2 size={16} /> Повторить</EditorButton></div>
          </div>
          <div className={styles.section}>
            <span className={styles.label}>02 <span>ВЫБРАННЫЙ ПРЕДМЕТ</span></span>
            <EditorInspector key={status.selected?.id ?? "empty"} object={status.selected} width={status.width} update={patch => controller.current?.updateSelected(patch)} duplicate={() => controller.current?.duplicateSelected()} remove={() => controller.current?.deleteSelected()} />
          </div>
          <div className={styles.section}>
            <span className={styles.label}>03 <span>ДОБАВИТЬ НА КАРТУ</span></span>
            <div className={styles.palette} role="group" aria-label="Предмет для добавления">{kinds.map((kind, index) => <EditorButton type="button" key={kind} disabled={!ready} aria-label={objectNames[kind]} aria-keyshortcuts={String(index + 1)} title={objectNames[kind] + " (" + (index + 1) + ")"} aria-pressed={mode === "plant" && status.brush === kind} onClick={() => chooseKind(kind)}><span>{objectNames[kind]}</span><kbd aria-hidden="true">{index + 1}</kbd></EditorButton>)}</div>
            <p className={styles.small}>Деревья и кусты растут на земле. Мост и причал можно поставить у воды.</p>
          </div>
          <div className={styles.section}>
            <span className={styles.label}>04 <span>ТЕРРИТОРИЯ И СЛОИ</span></span>
            <EditorButton type="button" className={styles.expandButton} disabled={!ready || status.width >= MAX_WIDTH} onClick={() => controller.current?.expand()}><span>{status.width >= MAX_WIDTH ? "Тестовый мир открыт" : "Продолжить лес вправо"}</span><ArrowRight size={18} /></EditorButton>
            <div className={styles.toggles}>
              <EditorButton type="button" disabled={!ready} aria-pressed={trees} onClick={() => controller.current?.setLayer("trees", !trees)}><Trees size={17} /> Растительность <span className={styles.switch} /></EditorButton>
              <EditorButton type="button" disabled={!ready} aria-pressed={grid} onClick={() => controller.current?.setLayer("grid", !grid)}><Grid2X2 size={17} /> Границы участков <span className={styles.switch} /></EditorButton>
            </div>
            {!trees && <p className={styles.small}>Деревья и кусты скрыты. Включи «Растительность», чтобы увидеть их снова.</p>}
            <p className={styles.small}>Форма земли, троп и воды пока задана отдельно. Эти слои ещё нельзя рисовать кистью.</p>
          </div>
          <div className={styles.section}>
            <span className={styles.label}>05 <span>СОХРАНЕНИЕ</span></span>
            <div className={styles.fileActions}>
              <EditorButton type="button" disabled={!ready} onClick={() => controller.current?.exportScene()}><Download size={16} /> Скачать сцену</EditorButton>
              <EditorButton type="button" disabled={!ready} onClick={() => sceneFile.current?.click()}><Upload size={16} /> Открыть сцену</EditorButton>
              <EditorButton type="button" disabled={!ready} onClick={() => controller.current?.exportPng()}><Download size={16} /> Скачать PNG</EditorButton>
            </div>
            <input ref={sceneFile} type="file" accept="application/json,.json" aria-label="Файл сцены" className={styles.fileInput} onChange={event => { void importScene(event.target.files?.[0]); }} />
            <p className={styles.saveState}>{!ready ? "Открываем карту…" : status.storage === "saved" ? "Правки сохранены в этом браузере." : "Автосохранение недоступно. Скачай сцену, чтобы сохранить правки."}</p>
            <p className={styles.small}>Сцена сохраняет предметы и их параметры для дальнейшего редактирования. PNG — готовый рисунок карты.</p>
            {error && ready && <p role="alert" className={styles.importError}>{error}</p>}
          </div>
          <div className={styles.actions}>
            <EditorButton type="button" disabled={!ready} onClick={() => controller.current?.regenerate()}><Shuffle size={16} /> Другой лес</EditorButton>
            <EditorButton type="button" disabled={!ready || !status.edited} onClick={() => controller.current?.resetEdits()}><RotateCcw size={16} /> Сбросить правки</EditorButton>
          </div>
          <p className={styles.note}>«Другой лес» меняет растительность и сбрасывает расстановку. Действие можно отменить. Это отдельная мастерская для тестирования карты.</p>
          <details className={styles.shortcutHelp}>
            <summary>Клавиши и мышь</summary>
            <dl>
              <div><dt><kbd>V</kbd> / <kbd>H</kbd></dt><dd>Выбрать предмет / двигать карту</dd></div>
              <div><dt><kbd>B</kbd> / <kbd>E</kbd></dt><dd>Добавить / убрать предмет</dd></div>
              <div><dt><kbd>1</kbd>…<kbd>7</kbd></dt><dd>Выбрать предмет в палитре; 7 — дом-пень</dd></div>
              <div><dt><kbd>Пробел</kbd></dt><dd>Удерживать и тянуть — двигать карту; также работает средняя кнопка мыши</dd></div>
              <div><dt><kbd>Shift</kbd></dt><dd>При перетаскивании двигать по одной оси; со стрелками шаг 10 единиц</dd></div>
              <div><dt><kbd>Ctrl/⌘ D</kbd></dt><dd>Дублировать выбранный предмет</dd></div>
              <div><dt><kbd>Ctrl/⌘ Z</kbd></dt><dd>Отменить; с Shift — повторить</dd></div>
              <div><dt><kbd>Delete</kbd></dt><dd>Удалить выбранный предмет</dd></div>
              <div><dt><kbd>Escape</kbd></dt><dd>Отменить незавершённое перемещение или снять выбор</dd></div>
              <div><dt><kbd>0</kbd> / <kbd>+</kbd> / <kbd>−</kbd></dt><dd>Вся карта / приблизить / отдалить</dd></div>
            </dl>
            <p>Буквенные клавиши работают и в русской раскладке. Во время ввода в поля горячие клавиши не переключают инструменты.</p>
          </details>
        </aside>
        <section className={styles.mapPanel} aria-label="Тестовая карта леса">
          <div className={styles.mapHeading}><span><i /> Лесная долина</span><span>{status.width} × 1600</span></div>
          <div className={styles.viewport}>
            <canvas ref={canvas} tabIndex={0} className={styles.canvas} aria-label="Лесная карта" aria-describedby="forest-keyboard-help">Для карты требуется Canvas 2D.</canvas>
            {(mode === "plant" || mode === "erase") && !status.temporaryPan && <span className={styles.crosshair} aria-hidden>+</span>}
            {status.temporaryPan && <span className={styles.panHint}>Перемещение карты</span>}
            {!ready && <div className={styles.loading} role={error ? "alert" : "status"}>{error ?? "Открываем карту…"}</div>}
            <div className={styles.mapTools} aria-label="Управление масштабом">
              <EditorButton type="button" disabled={!ready} onClick={() => controller.current?.zoom(1.25)} aria-label="Приблизить"><Plus size={19} /></EditorButton>
              <EditorButton type="button" disabled={!ready} onClick={() => controller.current?.zoom(.8)} aria-label="Отдалить"><Minus size={19} /></EditorButton>
              <span>{Math.round(status.zoom * 100)}%</span>
              <EditorButton type="button" disabled={!ready} onClick={() => controller.current?.fit()} aria-label="Показать весь лес"><Expand size={18} /></EditorButton>
            </div>
          </div>
          <div className={styles.mapFooter}><span>SEED {status.seed} <span className={styles.dim}>·</span> {status.objects} объектов</span><span className={styles.footerDetail}>{status.edited} ПРАВОК</span></div>
          <p className={styles.status} role="status">{status.message}</p>
          <p id="forest-keyboard-help" className={styles.keyboard}>V — выбор · H — обзор · B — добавить · E — убрать · Пробел + перетаскивание — двигать карту · Ctrl / ⌘ Z — отменить</p>
        </section>
      </div>
    </main>
  );
}
