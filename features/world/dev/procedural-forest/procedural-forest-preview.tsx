"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, Expand, Grid2X2, Hand, Leaf, Minus, Plus, RotateCcw, Shuffle, Sprout, Trees, X } from "lucide-react";
import type { ForestStatus, ToolMode } from "./controller";
import { INITIAL_SEED, INITIAL_WIDTH, MAX_WIDTH } from "./objects";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("./controller")["createForestController"]>;
const modes = [{ id: "pan", label: "Осмотреть", icon: Hand }, { id: "plant", label: "Посадить", icon: Sprout }, { id: "erase", label: "Убрать", icon: X }] as const;

export function ProceduralForestPreview() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<Controller | null>(null);
  const [status, setStatus] = useState<ForestStatus>({ seed: INITIAL_SEED, width: INITIAL_WIDTH, objects: 0, zoom: 0, edited: 0, message: "Выращиваем лес…" });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ToolMode>("pan");
  const [trees, setTrees] = useState(true);
  const [grid, setGrid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("./controller").then(({ createForestController }) => {
      if (cancelled || !canvas.current) return;
      controller.current = createForestController(canvas.current, next => { setStatus(next); setReady(true); });
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Не удалось собрать карту."); });
    return () => { cancelled = true; controller.current?.dispose(); controller.current = null; };
  }, []);

  function changeMode(next: ToolMode) { setMode(next); controller.current?.setMode(next); }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" prefetch={false} className={styles.back} aria-label="В приложение"><ArrowLeft size={20} /></Link>
        <div className={styles.brand}><Leaf size={24} strokeWidth={1.5} /><span>МОХЛИК <span className={styles.divider}>/</span> МАСТЕРСКАЯ МИРА</span></div>
        <span className={styles.badge}>ЭКСПЕРИМЕНТ 01</span>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.intro}><span className={styles.eyebrow}>ПРОЦЕДУРНЫЙ ЛЕС</span><h1>Мир, который <br />можно вырастить.</h1><p>Земля, вода и каждое дерево нарисованы кодом. Приблизь, измени поляну и открой продолжение леса.</p></div>
          <div className={styles.section}>
            <span className={styles.label}>01 <span>ПОПРОБУЙ РЕДАКТИРОВАТЬ</span></span>
            <div className={styles.modes} role="group" aria-label="Инструмент карты">
              {modes.map(({ id, label, icon: Icon }) => <button key={id} type="button" disabled={!ready || (!trees && id !== "pan")} aria-pressed={mode === id} onClick={() => changeMode(id)}><Icon size={18} /><span>{label}</span></button>)}
            </div>
            <p className={styles.small}>{mode === "pan" ? "Перетаскивай карту. Колесо или два пальца — масштаб." : mode === "plant" ? "Нажми на свободную землю. Новое дерево появится отдельно от фона." : "Нажми на крону дерева, куст или камень. Земля останется на месте."}</p>
            <button type="button" className={styles.textButton} disabled={!status.edited} onClick={() => controller.current?.resetEdits()}><RotateCcw size={14} /> Отменить правки ({status.edited})</button>
          </div>
          <div className={styles.section}>
            <span className={styles.label}>02 <span>ОТКРОЙ НОВУЮ ТЕРРИТОРИЮ</span></span>
            <button type="button" className={styles.expandButton} disabled={!ready || status.width >= MAX_WIDTH} onClick={() => controller.current?.expand()}><span>{status.width >= MAX_WIDTH ? "Тестовый мир открыт" : "Продолжить лес вправо"}</span><ArrowRight size={18} /></button>
            <p className={styles.small}>+800 единиц за шаг. Существующий участок сохраняет расположение и рисунок.</p>
          </div>
          <div className={styles.section}>
            <span className={styles.label}>03 <span>РАССМОТРИ СЛОИ</span></span>
            <div className={styles.toggles}>
              <button type="button" disabled={!ready} aria-pressed={trees} onClick={() => { setTrees(!trees); controller.current?.setLayer("trees", !trees); if (trees) changeMode("pan"); }}><Trees size={17} /> Растительность <span className={styles.switch} /></button>
              <button type="button" disabled={!ready} aria-pressed={grid} onClick={() => { setGrid(!grid); controller.current?.setLayer("grid", !grid); }}><Grid2X2 size={17} /> Границы участков <span className={styles.switch} /></button>
            </div>
          </div>
          <div className={styles.actions}>
            <button type="button" disabled={!ready} onClick={() => controller.current?.regenerate()}><Shuffle size={16} /> Другой лес</button>
            <button type="button" disabled={!ready} onClick={() => controller.current?.exportPng()}><Download size={16} /> Скачать PNG</button>
          </div>
          <p className={styles.note}>Это отдельный графический тест. Изменения живут до перезагрузки. «Другой лес» сбрасывает посадки и удаления.</p>
        </aside>

        <section className={styles.mapPanel} aria-label="Тестовая карта леса">
          <div className={styles.mapHeading}><span><i /> Лесная долина</span><span>{status.width} × 1600</span></div>
          <div className={styles.viewport}>
            <canvas ref={canvas} tabIndex={0} className={styles.canvas} aria-label="Лесная карта. Стрелки — перемещение, плюс и минус — масштаб, ноль — вся карта. В режиме посадки или удаления Enter применяет инструмент в центре." aria-describedby="forest-keyboard-help">Для карты требуется Canvas 2D.</canvas>
            {mode !== "pan" && <span className={styles.crosshair} aria-hidden>+</span>}
            {!ready && <div className={styles.loading} role={error ? "alert" : "status"}>{error ?? "Выращиваем лес…"}</div>}
            <div className={styles.mapTools} aria-label="Управление масштабом">
              <button type="button" disabled={!ready} onClick={() => controller.current?.zoom(1.25)} aria-label="Приблизить"><Plus size={19} /></button>
              <button type="button" disabled={!ready} onClick={() => controller.current?.zoom(.8)} aria-label="Отдалить"><Minus size={19} /></button>
              <span>{Math.round(status.zoom * 100)}%</span>
              <button type="button" disabled={!ready} onClick={() => controller.current?.fit()} aria-label="Показать весь лес"><Expand size={18} /></button>
            </div>
          </div>
          <div className={styles.mapFooter}><span>SEED {status.seed} <span className={styles.dim}>·</span> {status.objects} объектов</span><span className={styles.footerDetail}>РИСУНОК ИЗ КОДА</span></div>
          <p className={styles.status} role="status">{status.message}</p>
          <p id="forest-keyboard-help" className={styles.keyboard}>Клавиатура: стрелки · + / − · 0 — вся карта · Enter — применить инструмент в центре</p>
        </section>
      </div>
    </main>
  );
}
