/**
 * Render the product site's illustrative forest tour with the game's compositor.
 * Requires ffmpeg, esbuild, sharp and @napi-rs/canvas. Optional render-only modules
 * can live outside this repository via SITE_MEDIA_NODE_MODULES. The app itself
 * needs none of these at runtime. Pass --stills-only to skip the MP4.
 */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

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
  // These art levels are obtainable in the released game. The bridge and
  // lighthouse retain their authored initial states (restoration is not live).
  const levels = { ...runtime.initialPreviewLevels(source), home: 2, workshop: 1, quarry: 1, woodlot: 1 };
  const scene = runtime.previewWorldScene(source, levels);
  const visuals = Object.fromEntries(scene.sites.map(site => [site.id, runtime.previewSiteVisual(site, levels)]));
  const urls = [...new Set([...scene.terrain.map(item => item.image), ...Object.values(visuals).map(item => item.image)])];
  const images = new Map(await Promise.all(urls.map(async url => [url, await loadImage(path.join(root, "public", url.split("?")[0]))])));
  const options = { levels, night: false, debug: false, selectedSiteId: null, reducedMotion: false, showBuildings: true, showHero: true };
  const route = runtime.createPreviewRoute(scene);
  if (!route.select("clearing-look")) throw new Error(route.status().error);
  const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

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

  const poster = render(createCanvas(1440, 900), { x: 610, y: 615, width: 570 }, 3);
  await sharp(poster.toBuffer("image/png")).webp({ quality: 84, effort: 6 }).toFile(path.join(output, "poster.webp"));
  const mapCamera = { x: scene.width / 2, y: scene.height / 2, width: scene.width };
  const map = createCanvas(1600, 1600);
  await sharp(render(map, mapCamera, 3).toBuffer("image/png")).webp({ quality: 30, effort: 6 }).toFile(path.join(output, "map.webp"));
  await sharp(render(map, mapCamera, 3, .86).toBuffer("image/png")).webp({ quality: 80, effort: 6 }).toFile(path.join(output, "map-night.webp"));
  console.log("Rendered poster.webp (1440×900), map.webp and map-night.webp (1600×1600).");

  if (!process.argv.includes("--stills-only")) {
    const fps = 24, duration = 12, frames = fps * duration;
    const video = createCanvas(1280, 720);
    const sourceVideo = path.join(temporary, "source.mp4");
    const ffmpeg = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0",
      "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-maxrate", "1600k", "-bufsize", "3200k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-map_metadata", "-1", sourceVideo,
    ], { stdio: ["pipe", "ignore", "inherit"] });
    const completion = once(ffmpeg, "close");
    route.start(false);
    try {
      for (let index = 0; index < frames; index++) {
        const time = index / fps;
        // A calm out-and-back camera move ends at its starting composition.
        const sweep = (1 - Math.cos(time / duration * Math.PI * 2)) / 2;
        const night = smooth((sweep - .3) / .7) * .86;
        const camera = { x: 610 + 17 * sweep, y: 615 - 42 * sweep, width: 570 + 400 * sweep };
        if (index === fps * 8) route.reverse(false);
        route.advance(1 / fps * .55);
        const frame = render(video, camera, time, night, route.at(time, true)).toBuffer("image/png");
        if (!ffmpeg.stdin.write(frame)) await once(ffmpeg.stdin, "drain");
        if (index % (fps * 3) === 0) console.log(`Rendering tour: ${index}/${frames} frames`);
      }
      ffmpeg.stdin.end();
      const [code] = await completion;
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    } catch (error) {
      ffmpeg.kill();
      throw error;
    }
    // Two-pass encoding keeps the optional mobile teaser around 330 KB.
    for (const pass of [1, 2]) {
      const encoder = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-i", sourceVideo,
        "-vf", "scale=854:480:flags=lanczos,fps=20", "-an", "-c:v", "libx264", "-preset", "slow", "-b:v", "210k",
        "-pass", String(pass), "-passlogfile", path.join(temporary, "tour-pass"), "-pix_fmt", "yuv420p",
        ...(pass === 1 ? ["-f", "null", "-"] : ["-movflags", "+faststart", path.join(output, "forest-tour.mp4")]),
      ], { stdio: ["ignore", "ignore", "inherit"] });
      const [code] = await once(encoder, "close");
      if (code !== 0) throw new Error(`ffmpeg encoding pass ${pass} exited with code ${code}`);
    }
    console.log("Rendered forest-tour.mp4 (854×480, 12 seconds, 20fps, H.264, no audio).");
  }
  await writeFile(path.join(output, "media.json"), JSON.stringify({
    title: "Видеопрогулка по полянке",
    description: "Иллюстративный пролёт камеры по текущей карте с Мохликом и сменой освещения. Подготовлено игровым рендерером; не запись действий игрока.",
    scene: source.id, levels,
    poster: { src: "/site/poster.webp", width: 1440, height: 900, alt: "Мохлик у дома-пня и ягодного куста на лесной полянке" },
    map: { src: "/site/map.webp", width: 1600, height: 1600, alt: "Карта лесного мира с полянкой, мастерской, шахтой, рекой и домами жителей" },
    nightMap: { src: "/site/map-night.webp", width: 1600, height: 1600, alt: "Тот же лес вечером: свет в окнах домов и фонари вдоль дорожек" },
    video: { src: "/site/forest-tour.mp4", width: 854, height: 480, duration: 12, fps: 20, audio: false },
  }, null, 2) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
