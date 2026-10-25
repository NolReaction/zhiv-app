"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Moon, Pause, Play, Sun } from "lucide-react";
import { drawTradeShip, type TradeShipFrame } from "@/features/world/objects/trade-ship/trade-ship-painter";
import { TRADE_SHIP_ART } from "@/features/world/objects/trade-ship/trade-ship-art";
import runtimeArt from "@/features/world/runtime-art.json";
import { advanceTradeShipPreviewClock, tradeShipPreviewLayout, TRADE_SHIP_MAP_CROP, type TradeShipPreviewMode } from "./trade-ship-preview-model";
import styles from "./trade-ship-preview.module.css";

const visibleSnapshot = () => !document.hidden;
const hiddenServerSnapshot = () => false;
const reducedServerSnapshot = () => true;
const reducedSnapshot = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};
const subscribeMotion = (notify: () => void) => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  preference.addEventListener("change", notify);
  return () => preference.removeEventListener("change", notify);
};

function paintPreviewWater(ctx: CanvasRenderingContext2D, width: number, height: number, time: number, night: boolean) {
  const water = ctx.createLinearGradient(0, 0, 0, height);
  water.addColorStop(0, night ? "#112b37" : "#b9d9c7");
  water.addColorStop(1, night ? "#183d4b" : "#5caaa9");
  ctx.fillStyle = water; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = night ? "rgba(122, 179, 183, .17)" : "rgba(231, 249, 226, .42)"; ctx.lineWidth = 1;
  for (let row = 0; row < 7; row++) {
    const y = height * .64 + row * height * .045;
    const drift = Math.sin(time * .35 + row) * 5;
    for (let column = 0; column < 5; column++) {
      const x = width * (.03 + column * .23) + drift;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + width * .06, y - 3, x + width * .12, y); ctx.stroke();
    }
  }
}

export function TradeShipPreview() {
  const [mode, setMode] = useState<TradeShipPreviewMode>("detail");
  const [night, setNight] = useState(false), [playing, setPlaying] = useState(true);
  const [gate, setGate] = useState(0), [ramp, setRamp] = useState(0), [cargo, setCargo] = useState(0);
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null);
  const [mapError, setMapError] = useState(false), [mapRetry, setMapRetry] = useState(0);
  const [exportNotice, setExportNotice] = useState("");
  const [viewport, setViewport] = useState({ width: 800, height: 500, ratio: 1 });
  const visible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, hiddenServerSnapshot);
  const reducedMotion = useSyncExternalStore(subscribeMotion, reducedSnapshot, reducedServerSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null);
  const elapsed = useRef(0), lifetime = useRef(0);
  const moving = playing && visible && !reducedMotion;

  useEffect(() => {
    const owner = ++lifetime.current;
    return () => { lifetime.current = owner + 1; };
  }, []);

  useEffect(() => {
    const element = stage.current; if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const next = { width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)),
        ratio: Math.max(1, Math.min(2, window.devicePixelRatio || 1)) };
      setViewport(current => current.width === next.width && current.height === next.height && current.ratio === next.ratio ? current : next);
    };
    const initial = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure); observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(initial); observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => {
    if (mode !== "map" || mapImage) return;
    let active = true;
    const image = new Image();
    image.onload = () => { if (active) { setMapImage(image); setMapError(false); } };
    image.onerror = () => { if (active) setMapError(true); };
    image.src = runtimeArt.map;
    return () => { active = false; image.onload = null; image.onerror = null; };
  }, [mode, mapImage, mapRetry]);

  useEffect(() => {
    const surface = canvas.current, context = surface?.getContext("2d");
    if (!surface || !context) return;
    surface.width = Math.round(viewport.width * viewport.ratio);
    surface.height = Math.round(viewport.height * viewport.ratio);
    const paint = () => {
      context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
      const { width, height } = viewport;
      paintPreviewWater(context, width, height, elapsed.current, night);
      const layout = tradeShipPreviewLayout(width, height, mode);
      context.save();
      if (mode === "map") {
        const crop = TRADE_SHIP_MAP_CROP;
        if (mapImage) {
          context.drawImage(mapImage, crop.x / crop.worldSize * mapImage.naturalWidth, crop.y / crop.worldSize * mapImage.naturalHeight,
            crop.width / crop.worldSize * mapImage.naturalWidth, crop.height / crop.worldSize * mapImage.naturalHeight,
            layout.x, layout.y, crop.width * layout.scale, crop.height * layout.scale);
          if (night) { context.fillStyle = "rgba(7, 23, 40, .63)"; context.fillRect(layout.x, layout.y, crop.width * layout.scale, crop.height * layout.scale); }
        }
        context.translate(layout.x - crop.x * layout.scale, layout.y - crop.y * layout.scale);
        context.scale(layout.scale, layout.scale);
      }
      drawTradeShip(context, { ...layout.ship, time: elapsed.current, night: Number(night), gate: gate / 100, ramp: ramp / 100, cargo, still: !moving });
      context.restore();
    };
    paint();
    if (!moving) return;
    let scheduled = 0, previous: number | null = null;
    const tick = (now: number) => {
      elapsed.current = advanceTradeShipPreviewClock(elapsed.current, previous === null ? 0 : (now - previous) / 1000,
        { playing, visible: !document.hidden, reducedMotion });
      previous = now; paint(); scheduled = requestAnimationFrame(tick);
    };
    scheduled = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(scheduled);
  }, [viewport, mode, night, gate, ramp, cargo, moving, playing, reducedMotion, mapImage]);

  function downloadPng() {
    const owner = lifetime.current;
    const surface = document.createElement("canvas");
    surface.width = TRADE_SHIP_ART.width * 2; surface.height = TRADE_SHIP_ART.height * 2;
    const context = surface.getContext("2d");
    if (!context) { setExportNotice("Не удалось подготовить PNG."); return; }
    const frame: TradeShipFrame = { x: 0, y: 0, width: surface.width, time: elapsed.current,
      night: Number(night), gate: gate / 100, ramp: ramp / 100, cargo, still: true };
    try {
      drawTradeShip(context, frame);
      surface.toBlob(blob => {
        if (lifetime.current !== owner) return;
        if (!blob) { setExportNotice("Не удалось подготовить PNG."); return; }
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = "trade-ship.png"; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setExportNotice("PNG с прозрачным фоном готов.");
      }, "image/png");
    } catch { setExportNotice("Не удалось подготовить PNG."); }
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false} className={styles.back} aria-label="Вернуться в приложение"><ArrowLeft size={20} aria-hidden /></Link>
      <div><p className={styles.eyebrow}>Мастерская мира · DEV</p><h1>Пароход из кода</h1></div>
      <span className={styles.badge}>Первый рисунок</span>
    </header>
    <div className={styles.layout}>
      <section className={styles.preview} aria-label="Предпросмотр парохода">
        <div className={styles.toolbar}>
          <div className={styles.switcher} aria-label="Вид парохода">
            <button type="button" aria-pressed={mode === "detail"} onClick={() => setMode("detail")}>Крупно</button>
            <button type="button" aria-pressed={mode === "map"} onClick={() => setMode("map")}>На карте</button>
          </div>
          <div className={styles.viewTools}>
            <button type="button" aria-pressed={night} aria-label={night ? "Показать день" : "Показать ночь"} onClick={() => setNight(value => !value)}>
              {night ? <Moon size={17} aria-hidden /> : <Sun size={17} aria-hidden />}{night ? "Ночь" : "День"}
            </button>
            <button type="button" disabled={reducedMotion} aria-pressed={moving} onClick={() => setPlaying(value => !value)}>
              {moving ? <Pause size={17} aria-hidden /> : <Play size={17} aria-hidden />}{moving ? "Пауза" : "Воспроизвести"}
            </button>
          </div>
        </div>
        <div className={styles.stage} ref={stage}>
          <canvas ref={canvas} className={styles.canvas} width={800} height={500} role="img"
            aria-label={`Торговый пароход: ${night ? "ночь" : "день"}, калитка ${gate}%, трап ${ramp}%, грузовых ящиков ${cargo}`}>
            Для просмотра парохода нужен браузер с поддержкой Canvas 2D.
          </canvas>
          {mode === "map" && !mapImage && <div className={styles.mapNotice} role={mapError ? "alert" : "status"}>
            <span>{mapError ? "Фон карты не загрузился." : "Загружаем южную бухту…"}</span>
            {mapError && <button type="button" onClick={() => { setMapError(false); setMapRetry(value => value + 1); }}>Повторить</button>}
          </div>}
        </div>
        <footer className={styles.previewFooter}><span>{mode === "map" ? "Примерка у южного берега" : "Корпус, каюта и детали нарисованы кодом"}</span>
          <span>{reducedMotion ? "Меньше движения" : moving ? "Движение включено" : "Рисунок на паузе"}</span></footer>
      </section>
      <aside className={styles.controls} aria-label="Настройки парохода">
        <h2>Детали</h2>
        <label className={styles.field} htmlFor="trade-ship-gate"><span>Калитка<output>{gate === 0 ? "Закрыта" : gate === 100 ? "Открыта" : `${gate}%`}</output></span>
          <input id="trade-ship-gate" type="range" min={0} max={100} step={1} value={gate} onChange={event => { const value = Number(event.target.value); setGate(value); if (value < 100) setRamp(0); }} /></label>
        <label className={styles.field} htmlFor="trade-ship-ramp"><span>Трап<output>{ramp === 0 ? "Убран" : ramp === 100 ? "Опущен" : `${ramp}%`}</output></span>
          <input id="trade-ship-ramp" type="range" min={0} max={100} step={1} value={ramp} onChange={event => { const value = Number(event.target.value); setRamp(value); if (value > 0) setGate(100); }} /></label>
        <label className={styles.field} htmlFor="trade-ship-cargo"><span>Грузовые ящики</span><select id="trade-ship-cargo" value={cargo} onChange={event => setCargo(Number(event.target.value))}>
          {[0, 1, 2, 3].map(value => <option key={value} value={value}>{value === 0 ? "Пустая палуба" : `${value} ${value === 1 ? "ящик" : "ящика"}`}</option>)}
        </select></label>
        <button type="button" className={styles.download} onClick={downloadPng}><Download size={18} aria-hidden />Скачать PNG</button>
        <p className={styles.note}>Калитка поворачивается на петлях, трап выдвигается отдельно. Положение на карте пока примерочное.</p>
        {reducedMotion && <p className={styles.note}>В системе уменьшено движение. Ползунки доступны, пар и качание остановлены.</p>}
        <p className={styles.exportNotice} role="status">{exportNotice}</p>
      </aside>
    </div>
  </main>;
}
