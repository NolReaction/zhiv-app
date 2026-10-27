"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Moon, Pause, Play, Sun } from "lucide-react";
import { loadHabitatImage } from "@/features/mochlik/assets";
import { drawTradeShipSprite, TRADE_SHIP_SPRITE, type TradeShipSpriteFrame } from "@/features/world/objects/trade-ship/trade-ship-sprite";
import { drawTradeShipGangway, drawTradeShipGangwayDeck } from "@/features/world/objects/trade-ship/trade-ship-gangway";
import { drawTradeShipLighting } from "@/features/world/objects/trade-ship/trade-ship-lighting";
import { advanceTradeShipMotion, createTradeShipMotion } from "@/features/world/objects/trade-ship/trade-ship-motion";
import runtimeArt from "@/features/world/runtime-art.json";
import { advanceTradeShipPreviewClock, commandTradeShipPreview, sampleTradeShipPreviewLeg, tradeShipPreviewCrop, tradeShipPreviewLegProgress,
  tradeShipPreviewLayout, tradeShipPreviewMapSource, type TradeShipPreviewLeg, type TradeShipPreviewMode } from "./trade-ship-preview-model";
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

function paintPreviewWater(ctx: CanvasRenderingContext2D, width: number, height: number, time: number, night: boolean, map = false) {
  const water = ctx.createLinearGradient(0, 0, 0, height);
  water.addColorStop(0, night ? "#112b37" : map ? "#148bac" : "#b9d9c7");
  water.addColorStop(1, night ? "#183d4b" : map ? "#087797" : "#5caaa9");
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
  const [voyage, setVoyage] = useState(() => createTradeShipMotion());
  const motion = useRef(voyage);
  const [leg, setLeg] = useState<TradeShipPreviewLeg>("arriving");
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<TradeShipPreviewMode>("detail");
  const [night, setNight] = useState(false), [playing, setPlaying] = useState(true);
  const [shipImage, setShipImage] = useState<HTMLImageElement | null>(null);
  const [shipError, setShipError] = useState(false), [shipRetry, setShipRetry] = useState(0);
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null);
  const [mapError, setMapError] = useState(false), [mapRetry, setMapRetry] = useState(0);
  const [exportNotice, setExportNotice] = useState("");
  const [viewport, setViewport] = useState({ width: 800, height: 500, ratio: 1 });
  const visible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, hiddenServerSnapshot);
  const reducedMotion = useSyncExternalStore(subscribeMotion, reducedSnapshot, reducedServerSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null);
  const elapsed = useRef(0), lifetime = useRef(0);
  const moving = playing && visible && !reducedMotion && Boolean(shipImage);
  const maneuvering = voyage.phase !== "docked" && voyage.phase !== "departed";
  const voyageProgress = Math.round(tradeShipPreviewLegProgress(voyage, leg) * 100);
  const voyageStatus = { arriving: "Подходит к берегу", deploying: "Выдвигает мостик", docked: "У берега",
    retracting: "Убирает мостик", departing: "Отходит кормой", departed: "Ушёл в море" }[voyage.phase];

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
    if (shipImage) return;
    let active = true;
    void loadHabitatImage(TRADE_SHIP_SPRITE.src).then(image => {
      if (!active) return;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) { setShipImage(image); setShipError(false); }
      else setShipError(true);
    }).catch(() => { if (active) setShipError(true); });
    return () => { active = false; };
  }, [shipImage, shipRetry]);

  useEffect(() => {
    if (mode === "detail" || mapImage) return;
    let active = true;
    void loadHabitatImage(runtimeArt.map, "low").then(image => {
      if (active) { setMapImage(image); setMapError(false); }
    }).catch(() => { if (active) setMapError(true); });
    return () => { active = false; };
  }, [mode, mapImage, mapRetry]);

  useEffect(() => {
    const surface = canvas.current, context = surface?.getContext("2d");
    if (!surface || !context) return;
    surface.width = Math.round(viewport.width * viewport.ratio);
    surface.height = Math.round(viewport.height * viewport.ratio);
    const paint = () => {
      context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
      const { width, height } = viewport;
      paintPreviewWater(context, width, height, elapsed.current, night, mode !== "detail");
      const layout = tradeShipPreviewLayout(width, height, mode);
      context.save();
      if (mode !== "detail") {
        const crop = tradeShipPreviewCrop(mode), source = tradeShipPreviewMapSource(mode);
        if (mapImage) {
          const mapX = layout.x + (source.x - crop.x) * layout.scale;
          const mapY = layout.y + (source.y - crop.y) * layout.scale;
          context.drawImage(mapImage, source.x / crop.worldSize * mapImage.naturalWidth, source.y / crop.worldSize * mapImage.naturalHeight,
            source.width / crop.worldSize * mapImage.naturalWidth, source.height / crop.worldSize * mapImage.naturalHeight,
            mapX, mapY, source.width * layout.scale, source.height * layout.scale);
          if (night) { context.fillStyle = "rgba(7, 23, 40, .63)"; context.fillRect(mapX, mapY, source.width * layout.scale, source.height * layout.scale); }
          if (crop.y + crop.height > crop.worldSize) {
            const edge = layout.y + (crop.worldSize - crop.y) * layout.scale, blend = 32 * layout.scale;
            const fade = context.createLinearGradient(0, edge - blend, 0, edge);
            fade.addColorStop(0, night ? "rgba(19, 49, 62, 0)" : "rgba(15, 129, 161, 0)");
            fade.addColorStop(1, night ? "#13313e" : "#0f81a1");
            context.fillStyle = fade; context.fillRect(layout.x, edge - blend, source.width * layout.scale, blend);
          }
        }
        context.beginPath(); context.rect(layout.x, layout.y, crop.width * layout.scale, crop.height * layout.scale); context.clip();
        context.translate(layout.x - crop.x * layout.scale, layout.y - crop.y * layout.scale);
        context.scale(layout.scale, layout.scale);
      }
      const sailing = motion.current, position = mode === "voyage" ? sailing : layout.ship;
      if (shipImage && (mode !== "voyage" || sailing.visible)) {
        const frame = { ...position, facing: "left" as const, water: true,
          heading: mode === "voyage" ? sailing.heading : 0,
          velocityX: mode === "voyage" ? sailing.velocityX : 0, velocityY: mode === "voyage" ? sailing.velocityY : 0,
          time: elapsed.current, night: Number(night), still: !moving };
        if (mode !== "detail") drawTradeShipGangway(context, { ...frame, gangway: mode === "voyage" ? sailing.gangway : 1 });
        drawTradeShipSprite(context, shipImage, frame);
        if (mode !== "detail") drawTradeShipGangwayDeck(context, { ...frame, gangway: mode === "voyage" ? sailing.gangway : 1 });
        drawTradeShipLighting(context, { ...frame, phase: mode === "voyage" ? sailing.phase : "docked" });
      }
      context.restore();
    };
    paint();
    if (!moving) return;
    let scheduled = 0, previous: number | null = null;
    const tick = (now: number) => {
      const before = elapsed.current;
      elapsed.current = advanceTradeShipPreviewClock(before, previous === null ? 0 : (now - previous) / 1000,
        { playing, visible: !document.hidden, reducedMotion });
      if (mode === "voyage") {
        motion.current = advanceTradeShipMotion(motion.current, elapsed.current - before);
        const next = motion.current;
        setVoyage(current => current.phase === next.phase
          && Math.round(tradeShipPreviewLegProgress(current, leg) * 100) === Math.round(tradeShipPreviewLegProgress(next, leg) * 100) ? current : next);
      }
      previous = now; paint(); scheduled = requestAnimationFrame(tick);
    };
    scheduled = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(scheduled);
  }, [viewport, mode, leg, night, moving, playing, reducedMotion, mapImage, shipImage, revision]);

  function voyageCommand(command: "arrive" | "depart" | "dock") {
    if (!shipImage) return;
    const current = motion.current, next = commandTradeShipPreview(current, command);
    if (next === current) return;
    motion.current = next; setVoyage(next); setLeg(command === "depart" ? "departing" : "arriving");
    setMode("voyage"); setRevision(value => value + 1);
    if (command !== "dock") setPlaying(true);
  }

  function seekVoyage(progress: number) {
    if (!shipImage) return;
    const next = sampleTradeShipPreviewLeg(leg, progress / 100, motion.current.berth);
    motion.current = next; setVoyage(next); setPlaying(false); setMode("voyage");
    setRevision(value => value + 1);
  }

  function downloadPng() {
    if (!shipImage) return;
    const owner = lifetime.current;
    const surface = document.createElement("canvas");
    surface.width = TRADE_SHIP_SPRITE.width * 2; surface.height = TRADE_SHIP_SPRITE.height * 2;
    const context = surface.getContext("2d");
    if (!context) { setExportNotice("Не удалось подготовить PNG."); return; }
    const frame: TradeShipSpriteFrame = { x: 0, y: 0, width: surface.width, time: elapsed.current,
      night: Number(night), still: true, facing: "left", water: false };
    try {
      drawTradeShipSprite(context, shipImage, frame);
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
      <div><p className={styles.eyebrow}>Мастерская мира · DEV</p><h1>Торговый пароход</h1></div>
      <span className={styles.badge}>PNG · пробный рейс</span>
    </header>
    <div className={styles.layout}>
      <section className={styles.preview} aria-label="Предпросмотр парохода">
        <div className={styles.toolbar}>
          <div className={styles.switcher} aria-label="Вид парохода">
            <button type="button" aria-pressed={mode === "detail"} onClick={() => setMode("detail")}>Крупно</button>
            <button type="button" aria-pressed={mode === "map"} onClick={() => setMode("map")}>На карте</button>
            <button type="button" aria-pressed={mode === "voyage"} onClick={() => setMode("voyage")}>Рейс</button>
          </div>
          <div className={styles.viewTools}>
            <button type="button" aria-pressed={night} aria-label={night ? "Показать день" : "Показать ночь"} onClick={() => setNight(value => !value)}>
              {night ? <Moon size={17} aria-hidden /> : <Sun size={17} aria-hidden />}{night ? "Ночь" : "День"}
            </button>
            <button type="button" disabled={reducedMotion || !shipImage} aria-pressed={moving} onClick={() => setPlaying(value => !value)}>
              {moving ? <Pause size={17} aria-hidden /> : <Play size={17} aria-hidden />}{moving ? "Пауза" : "Воспроизвести"}
            </button>
          </div>
        </div>
        <div className={`${styles.stage} ${mode !== "detail" ? styles.mapStage : ""}`} ref={stage}
          style={mode === "detail" ? undefined : { aspectRatio: `${tradeShipPreviewCrop(mode).width} / ${tradeShipPreviewCrop(mode).height}` }}>
          <canvas ref={canvas} className={styles.canvas} width={800} height={500} role="img"
            aria-label={`Торговый пароход: ${night ? "ночь" : "день"}, ${voyageStatus}`}>
            Для просмотра парохода нужен браузер с поддержкой Canvas 2D.
          </canvas>
          {!shipImage && <div className={`${styles.mapNotice} ${styles.shipNotice}`} role={shipError ? "alert" : "status"}>
            <span>{shipError ? "Корабль не загрузился." : "Загружаем корабль…"}</span>
            {shipError && <button type="button" onClick={() => { setShipError(false); setShipRetry(value => value + 1); }}>Загрузить корабль</button>}
          </div>}
          {mode !== "detail" && !mapImage && <div className={styles.mapNotice} role={mapError ? "alert" : "status"}>
            <span>{mapError ? "Фон карты не загрузился." : "Загружаем южную бухту…"}</span>
            {mapError && <button type="button" onClick={() => { setMapError(false); setMapRetry(value => value + 1); }}>Повторить</button>}
          </div>}
        </div>
        <footer className={styles.previewFooter}><span>{mode === "voyage" ? `Пробный маршрут · ${voyageStatus}` : mode === "map" ? "Примерка у южного берега" : "Корабль из PNG · нос влево"}</span>
          <span>{reducedMotion ? "Меньше движения" : moving ? "Движение включено" : "Рисунок на паузе"}</span></footer>
      </section>
      <aside className={styles.controls} aria-label="Настройки парохода">
        <section className={styles.voyageControls} aria-label="Управление рейсом">
          <div className={styles.voyageHeading}><h2>Рейс</h2><span role="status">{voyageStatus}</span></div>
          <div className={styles.voyageActions}>
            <button type="button" disabled={!shipImage || maneuvering} onClick={() => voyageCommand("arrive")}>Приплыть</button>
            <button type="button" disabled={!shipImage || voyage.phase !== "docked"} onClick={() => voyageCommand("depart")}>Отойти</button>
            <button type="button" disabled={!shipImage} onClick={() => voyageCommand("dock")}>В порт</button>
          </div>
          <label className={styles.field} htmlFor="trade-ship-voyage"><span>{leg === "arriving" ? "Прибытие и мостик" : "Мостик и отход"}<output>{voyageProgress}%</output></span>
            <input id="trade-ship-voyage" disabled={!shipImage} type="range" min={0} max={100} step={1} value={voyageProgress} onChange={event => seekVoyage(Number(event.target.value))} /></label>
          <p className={styles.note}>У берега мостик выдвигается. Перед отходом он полностью убирается, затем корабль идёт вправо и поворачивает вниз-влево.</p>
        </section>
        <h2>Изображение</h2>
        <button type="button" className={styles.download} disabled={!shipImage} onClick={downloadPng}><Download size={18} aria-hidden />Скачать PNG</button>
        <p className={styles.note}>Корпус и дверь — одно изображение. Мостик показывается на карте и в рейсе; PNG скачивается без мостика.</p>
        <p className={styles.note}>В игре первый корабль приходит после восстановления маяка. Заказов пока нет.</p>
        {reducedMotion && <p className={styles.note}>В системе уменьшено движение. Рейс можно просмотреть ползунком. Автоматическое движение остановлено.</p>}
        <p className={styles.exportNotice} role="status">{exportNotice}</p>
      </aside>
    </div>
  </main>;
}
