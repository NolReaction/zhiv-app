/**
 * Render the product site's still artwork with the game's compositor.
 * Requires esbuild, sharp and @napi-rs/canvas. Optional render-only modules
 * can live outside this repository via SITE_MEDIA_NODE_MODULES. The app itself
 * needs none of these at runtime. A future recorded video is supplied separately.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findTerrainMaster } from "./lib/world-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function dependency(name) {
  try { return require(name); } catch (error) {
    const modules = process.env.SITE_MEDIA_NODE_MODULES ?? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
    if (modules) return require(path.join(modules, name));
    throw new Error(`Install the render-only dependency ${name}, or set SITE_MEDIA_NODE_MODULES.`, { cause: error });
  }
}
const { createCanvas, loadImage, Path2D, ImageData } = dependency("@napi-rs/canvas");
const { build } = dependency("esbuild");
const sharp = dependency("sharp");
const output = path.join(root, "public/site");
const temporary = await mkdtemp(path.join(tmpdir(), "zhiv-site-media-"));

// Canvas-only DOM adapter: no browser, requests, session, or live user state.
globalThis.document = { createElement(name) {
  if (name !== "canvas") throw new Error(`Unsupported renderer element: ${name}`);
  return createCanvas(1, 1);
} };
globalThis.Path2D = Path2D;
globalThis.ImageData = ImageData;

try {
  await mkdir(output, { recursive: true });
  const modulePath = path.join(temporary, "renderer.mjs");
  await build({
    stdin: { contents: `
      export { paintFixedWorld } from './features/world/tiled/renderer';
      export { initialPreviewLevels, previewWorldScene, previewSiteVisual } from './features/world/tiled/preview-state';
      export { createPreviewRoute } from './features/world/tiled/preview-route';
      export { drawBuildingDetails } from './features/world/scene/building-details';
      export { drawForestLighting, drawForestLightEmitters } from './features/world/environment/lighting/forest-lighting';
    `, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: modulePath,
    tsconfig: path.join(root, "tsconfig.json"), logLevel: "silent",
  });
  const runtime = await import(pathToFileURL(modulePath).href);
  const source = JSON.parse(await readFile(path.join(root, "features/world/tiled/forest.generated.json"), "utf8"));
  const terrainMaster = await findTerrainMaster(path.join(root, "art/world/prototype"));
  const terrainBytes = await sharp(await readFile(terrainMaster)).autoOrient().png().toBuffer();
  const terrainInfo = await sharp(terrainBytes).metadata();
  // These art levels are obtainable in the released game. The bridge and
  // lighthouse retain their authored initial states (restoration is not live).
  const levels = { ...runtime.initialPreviewLevels(source), home: 2, workshop: 1, quarry: 1, woodlot: 1 };
  const scene = runtime.previewWorldScene(source, levels);
  const mapPlaces = Object.fromEntries([["home", "home"], ["workshop", "workshop"], ["neighbors", "plesk-shop"]].map(([key, siteId]) => {
    const site = scene.sites.find(item => item.id === siteId);
    if (!site) throw new Error(`Missing site panorama place: ${siteId}. Update the site media configuration after changing the world.`);
    const point = { x: site.anchor.x / scene.width * 100, y: site.anchor.y / scene.height * 100 };
    if (Object.values(point).some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error(`Site panorama place ${siteId} has an anchor outside the world.`);
    }
    return [key, point];
  }));
  const visuals = Object.fromEntries(scene.sites.map(site => [site.id, runtime.previewSiteVisual(site, levels)]));
  const urls = [...new Set([...scene.terrain.map(item => item.image), ...Object.values(visuals).map(item => item.image)])];
  const ground = scene.terrain.find(item => item.id === "forest-ground");
  if (!ground) throw new Error("The site panorama requires the authored forest-ground terrain.");
  // Read the editable master directly. Runtime WebP compression or a stale
  // browser export must not become another generation of site compression.
  const images = new Map(await Promise.all(urls.map(async url => [url, await loadImage(url === ground.image
    ? terrainBytes : path.join(root, "public", url.split("?")[0]))])));
  const options = { levels, night: false, debug: false, selectedSiteId: null, reducedMotion: false, showBuildings: true, showHero: true };
  const route = runtime.createPreviewRoute(scene);
  if (!route.select("clearing-look")) throw new Error(route.status().error);

  function render(canvas, camera, elapsed = 0, night = 0, actor = null) {
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#13281e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const zoom = canvas.width / camera.width;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camera.x, -camera.y);
    runtime.paintFixedWorld(ctx, scene, { images, visuals, options, actor: actor ?? route.at(0, false), elapsed, dusk: night });
    const light = { night, elapsed, reducedMotion: false, showBuildings: true, levels };
    runtime.drawForestLighting(ctx, scene, light);
    runtime.drawForestLightEmitters(ctx, scene, light);
    runtime.drawBuildingDetails(ctx, scene, light);
    return canvas;
  }

  const generated = new Map();
  async function responsiveImage(name, canvas, widths, fallbackWidth, alt) {
    const original = canvas.toBuffer("image/png"), variants = [];
    for (const width of widths) {
      const height = Math.round(width * canvas.height / canvas.width);
      const filename = width === fallbackWidth ? `${name}.webp` : `${name}-${width}.webp`;
      // One reduction from the lossless compositor frame. Never resize an
      // already compressed preview, and never use the former quality-30 map.
      const bytes = await sharp(original).resize(width, height, { kernel: "lanczos3", withoutEnlargement: true })
        .webp({ quality: 86, effort: 6 }).toBuffer();
      const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      generated.set(filename, bytes);
      variants.push({ src: `/site/${filename}?v=${version}`, width, height, bytes: bytes.length });
    }
    const fallback = variants.find(variant => variant.width === fallbackWidth);
    if (!fallback) throw new Error(`Missing fallback size for ${name}.`);
    return { ...fallback, alt, srcSet: variants.map(variant => `${variant.src} ${variant.width}w`).join(", "), variants };
  }
  const poster = await responsiveImage("poster", render(createCanvas(1440, 900), { x: 610, y: 615, width: 570 }, 3),
    [960, 1440], 1440, "Мохлик у дома-пня и ягодного куста на лесной полянке");
  const mapCamera = { x: scene.width / 2, y: scene.height / 2, width: scene.width };
  // The panorama is first composited at native terrain resolution, then
  // reduced with a high-quality filter for mobile and ordinary DPR screens.
  // 2560px is enough for the site's largest high-DPR view without sending a
  // full world texture to every phone. Larger future masters are capped here.
  const mapWidth = Math.min(2560, terrainInfo.width);
  if (mapWidth < 1600) throw new Error("Site artwork requires a terrain master at least 1600 pixels wide.");
  const mapHeight = Math.round(mapWidth * scene.height / scene.width);
  const mapWidths = [...new Set([800, 1600, mapWidth])];
  const mapCanvas = createCanvas(mapWidth, mapHeight);
  const map = await responsiveImage("map", render(mapCanvas, mapCamera, 3), mapWidths, 1600,
    "Карта лесного мира с полянкой, мастерской, шахтой, рекой и домами жителей");
  const nightMap = await responsiveImage("map-night", render(mapCanvas, mapCamera, 3, .86), mapWidths, 1600,
    "Тот же лес вечером: свет в окнах домов и фонари вдоль дорожек");

  // Finish every render and encode before replacing any checked-in output.
  for (const [filename, bytes] of generated) await writeFile(path.join(output, filename), bytes);

  await writeFile(path.join(output, "media.json"), JSON.stringify({
    title: "Лесной мир «Я живой»",
    description: "Иллюстрации текущей полянки, подготовленные игровым рендерером без аккаунта и действий игрока.",
    scene: source.id, levels, mapPlaces,
    artwork: { terrainMaster: path.relative(root, terrainMaster).split(path.sep).join("/"), width: terrainInfo.width, height: terrainInfo.height },
    poster, map, nightMap,
    video: null,
  }, null, 2) + "\n");
  for (const [filename, bytes] of generated) console.log(`${filename}: ${(bytes.length / 1024).toFixed(1)} KiB`);
  console.log("Rendered responsive still artwork and versioned media.json; no video generated.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
