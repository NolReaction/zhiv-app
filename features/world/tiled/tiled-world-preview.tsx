"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Compass, Grid2X2, LoaderCircle, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import sceneData from "./forest.generated.json";
import type { FixedWorldScene } from "./types";
import type { FixedWorldRenderOptions } from "./renderer";
import styles from "./tiled-world-preview.module.css";

const scene = sceneData as FixedWorldScene;
type Renderer = Awaited<ReturnType<typeof import("./renderer")["createFixedWorldRenderer"]>>;

export function TiledWorldPreview() {
  const worldCanvas = useRef<HTMLCanvasElement>(null);
  const circleCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const [debug, setDebug] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [retryKey, setRetryKey] = useState(0);
  const latestOptions = useRef<FixedWorldRenderOptions>({ levels: {}, night: false, debug, selectedSiteId: null, reducedMotion: true });

  useEffect(() => {
    latestOptions.current = { levels: {}, night: false, debug, selectedSiteId: null, reducedMotion: true };
    renderer.current?.update(latestOptions.current);
  }, [debug]);

  useEffect(() => {
    const world = worldCanvas.current, circle = circleCanvas.current;
    if (!world || !circle) return;
    const controller = new AbortController();
    setReady(false);
    setStatus({ loading: true, error: null });
    void import("./renderer").then(async ({ createFixedWorldRenderer }) => {
      if (controller.signal.aborted) return;
      const handle = await createFixedWorldRenderer(world, circle, scene, latestOptions.current, {
        onSelect: () => {},
        onStatus: next => { if (!controller.signal.aborted) setStatus(next); },
      }, controller.signal);
      if (controller.signal.aborted) { handle.dispose(); return; }
      renderer.current = handle;
      handle.update(latestOptions.current);
      setReady(true);
    }).catch(error => {
      if (!controller.signal.aborted) setStatus({ loading: false, error: error instanceof Error ? error.message : "Не удалось открыть карту." });
    });
    return () => {
      controller.abort();
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [retryKey]);

  function reset() {
    setDebug(false);
    renderer.current?.reset();
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/" prefetch={false} aria-label="Вернуться в приложение"><ArrowLeft aria-hidden size={20} /></Link>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>Мир Мохлика · исследование</p>
          <h1>Новая лесная карта</h1>
        </div>
        <span className={styles.previewLabel}>Тестовый мир</span>
      </header>

      <div className={styles.layout}>
        <section className={styles.mapPanel} aria-label="Большой мир">
          <div className={styles.mapHeading}>
            <div><span className={styles.dot} /> Лесная долина</div>
            <span className={styles.mapHint}>Перетаскивай и приближай</span>
          </div>
          <div className={styles.mapViewport}>
            <canvas ref={worldCanvas} className={styles.worldCanvas} tabIndex={0} aria-label="Карта леса. Перемещение стрелками, увеличение клавишами плюс и минус.">
              Для карты нужен браузер с поддержкой Canvas.
            </canvas>
            {!ready && (
              <div className={styles.initialLoading} role="status">
                {status.error ? <><strong>Карта пока не загрузилась</strong><span>{status.error}</span><button type="button" onClick={() => setRetryKey(key => key + 1)}>Повторить</button></>
                  : <><LoaderCircle className={styles.spinner} size={28} aria-hidden /><span>Собираем лес…</span></>}
              </div>
            )}
            <div className={styles.mapTools} aria-label="Масштаб карты">
              <button type="button" disabled={!ready} onClick={() => renderer.current?.zoom(1.3)} aria-label="Приблизить карту"><ZoomIn aria-hidden size={20} /></button>
              <button type="button" disabled={!ready} onClick={() => renderer.current?.zoom(1 / 1.3)} aria-label="Отдалить карту"><ZoomOut aria-hidden size={20} /></button>
              <button type="button" disabled={!ready} onClick={() => renderer.current?.focus("world")} aria-label="Показать всю карту"><Compass aria-hidden size={20} /></button>
            </div>
            {ready && status.loading && <div className={styles.loadingBadge} role="status"><LoaderCircle className={styles.spinner} aria-hidden size={16} /> Загружаем карту</div>}
          </div>
          <div className={styles.mapFooter}>
            <span className={styles.mapHint}>Центральная поляна показана в кружке</span>
            <div className={styles.viewOptions}>
              <button type="button" aria-pressed={debug} onClick={() => setDebug(value => !value)}><Grid2X2 aria-hidden size={17} />Разметка</button>
            </div>
          </div>
        </section>

        <aside className={styles.sidebar} aria-label="Центральная поляна">
          <section className={styles.homePreview}>
            <div className={styles.circleFrame}><canvas ref={circleCanvas} className={styles.circleCanvas} aria-label="Центральная поляна крупно: участок той же лесной карты." /></div>
            <div><h2>Один мир, два вида</h2><p>В кружке — центральная поляна той же карты. Оба вида используют одно изображение.</p></div>
          </section>

          {ready && status.error && <div className={styles.error} role="alert"><span>{status.error}</span><button type="button" onClick={() => renderer.current?.retry()}>Повторить загрузку</button></div>}

          <div className={styles.previewNote}>
            <p>Здесь можно рассмотреть новую карту и её центральную поляну. Просмотр не меняет игровой прогресс.</p>
            <button type="button" onClick={reset}><RotateCcw aria-hidden size={16} />Сбросить вид</button>
          </div>
        </aside>
      </div>

      <details className={styles.details}>
        <summary>Как устроен этот пример</summary>
        <p>Карта Tiled задаёт общий рисунок леса и область центральной поляны. Обе камеры используют одну сцену.</p>
        <p>Разметка показывает границы участка, который виден в кружке. Постройки и маршруты будут размечены на следующем этапе.</p>
        <a href="https://github.com/NolReaction/zhiv-app/blob/feature/mochlik-tiled-world/docs/game/tiled-editor.md" target="_blank" rel="noreferrer">Как открыть карту в Tiled и изменить её</a>
      </details>
    </main>
  );
}
