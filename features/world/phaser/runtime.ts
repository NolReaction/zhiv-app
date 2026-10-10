// Imported only by the client preview's dynamic import after mount. Phaser reads
// window/document at module evaluation; never re-export this from shared code.
import Phaser from "phaser";
import { previewPointInPolygon, previewSiteVisual, previewWorldScene } from "@/features/world/tiled/preview-state";
import type { WorldPoint } from "@/features/world/tiled/types";
import { createPhaserActor } from "./actor";
import { createPhaserCameraInput } from "./camera-input";
import type { PhaserSiteTransform, PhaserWorldFactory, PhaserWorldOptions, PhaserWorldStatus } from "./contracts";
import { createPhaserDebugOverlay } from "./debug-overlay";
import { applyPhaserOptions, getSiteTransform, sanitizePhaserTransform, transformKey } from "./model";
import { createWorldPresentation, preloadWorldAssets } from "./presentation";

type Drag = {
  siteId: string;
  level: number;
  initial: PhaserSiteTransform;
  anchor: WorldPoint;
  current: PhaserSiteTransform;
};

/** One isolated Phaser game. It consumes authored world data and has no API or economy writes. */
export const createPhaserWorld: PhaserWorldFactory = (parent, source, initialOptions, callbacks, signal) => {
  let options = initialOptions;
  let world = applyPhaserOptions(source, options);
  let game: Phaser.Game | null = null;
  let actor: ReturnType<typeof createPhaserActor> | null = null;
  let presentation: ReturnType<typeof createWorldPresentation> | null = null;
  let camera: ReturnType<typeof createPhaserCameraInput> | null = null;
  let debug: ReturnType<typeof createPhaserDebugOverlay> | null = null;
  let drag: Drag | null = null;
  let disposed = false, ready = false, error: string | null = null;
  let message = "Загружаем лес и отдельные объекты…";
  let renderer = "—", lastStatusTime = 0;
  let removeContextListener: (() => void) | null = null;

  function status() {
    if (disposed) return;
    const value: PhaserWorldStatus = {
      loading: !ready && !error, error, message, renderer,
      fps: ready && game ? Math.round(game.loop.actualFps) : 0,
      zoom: camera?.zoom ?? 1, moving: actor?.moving ?? false,
      actor: actor ? { ...actor.position } : null,
    };
    callbacks.onStatus(value);
  }
  function fail(reason: string) {
    if (disposed || error) return;
    error = reason;
    message = "Сцену можно загрузить заново кнопкой «Повторить».";
    camera?.cancel();
    status();
  }
  function draw(nextWorld = world, nextOptions = options) {
    presentation?.update(nextWorld, nextOptions);
    debug?.update(nextWorld, nextOptions);
  }
  function siteAt(point: WorldPoint) {
    return [...world.sites].sort((a, b) => b.anchor.y - a.anchor.y)
      .find(site => previewPointInPolygon(point, site.hitArea)) ?? null;
  }
  function select(id: string | null) {
    options = { ...options, selectedSiteId: id };
    debug?.update(world, options);
    callbacks.onSelect(id);
  }
  function cancelDrag() {
    if (!drag) return;
    drag = null;
    draw();
  }
  function beginDrag(point: WorldPoint) {
    if (options.mode !== "place" || error) return false;
    const site = siteAt(point);
    if (!site) return false;
    const level = previewSiteVisual(site, options.levels).level;
    const initial = getSiteTransform(options.transforms, site.id, level);
    const authored = previewWorldScene(source, options.levels).sites.find(item => item.id === site.id)!;
    drag = { siteId: site.id, level, initial, current: initial, anchor: authored.anchor };
    select(site.id);
    return true;
  }
  function moveDrag(delta: WorldPoint) {
    if (!drag || error) return;
    drag.current = sanitizePhaserTransform({ ...drag.initial, dx: drag.initial.dx + delta.x, dy: drag.initial.dy + delta.y });
    const preview = { ...options, transforms: { ...options.transforms, [transformKey(drag.siteId, drag.level)]: drag.current } };
    draw(applyPhaserOptions(source, preview), preview);
  }
  function endDrag() {
    if (!drag || error) return;
    const result = drag;
    drag = null;
    let transform = result.current;
    if (options.snap) {
      const size = Math.max(8, options.gridSize);
      transform = sanitizePhaserTransform({ ...transform,
        dx: Math.round((result.anchor.x + transform.dx) / size) * size - result.anchor.x,
        dy: Math.round((result.anchor.y + transform.dy) / size) * size - result.anchor.y,
      });
    }
    options = { ...options, transforms: { ...options.transforms, [transformKey(result.siteId, result.level)]: transform } };
    world = applyPhaserOptions(source, options);
    actor?.updateWorld(world);
    draw();
    message = "Положение изменено в черновике стенда.";
    callbacks.onTransform(result.siteId, result.level, transform);
    status();
  }
  function tap(point: WorldPoint) {
    if (error) return;
    const site = siteAt(point);
    select(site?.id ?? null);
    if (options.mode === "walk") {
      const approach = site ? actor?.walkToSite(site) : null;
      const reached = site ? Boolean(approach) : actor?.walkTo(point);
      message = reached
        ? site ? approach?.kind === "near-entry" ? `Мохлик идёт к свободному месту рядом со входом: ${site.label}.` : `Мохлик идёт ко входу: ${site.label}.` : "Мохлик идёт к выбранной точке."
        : "Здесь нет доступного пути. Попробуйте дорожку или поляну.";
    } else message = site ? `${site.label}: выбран объект и его разметка.` : "Потяните свободное место, чтобы переместить камеру.";
    status();
  }
  function initialFocus() { camera?.focus(source.focus); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    removeContextListener?.();
    // Cancel gestures while presentation objects still exist.
    camera?.dispose();
    camera = null;
    actor?.dispose();
    actor = null;
    presentation?.dispose();
    presentation = null;
    debug?.dispose();
    debug = null;
    if (game) {
      game.canvas?.remove();
      game.destroy(true, false);
      // Phaser destroys on its next tick; resume a hidden/blurred loop so an
      // unmounted route does not retain a renderer until the tab becomes active.
      if (game.isRunning) game.loop.wake();
      game = null;
    }
  }

  class ForestLabScene extends Phaser.Scene {
    constructor() { super("forest-phaser-lab"); }
    preload() {
      if (disposed) return;
      this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
        fail(`Не удалось загрузить графику: ${file.key}. Проверьте соединение и повторите.`);
      });
      this.load.on(Phaser.Loader.Events.PROGRESS, (progress: number) => {
        message = `Загружаем графику: ${Math.round(progress * 100)}%.`;
        status();
      });
      preloadWorldAssets(this, source);
    }
    create() {
      if (disposed || error) return;
      try {
        presentation = createWorldPresentation(this, world, options);
        actor = createPhaserActor(this, world, options);
        debug = createPhaserDebugOverlay(this);
        camera = createPhaserCameraInput(this, parent, source, { tap, beginDrag, moveDrag, endDrag, cancelDrag });
        initialFocus();
        debug.update(world, options);
        renderer = this.game.renderer.type === Phaser.WEBGL ? "WebGL" : "Canvas";
        ready = true;
        message = "Лес готов. Осмотрите объекты или отправьте Мохлика на прогулку.";
        status();
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : "Не удалось создать сцену Phaser.");
      }
    }
    update(time: number, delta: number) {
      if (disposed || error || !ready) return;
      actor?.update(time, delta);
      presentation?.tick(time);
      if (time - lastStatusTime > 500) {
        lastStatusTime = time;
        status();
      }
    }
  }

  const handle = {
    update(next: PhaserWorldOptions) {
      if (disposed) return;
      const geometryChanged = next.levels !== options.levels || next.transforms !== options.transforms;
      if (geometryChanged || next.mode !== options.mode) camera?.cancel();
      options = next;
      if (geometryChanged) {
        world = applyPhaserOptions(source, options);
        actor?.updateWorld(world);
      }
      actor?.updateOptions(options);
      if (ready) draw();
    },
    focus(target: string) {
      if (!camera || disposed) return;
      if (target === "world") camera.focus({ x: 0, y: 0, width: source.width, height: source.height });
      else if (target === "actor" && actor) camera.focus({ x: actor.position.x - 160, y: actor.position.y - 160, width: 320, height: 320 });
      else {
        const site = world.sites.find(item => item.id === target);
        if (site) camera.focus({ x: site.bounds.x - 45, y: site.bounds.y - 45, width: site.bounds.width + 90, height: site.bounds.height + 120 });
      }
      status();
    },
    zoom(factor: number) { camera?.zoomBy(factor); status(); },
    reset() { camera?.cancel(); actor?.reset(); initialFocus(); status(); },
    dispose,
  };
  if (signal?.aborted) { disposed = true; return handle; }
  signal?.addEventListener("abort", dispose, { once: true });
  status();
  try {
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: Math.max(1, parent.clientWidth), height: Math.max(1, parent.clientHeight),
      backgroundColor: "#15251a", banner: false, autoFocus: false,
      audio: { noAudio: true },
      input: { keyboard: false, mouse: false, touch: false, gamepad: false, windowEvents: false },
      scale: { mode: Phaser.Scale.NONE, autoRound: true },
      fps: { target: 60, limit: 60, smoothStep: true },
      render: { antialias: true, roundPixels: false, powerPreference: "low-power" },
      loader: { maxParallelDownloads: 4, timeout: 20_000 },
      scene: ForestLabScene,
      callbacks: {
        postBoot(booted) {
          if (disposed) { booted.destroy(true, false); return; }
          const contextLost = (event: Event) => {
            event.preventDefault();
            fail("Графический контекст был прерван. Нажмите «Повторить», чтобы восстановить сцену.");
          };
          booted.canvas.addEventListener("webglcontextlost", contextLost);
          removeContextListener = () => booted.canvas.removeEventListener("webglcontextlost", contextLost);
        },
      },
    });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : "Браузер не смог запустить Phaser.");
  }
  return handle;
};
