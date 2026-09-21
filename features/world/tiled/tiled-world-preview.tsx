"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Compass, Footprints, Grid2X2, Hammer, Home, LoaderCircle, Moon, RotateCcw, Sun, ZoomIn, ZoomOut } from "lucide-react";
import sceneData from "./forest.generated.json";
import type { FixedWorldScene } from "./types";
import type { FixedWorldRenderOptions } from "./renderer";
import { initialPreviewLevels, setPreviewLevel } from "./preview-state";
import styles from "./tiled-world-preview.module.css";

const scene = sceneData as FixedWorldScene;
type Renderer = Awaited<ReturnType<typeof import("./renderer")["createFixedWorldRenderer"]>>;

export function TiledWorldPreview() {
  const worldCanvas = useRef<HTMLCanvasElement>(null);
  const circleCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const [levels, setLevels] = useState(() => initialPreviewLevels(scene));
  const [night, setNight] = useState(false);
  const [debug, setDebug] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(scene.sites[0]?.id ?? null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [retryKey, setRetryKey] = useState(0);
  const latestOptions = useRef<FixedWorldRenderOptions>({ levels, night, debug, selectedSiteId, reducedMotion });

  useEffect(() => {
    latestOptions.current = { levels, night, debug, selectedSiteId, reducedMotion };
    renderer.current?.update(latestOptions.current);
  }, [levels, night, debug, selectedSiteId, reducedMotion]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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

  function chooseSite(id: string) {
    setSelectedSiteId(id);
    renderer.current?.focus(id);
  }

  function reset() {
    setLevels(initialPreviewLevels(scene)); setNight(false); setDebug(false);
    setSelectedSiteId(scene.sites[0]?.id ?? null);
    renderer.current?.reset();
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/" prefetch={false} aria-label="Вернуться в приложение"><ArrowLeft aria-hidden size={20} /></Link>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>Мир Мохлика · исследование</p>
          <h1>Лес меняется по частям</h1>
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
            <canvas ref={worldCanvas} className={styles.worldCanvas} tabIndex={0} aria-label="Карта леса. Перемещение стрелками, увеличение клавишами плюс и минус. Места также доступны кнопками под картой.">
              Для карты нужен браузер с поддержкой Canvas. Уровни построек можно выбрать ниже.
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
            {ready && status.loading && <div className={styles.loadingBadge} role="status"><LoaderCircle className={styles.spinner} aria-hidden size={16} /> Загружаем улучшение</div>}
          </div>
          <div className={styles.mapFooter}>
            <div className={styles.places} aria-label="Места на карте">
              {scene.sites.map(site => (
                <button type="button" key={site.id} disabled={!ready} aria-pressed={selectedSiteId === site.id} onClick={() => chooseSite(site.id)}>
                  {site.id === "home" ? <Home aria-hidden size={17} /> : <Hammer aria-hidden size={17} />}{site.label}
                </button>
              ))}
            </div>
            <div className={styles.viewOptions}>
              <button type="button" aria-pressed={night} onClick={() => setNight(value => !value)}>{night ? <Moon aria-hidden size={17} /> : <Sun aria-hidden size={17} />}{night ? "Ночь" : "День"}</button>
              <button type="button" aria-pressed={debug} onClick={() => setDebug(value => !value)}><Grid2X2 aria-hidden size={17} />Разметка</button>
            </div>
          </div>
        </section>

        <aside className={styles.sidebar} aria-label="Проверка улучшений">
          <section className={styles.homePreview}>
            <div className={styles.circleFrame}><canvas ref={circleCanvas} className={styles.circleCanvas} aria-label="Дом крупно: та же сцена и те же улучшения, что на большой карте." /></div>
            <div><h2>Один мир, два вида</h2><p>В кружке — тот же участок карты. Дом и свет меняются одновременно.</p></div>
          </section>

          <div className={styles.siteList}>
            {scene.sites.map(site => (
              <section className={styles.siteCard} key={site.id} data-selected={selectedSiteId === site.id}>
                <div className={styles.siteTitle}>
                  {site.id === "home" ? <Home aria-hidden size={19} /> : <Hammer aria-hidden size={19} />}
                  <h2>{site.label}</h2>
                  <button type="button" disabled={!ready} onClick={() => chooseSite(site.id)} aria-label={`Показать: ${site.label}`}><Compass aria-hidden size={18} /></button>
                </div>
                <label className={styles.levelLabel} htmlFor={`level-${site.id}`}>Внешний вид</label>
                <select id={`level-${site.id}`} aria-label={site.id === "home" ? "Уровень дома" : "Уровень мастерской"} value={levels[site.id]} onChange={event => setLevels(current => setPreviewLevel(scene, current, site.id, Number(event.target.value)))}>
                  {site.states.map(state => <option value={state.level} key={state.level}>{state.label}</option>)}
                </select>
                {site.id === "home" && <>
                  <button className={styles.walkButton} type="button" disabled={!ready} onClick={() => { chooseSite("home"); renderer.current?.stroll(); }}><Footprints aria-hidden size={16} />Прогуляться возле дома</button>
                  <button className={styles.walkButton} type="button" disabled={!ready} onClick={() => renderer.current?.walkTo("home")}><Home aria-hidden size={16} />Вернуться домой</button>
                </>}
              </section>
            ))}
          </div>

          {ready && status.error && <div className={styles.error} role="alert"><span>{status.error}</span><button type="button" onClick={() => renderer.current?.retry()}>Повторить загрузку</button></div>}

          <div className={styles.previewNote}>
            <p>Это проверка устройства карты. Изменения действуют только на этой странице и не затрагивают игровой прогресс.</p>
            <button type="button" onClick={reset}><RotateCcw aria-hidden size={16} />Начать заново</button>
          </div>
        </aside>
      </div>

      <details className={styles.details}>
        <summary>Как устроен этот пример</summary>
        <p>Положение участков, входы и маршрут приходят из карты Tiled. У каждого места свой набор состояний. Смена уровня заменяет только его изображение; обе камеры используют одну сцену.</p>
        <p>Разметка показывает границы участков, точки входа, препятствия и путь Мохлика. Для этого примера здания стоят на фиксированных местах.</p>
        <a href="https://github.com/NolReaction/zhiv-app/blob/feature/mochlik-tiled-world/docs/game/tiled-editor.md" target="_blank" rel="noreferrer">Как открыть карту в Tiled и изменить её</a>
      </details>
    </main>
  );
}
