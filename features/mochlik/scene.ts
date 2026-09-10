import { WORLD_ART } from "@/features/world/art";
import { HOUSE_ANCHORS, HOME_CANVAS_SIZE, BUSH_FOLIAGE, homePixel } from "./home-layout";
import type { WorldState } from "@/features/world/model";
import { homeAppearance } from "./home-state";
import { houseVariantFor, type HouseVariant } from "./house-variants";
import { FOREST_MAP } from "@/features/world/map-manifest";
import { HOME_AREA, MAP_SIZE } from "@/features/world/map-layout";
import type { GameItemId } from "@/features/game/game-rewards";
import { SHELTER, SHELTER_ART, nextWeatherChange, type Activity, type Destination, type Mushroom, INACTIVITY_SECONDS, LONG_ABSENCE_SECONDS } from "./habitat";
import { connectHabitat } from "./session";
import { loadHabitatImage } from "./assets";
import { homeBackingSize, loadHomeDetail } from "./home-art";
import { drawLanternLight } from "./lantern-light";
import { pixelSprite } from "./pixel-sprite";
import { pixelFrame } from "./pixel-frame";
import { feedingFrame } from "./feeding";
import { drawInsects } from "./insects";
import { readPresence, writePresence } from "./presence";
import { propBehindBody, drawDecor, drawShelter, drawProp, drawWeather, drawMomentAccents } from "./ambience";

const WEATHER_BOUNDS = { x: -HOME_AREA.x * HOME_CANVAS_SIZE / HOME_AREA.size, y: -HOME_AREA.y * HOME_CANVAS_SIZE / HOME_AREA.size, width: MAP_SIZE * HOME_CANVAS_SIZE / HOME_AREA.size, height: MAP_SIZE * HOME_CANVAS_SIZE / HOME_AREA.size };

export type SceneOptions = { lampOn: boolean; dusk: boolean; paused: boolean; reducedMotion: boolean; view?: "circle" | "world"; backgrounded?: boolean; presenceKey?: string; bestStreakDays?: number; items?: readonly GameItemId[]; worldState?: WorldState; worldGifts?: readonly string[] };
export type HabitatScene = { configure: (options: SceneOptions) => void; notice: () => void; invite: (place: Destination, mushroomId?: number) => void; moveTo: (x: number, y: number) => void; hitPet: (x: number, y: number) => boolean; paintLighting: (context: CanvasRenderingContext2D) => void; paintWeather: (context: CanvasRenderingContext2D) => void; dispose: () => void };
type Callbacks = { activity: (activity: Activity) => void; ready: () => void; failure: (error?: unknown) => void; rendered?: () => void };
function loadArt() { return loadHabitatImage(WORLD_ART.home); }

export function mountHabitat(canvas: HTMLCanvasElement, initial: SceneOptions, callbacks: Callbacks): HabitatScene {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("2D canvas unavailable");
  const ctx = context;
  let options = { ...initial }, disposed = false, art: HTMLImageElement | null = null;
  let detail: HTMLCanvasElement | null = null;
  let upgradeArt: HTMLImageElement | null = null, variant: HouseVariant | null = null, variantRequest = 0;
  let appearance = homeAppearance(initial.worldState, initial.worldGifts, initial.items);
  let frame = 0, previous = 0, lastDraw = 0, width = 1;
  let lampGlow = initial.lampOn ? 1 : 0, dusk = initial.dusk ? 1 : 0;
  let lastActivity: Activity | null = null;
  const lastClock = Date.now();
  let lastSave = lastClock;
  let hiddenAt: number | null = initial.backgrounded ? lastClock : null;
  const session = connectHabitat(initial.presenceKey, initial.view ?? "circle", !initial.backgrounded, world => {
    const saved = readPresence(initial.presenceKey, lastClock);
    if (saved) {
      world.elapse(saved.absentFor); world.state.inactiveFor += saved.inactiveFor;
      if (saved.resting || saved.deepSleep) world.restAfterAbsence(saved.deepSleep);
    }
    world.setAway(appearance.away, false, initial.worldState?.journeys[0]?.routeId === "brook_path");
  }, () => { if (!disposed) { cancelAnimationFrame(frame); frame = 0; previous = 0; resume(); } });
  const world = session.world;
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  let mushroomArt: HTMLCanvasElement | null = null;
  // Stable random paths: rerenders do not scramble particles, sleep cycles do not reset them.
  const sleepParticles = Array.from({ length: 5 }, (_, i) => ({
    delay: i * .85 + Math.random(), duration: 3.8 + Math.random() * 2.4,
    drift: (Math.random() - .5) * 18, rise: 14 + Math.random() * 10,
    wobble: 1 + Math.random() * 2, phase: Math.random() * Math.PI * 2,
  }));
  if (session.isOwner()) {
    world.setLamp(options.lampOn);
    world.setInsects(options.dusk ? "firefly" : "butterfly");
    world.setDecor(options.bestStreakDays ?? 0, appearance.items);
  }
  function drawGround() {
    if (detail) {
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(detail, 0, 0, width, width); ctx.restore(); return;
    }
    if (art) ctx.drawImage(art, HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size, 0, 0, width, width);
  }
  function loadVariant() {
    const next = houseVariantFor(appearance.houseLevel);
    if (next === variant) return;
    variant = next; upgradeArt = null; const request = ++variantRequest;
    if (!next) return;
    void loadHabitatImage(next.image).then(image => {
      if (disposed || request !== variantRequest) return;
      if (image.naturalWidth !== next.slot.width || image.naturalHeight !== next.slot.height) return;
      upgradeArt = image; draw();
    }).catch(() => { /* The approved base house remains a complete visual fallback. */ });
  }
  function draw() {
    if (!art || disposed) return;
    const resolution = canvas.width / HOME_CANVAS_SIZE;
    ctx.setTransform(resolution, 0, 0, resolution, 0, 0); ctx.imageSmoothingEnabled = false;
    drawGround();
    if (upgradeArt && variant) {
      const slot = variant.slot, at = homePixel(slot), scale = HOME_CANVAS_SIZE / HOME_AREA.size;
      ctx.save(); ctx.beginPath(); ctx.rect(at.x, at.y, slot.width * scale, slot.height * scale);
      HOUSE_ANCHORS.doorway.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
      const lamp = HOUSE_ANCHORS.lamp; ctx.rect(lamp.x, lamp.y, lamp.width, lamp.height); ctx.clip("evenodd");
      ctx.drawImage(upgradeArt, at.x, at.y, slot.width * scale, slot.height * scale); ctx.restore();
    }
    const state = world.state, a = state.activity, p = state.progress;
    const visible = state.travel !== "away";
    const t = options.reducedMotion ? 0 : state.activityTime;
    const sprite = pixelFrame(state, options.reducedMotion);
    const food = feedingFrame(p);
    const size = Math.round(state.size * width), x = Math.round((state.position.x + sprite.offsetX) * width);
    const y = Math.round((state.position.y - state.lift + sprite.sink + sprite.offsetY) * width);
    drawDecor(ctx, state, options.reducedMotion);
    const shelterInFront = state.position.y < SHELTER_ART.ground / HOME_CANVAS_SIZE;
    if (mushroomArt && !shelterInFront) drawShelter(ctx, mushroomArt);
    const inside = state.layer === "house" && (a === "sleep" || a === "stir" || a === "wake" || a === "enter" && p > .48 || a === "leave" && p < .52);
    const drawMushroom = (mushroom: Mushroom) => {
      if (!mushroomArt || mushroom.growth < .06) return;
      if (state.feedingId === mushroom.id && a === "eat" && food.lifted) return;
      const height = Math.round(3 + mushroom.growth * 16);
      const w = Math.max(2, Math.round(height * .7));
      const mx = Math.round(mushroom.position.x * width), my = Math.round(mushroom.position.y * width);
      ctx.fillStyle = "#334c3655"; ctx.fillRect(mx - 4, my - 1, 8, 2);
      ctx.drawImage(mushroomArt, mx - Math.floor(w / 2), my - height, w, height);
    };
    state.mushrooms.filter(item => item.position.y <= state.position.y).forEach(drawMushroom);
    if (visible && propBehindBody(state)) drawProp(ctx, state, options.reducedMotion);
    if (visible && sprite.opacity > 0) {
      ctx.save(); ctx.globalAlpha = sprite.opacity;
      if (inside) {
        ctx.beginPath();
        HOUSE_ANCHORS.doorway.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
        ctx.clip();
      }
      const stir = a === "stir" && !options.reducedMotion ? Math.round(Math.sin(p * Math.PI * 4) * (1 - p)) : 0;
      const breathing = a === "sleep" && !options.reducedMotion ? Math.round(Math.sin(state.elapsed * 1.6) * .65) : 0;
      ctx.drawImage(pixelSprite(sprite.pose, sprite.direction, sprite.frame, appearance.equipment), x - Math.floor(size / 2) + stir, y - size + breathing, size, size);
      if (a === "eat" && food.lifted && food.remaining > 0 && mushroomArt) {
        const mushroom = state.mushrooms.find(item => item.id === state.feedingId);
        if (mushroom) {
          const groundY = mushroom.position.y * width;
          const mouthY = y - size * .35;
          const foodY = Math.round(groundY + (mouthY - groundY) * food.lift);
          const height = Math.round(19 - food.lift * 7), foodWidth = Math.round(height * .7);
          const cut = Math.round((1 - food.remaining) * 18);
          // The same mushroom rises from the ground and loses a piece at each bite.
          ctx.drawImage(mushroomArt, 0, cut, 16, 22 - cut,
            x - Math.floor(foodWidth / 2), foodY - height + Math.round(height * cut / 22), foodWidth, Math.max(1, Math.round(height * (22 - cut) / 22)));
        }
      }
      ctx.restore();
    }
    // Restore the same foliage pixels in place. Moving the whole map under a mask
    // caused seams; bush entry/exit now use the single sprite's concealment envelope.
    if (visible && state.layer === "bush") {
      ctx.save(); ctx.beginPath();
      BUSH_FOLIAGE.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); ctx.clip();
      drawGround(); ctx.restore();
      if (!options.reducedMotion && (a === "jump" && p > .65 || a === "emerge" && p < .55)) {
        const burst = a === "jump" ? (p - .65) / .35 : p / .55;
        ctx.fillStyle = "#adb65f";
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(Math.round(homePixel(FOREST_MAP.bush.inside).x - 9 + i * 6 + (i - 1.5) * burst * 5), Math.round(homePixel(FOREST_MAP.bush.inside).y - 10 - Math.sin(burst * Math.PI) * (7 + i)), 2, 1);
        }
      }
    }
    state.mushrooms.filter(item => item.position.y > state.position.y).forEach(drawMushroom);
    if (mushroomArt && shelterInFront) drawShelter(ctx, mushroomArt);
    else if (mushroomArt && (state.moment === "rain" || ["shelter", "shelter-peek"].includes(a))
      && Math.hypot(state.position.x - SHELTER.x, state.position.y - SHELTER.y) < .06) drawShelter(ctx, mushroomArt, true);
    if (visible && !propBehindBody(state)) drawProp(ctx, state, options.reducedMotion);
    if (visible && a === "eat" && food.phase === "chew" && food.bites > 0 && !options.reducedMotion) {
      ctx.fillStyle = "#dfbe82";
      for (let i = 0; i < 3; i++) ctx.fillRect(x - 3 + i * 3, y - Math.round(size * .35) + Math.floor((t * 6 + i) % 4), 1, 1);
    }
    ctx.fillStyle = `rgba(8,17,35,${dusk * .57})`; ctx.fillRect(0, 0, width, width);
    ctx.fillStyle = `rgba(69,105,125,${state.rain * .12})`; ctx.fillRect(0, 0, width, width);
    drawLanternLight(ctx, lampGlow, dusk);
    drawInsects(ctx, state, dusk, options.reducedMotion);
    if (options.view !== "world") drawWeather(ctx, state, options.reducedMotion, false, WEATHER_BOUNDS);
    if (visible) drawMomentAccents(ctx, state, options.reducedMotion);
    if (visible && (a === "sleep" || a === "stir")) {
      ctx.save(); ctx.fillStyle = "#efe8c1";
      const glyph = ["1111", "0001", "0010", "0100", "1111"];
      const count = options.reducedMotion ? 3 : sleepParticles.length;
      for (let i = 0; i < count; i++) {
        const particle = sleepParticles[i];
        const phase = options.reducedMotion ? .25 + i * .22 : ((state.elapsed + particle.delay) / particle.duration) % 1;
        const px = options.reducedMotion ? HOUSE_ANCHORS.sleep.x - 6 + i * 8
          : Math.round(HOUSE_ANCHORS.sleep.x + particle.drift * phase + Math.sin(phase * Math.PI * 2 + particle.phase) * particle.wobble);
        const py = options.reducedMotion ? HOUSE_ANCHORS.sleep.y - 7 - i * 5 : Math.round(HOUSE_ANCHORS.sleep.y - particle.rise * phase);
        ctx.globalAlpha = options.reducedMotion ? .65 : Math.sin(phase * Math.PI) * .85;
        for (let row = 0; row < glyph.length; row++) for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] === "1") ctx.fillRect(px + col, py + row, 1, 1);
        }
      }
      ctx.restore();
      if (state.wakeTapsNeeded > 1) {
        for (let i = 0; i < state.wakeTapsNeeded; i++) {
          ctx.fillStyle = i < state.wakeTaps ? "#fff0b9" : "#b4c29966";
          ctx.fillRect(HOUSE_ANCHORS.sleep.x - 6 + i * 5, HOUSE_ANCHORS.sleep.y - 12, 3, 2);
        }
      }
    }
    if (lastActivity !== a) { lastActivity = a; callbacks.activity(a); }
    callbacks.rendered?.();
  }
  // Wall time ages mushrooms/inactivity even when the tab is hidden. A deliberate
  // pause freezes both clocks; animation movement always keeps its bounded step.
  function syncClock() {
    const now = Date.now(); session.advance(now, !options.paused);
    if (!options.paused && !options.backgrounded && now - lastSave >= 15_000) persist();
  }
  function persist() {
    if (options.backgrounded || disposed || !session.isOwner()) return;
    lastSave = Date.now();
    writePresence(options.presenceKey, { seenAt: lastSave, inactiveFor: world.state.inactiveFor,
      resting: world.state.resting, deepSleep: world.state.wakeTapsNeeded > 1 });
  }
  function tick(now: number) {
    frame = 0;
    if (disposed || options.paused || options.backgrounded || options.reducedMotion || !art) return;
    if (previous && now - lastDraw >= 1000 / 30) {
      const dt = Math.min((now - previous) / 1000, .05); syncClock();
      if (session.isOwner()) world.update(dt, false);
      lampGlow += ((options.lampOn ? 1 : 0) - lampGlow) * Math.min(1, dt * 3);
      dusk += ((options.dusk ? 1 : 0) - dusk) * Math.min(1, dt * 2);
      draw(); lastDraw = now; previous = now;
    } else if (!previous) { previous = now; lastDraw = now; }
    frame = requestAnimationFrame(tick);
  }
  function cancelStillTimer() { if (stillTimer !== null) { clearTimeout(stillTimer); stillTimer = null; } }
  function scheduleStillChange() {
    cancelStillTimer();
    const weatherDeadline = nextWeatherChange(world.state.ecologyTime);
    const next = [INACTIVITY_SECONDS - world.state.inactiveFor,
      weatherDeadline, ...world.state.mushrooms.map(item => (1 - item.growth) * item.growSeconds)].filter(seconds => seconds > .001);
    if (!next.length) return;
    // Reduced motion changes only at an ecological deadline, never on an animation loop.
    stillTimer = setTimeout(() => { stillTimer = null; syncClock(); resume(); }, Math.min(...next) * 1000 + 20);
  }
  function resume() {
    if (disposed || !art || options.paused || options.backgrounded) return;
    if (options.reducedMotion) {
      if (session.isOwner()) world.settle();
      lampGlow = options.lampOn ? 1 : 0; dusk = options.dusk ? 1 : 0; draw(); scheduleStillChange(); return;
    }
    if (!frame) { syncClock(); previous = 0; lastDraw = 0; frame = requestAnimationFrame(tick); }
  }
  function resize() {
    width = HOME_CANVAS_SIZE;
    const next = homeBackingSize(canvas.clientWidth, window.devicePixelRatio, options.view === "world");
    if (canvas.width !== next || canvas.height !== next) { canvas.width = next; canvas.height = next; draw(); }
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  void loadArt().then(result => {
    if (disposed) return;
    if (result.naturalWidth !== MAP_SIZE || result.naturalHeight !== MAP_SIZE) throw new Error("Map dimensions do not match its manifest");
    art = result; loadVariant();
    void loadHomeDetail(result).then(tile => {
      if (disposed) return;
      detail = tile;
      if (!options.backgrounded && !options.paused) draw();
    }).catch(() => { /* Keep the complete original crop if the detail download fails. */ });
    // Reuse the painted forest mushroom, cut along its contour once, so new growth
    // shares the map's palette and texture instead of introducing another art style.
    mushroomArt = document.createElement("canvas"); mushroomArt.width = 16; mushroomArt.height = 22;
    const mc = mushroomArt.getContext("2d");
    if (!mc) throw new Error("2D canvas unavailable");
    mc.imageSmoothingEnabled = false; mc.beginPath();
    const contour = [[7, 0], [11, 2], [12, 4], [14, 6], [14, 9], [10, 11], [10, 15], [11, 19], [6, 19], [5, 16], [5, 11], [1, 11], [0, 9], [1, 6], [3, 4], [3, 2]];
    contour.forEach(([cx, cy], i) => { if (i) mc.lineTo(cx, cy); else mc.moveTo(cx, cy); }); mc.closePath(); mc.clip();
    const source = FOREST_MAP.house.mushroomSource;
    mc.drawImage(art, source.x, source.y, source.width, source.height, 0, 0, 16, 22);
    if (options.reducedMotion && !options.paused && !options.backgrounded && session.isOwner()) world.settle();
    draw(); callbacks.ready(); persist(); resume();
  }).catch(error => { if (!disposed) { dispose(); callbacks.failure(error); } });
  function dispose() {
    if (disposed) return; syncClock(); persist(); disposed = true; session.release(); cancelStillTimer(); cancelAnimationFrame(frame); frame = 0; observer.disconnect(); art = null; detail = null; mushroomArt = null;
  }
  return {
    configure(next) {
      if (disposed) return; syncClock();
      if (next.backgrounded && !options.backgrounded) { persist(); hiddenAt = Date.now(); }
      if (!next.backgrounded && options.backgrounded) {
        if (hiddenAt !== null && !options.paused && !appearance.away) {
          // The shared controller already contains activity from the other view.
          // Only an actually idle absence may replace it with a resting pose.
          if (session.unattendedFor(Date.now()) >= LONG_ABSENCE_SECONDS) {
            const presence = readPresence(options.presenceKey, Date.now());
            if (presence && presence.absentFor < LONG_ABSENCE_SECONDS && !presence.resting) world.state.inactiveFor = 0;
            else world.restAfterAbsence();
          }
        }
        hiddenAt = null;
      }
      const animateJourney = Boolean(options.worldState);
      options = { ...next }; appearance = homeAppearance(options.worldState, options.worldGifts, options.items); loadVariant();
      session.configure(options.view ?? "circle", !options.backgrounded);
      if (session.isOwner()) world.setAway(appearance.away, animateJourney, options.worldState?.journeys[0]?.routeId === "brook_path");
      if (session.isOwner()) { world.setLamp(options.lampOn); world.setInsects(options.dusk ? "firefly" : "butterfly"); world.setDecor(options.bestStreakDays ?? 0, appearance.items); }
      cancelStillTimer();
      if (options.paused || options.backgrounded || options.reducedMotion) { cancelAnimationFrame(frame); frame = 0; previous = 0; }
      resume();
    },
    notice() { if (!disposed && session.isOwner() && !appearance.away) { syncClock(); world.notice(); persist(); resume(); } },
    invite(place, mushroomId) { if (!disposed && session.isOwner() && !appearance.away) { syncClock(); if (world.invite(place, mushroomId)) { persist(); resume(); } } },
    moveTo(x, y) { if (!disposed && session.isOwner() && !appearance.away) { syncClock(); if (world.moveTo({ x, y })) { persist(); resume(); } } },
    hitPet(x, y) {
      const state = world.state;
      return !appearance.away && pixelFrame(state, options.reducedMotion).opacity > .1
        && Math.abs(x - state.position.x) < state.size * .45
        && y > state.position.y - state.size && y < state.position.y;
    },
    paintLighting(context) {
      if (disposed) return;
      context.fillStyle = `rgba(8,17,35,${dusk * .57})`; context.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
      context.fillStyle = `rgba(69,105,125,${world.state.rain * .12})`; context.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
    },
    paintWeather(context) {
      if (disposed) return;
      context.save(); context.translate(HOME_AREA.x, HOME_AREA.y); context.scale(HOME_AREA.size / HOME_CANVAS_SIZE, HOME_AREA.size / HOME_CANVAS_SIZE);
      drawWeather(context, world.state, options.reducedMotion, false, WEATHER_BOUNDS);
      context.restore();
    },
    dispose,
  };
}
