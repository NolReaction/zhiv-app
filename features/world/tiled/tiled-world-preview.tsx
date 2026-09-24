"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Compass, Grid2X2, LoaderCircle, Play, RotateCcw, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import sceneData from "./forest.generated.json";
import type { FixedWorldScene } from "./types";
import type { FixedWorldRenderOptions } from "./renderer";
import { createPreviewRoute, type PreviewRouteStatus } from "./preview-route";
import { initialPreviewLevels, previewSiteVisual, setPreviewLevel } from "./preview-state";
import styles from "./tiled-world-preview.module.css";

const scene = sceneData as FixedWorldScene;
const paths = createPreviewRoute(scene).choices;
type Renderer = Awaited<ReturnType<typeof import("./renderer")["createFixedWorldRenderer"]>>;

export function TiledWorldPreview() {
  const worldCanvas = useRef<HTMLCanvasElement>(null);
  const circleCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const [debug, setDebug] = useState(false);
  const [levels, setLevels] = useState(() => initialPreviewLevels(scene));
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(scene.sites[0]?.id ?? null);
  const selectedSite = scene.sites.find(site => site.id === selectedSiteId) ?? scene.sites[0];
  const activeSiteId = selectedSite?.id ?? null;
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [retryKey, setRetryKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [routeStatus, setRouteStatus] = useState<PreviewRouteStatus>({ pathId: null, moving: false, error: null });
  const latestOptions = useRef<FixedWorldRenderOptions>({ levels, night: false, debug, selectedSiteId: activeSiteId, reducedMotion: true });

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update(); preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    latestOptions.current = { levels, night: false, debug, selectedSiteId: activeSiteId, reducedMotion };
    renderer.current?.update(latestOptions.current);
  }, [levels, activeSiteId, debug, reducedMotion]);

  useEffect(() => {
    const world = worldCanvas.current, circle = circleCanvas.current;
    if (!world || !circle) return;
    const controller = new AbortController();
    setReady(false);
    setStatus({ loading: true, error: null });
    void import("./renderer").then(async ({ createFixedWorldRenderer }) => {
      if (controller.signal.aborted) return;
      const handle = await createFixedWorldRenderer(world, circle, scene, latestOptions.current, {
        onSelect: id => { if (!controller.signal.aborted) setSelectedSiteId(id); },
        onStatus: next => { if (!controller.signal.aborted) setStatus(next); },
        onRouteChange: next => { if (!controller.signal.aborted) setRouteStatus(next); },
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
    setLevels(initialPreviewLevels(scene));
    setSelectedSiteId(scene.sites[0]?.id ?? null);
    renderer.current?.reset();
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/" prefetch={false} aria-label="Вернуться в приложение"><ArrowLeft aria-hidden size={20} /></Link>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>Мир Мохлика · Tiled</p>
          <h1>Проверка лесной карты</h1>
        </div>
        <span className={styles.previewLabel}>Предпросмотр карты</span>
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
            <span className={styles.mapHint}>В кружке — область focus из Tiled</span>
            <div className={styles.viewOptions}>
              <button type="button" aria-pressed={debug} onClick={() => setDebug(value => !value)}><Grid2X2 aria-hidden size={17} />Разметка</button>
            </div>
          </div>
        </section>

        <aside className={styles.sidebar} aria-label="Центральная поляна">
          <section className={styles.homePreview}>
            <div className={styles.circleFrame}><canvas ref={circleCanvas} className={styles.circleCanvas} aria-label="Центральная поляна крупно: участок той же лесной карты." /></div>
            <div><h2>Один мир, два вида</h2><p>Кружок показывает область focus. Положение и размер Мохлика заданы в Tiled и совпадают с основной картой.</p></div>
          </section>

          {ready && status.error && <div className={styles.error} role="alert"><span>{status.error}</span><button type="button" onClick={() => renderer.current?.retry()}>Повторить загрузку</button></div>}

          <section className={styles.routePanel} aria-labelledby="building-preview-title">
            <h2 id="building-preview-title">Постройки и уровни</h2>
            {selectedSite ? <>
              <div className={styles.buildingFields}>
                <div>
                  <label htmlFor="preview-building">Постройка</label>
                  <select id="preview-building" value={selectedSite.id} onChange={event => setSelectedSiteId(event.target.value)}>
                    {scene.sites.map(site => <option key={site.id} value={site.id}>{site.label} · {site.id}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="preview-building-level">Вариант постройки</label>
                  <select id="preview-building-level" value={previewSiteVisual(selectedSite, levels).level}
                    onChange={event => setLevels(current => setPreviewLevel(scene, current, selectedSite.id, Number(event.target.value)))}>
                    {selectedSite.states.map(state => <option key={state.level} value={state.level}>Уровень {state.level} · {state.label}</option>)}
                  </select>
                </div>
              </div>
              <div className={styles.routeTools}>
                <button type="button" disabled={!ready} onClick={() => renderer.current?.focus(selectedSite.id)}><Compass aria-hidden size={16} />{selectedSite.id === "home" ? "Показать поляну" : "Показать на карте"}</button>
              </div>
              <p>Постройку можно выбрать нажатием на карте. Варианты меняются только в этом предпросмотре; сброс возвращает начальные уровни из Tiled.</p>
            </> : <p>Постройки пока не размещены. Добавьте здание и его разметку в Tiled, затем экспортируйте карту.</p>}
          </section>

          <section className={styles.routePanel} aria-labelledby="route-preview-title">
            <h2 id="route-preview-title">Проверка маршрута</h2>
            {paths.length ? <>
              <label htmlFor="preview-path">Линия из Tiled</label>
              <select id="preview-path" disabled={!ready} value={routeStatus.pathId ?? ""} onChange={event => renderer.current?.selectPath(event.target.value || null)}>
                <option value="">Мохлик на стартовой точке</option>
                {paths.map(path => <option key={path.id} value={path.id}>{path.id}{path.error ? " · требует исправления" : ""}</option>)}
              </select>
              <p>Выбор переносит Мохлика в начало линии для проверки. Движение начинается по кнопке.</p>
              <div className={styles.routeTools}>
                <button type="button" disabled={!ready || !routeStatus.pathId || !!routeStatus.error || routeStatus.moving} onClick={() => renderer.current?.startPath()}><Play aria-hidden size={16} />Пройти</button>
                <button type="button" disabled={!ready || !routeStatus.pathId || !!routeStatus.error} onClick={() => renderer.current?.reversePath()}><Undo2 aria-hidden size={16} />Развернуть</button>
                <button type="button" disabled={!ready || !routeStatus.pathId} onClick={() => renderer.current?.resetPath()}><RotateCcw aria-hidden size={16} />На старт</button>
              </div>
              <p className={styles.routeStatus} role="status">{routeStatus.error ?? (routeStatus.moving ? "Мохлик идёт по выбранной линии." : routeStatus.pathId ? "Маршрут выбран. Можно проверить движение." : "Мохлик стоит в точке spawn из Tiled.")}</p>
              {reducedMotion && <p>Включено уменьшение движения: кнопки сразу показывают конечную точку пути.</p>}
            </> : <p>Маршрутов пока нет. В Tiled нарисуйте ломаную, задайте ей имя и строковое свойство role = path, сохраните карту при запущенном npm run world:watch.</p>}
          </section>

          <div className={styles.previewNote}>
            <p>Это проверка разметки Tiled. Движение здесь не запускает игровые путешествия и не меняет прогресс.</p>
            <button type="button" onClick={reset}><RotateCcw aria-hidden size={16} />Сбросить вид</button>
          </div>
        </aside>
      </div>

      <details className={styles.details}>
        <summary>Как устроен этот пример</summary>
        <p>Карта Tiled задаёт фон, квадратную область focus, точку spawn и размер Мохлика. Запустите npm run world:watch и сохраняйте карту в Tiled, чтобы обновлять оба вида и основную карту.</p>
        <p>«Разметка» показывает границы кружка, маршруты и коллизии построек. Каждый маршрут проверяется отдельно; Мохлик проходит только его точки.</p>
        <a href="https://github.com/NolReaction/zhiv-app/blob/work/0.6.7/docs/game/tiled-editor.md" target="_blank" rel="noreferrer">Как открыть карту в Tiled и изменить её</a>
        <p><a href="https://github.com/NolReaction/zhiv-app/blob/work/0.6.7/docs/game/building-workbench.md" target="_blank" rel="noreferrer">Как добавить домик и рисунки улучшений</a></p>
      </details>
    </main>
  );
}
