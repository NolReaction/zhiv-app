import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createTradeShipAudioController, TRADE_SHIP_ARRIVAL_AUDIO: contact } =
  await vite.ssrLoadModule("/features/world/audio/trade-ship-audio.ts");
const { sampleTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");

const at = contact.contactAt;
const frame = { ownerId: "world-owner-a", sceneId: "forest-a", soundscape: true, loops: [], musicDuck: 1,
  listener: { position: { x: 1040, y: 1280 }, viewportWidth: 550, zoom: 1, detail: 1 } };
function fixture() {
  const played = [], prepared = [], settings = { enabled: true, master: .65, buses: { world: .55 } };
  const runtime = { play: event => played.push(event), getSettings: () => settings,
    prepare: (cues, options) => { prepared.push({ cues, ...options }); return Promise.resolve(); } };
  const controller = createTradeShipAudioController(runtime);
  const input = (elapsed, overrides = {}) => ({ voyageId: "account-a:intro-first", motion: sampleTradeShipMotion("arriving", elapsed),
    frame, active: true, visible: true, now: 100_000, ...overrides });
  return { ...controller, played, prepared, settings, input };
}

test("the one visible arrival contact uses the published map owner and one stable bounded event", () => {
  const f = fixture();
  f.update(f.input(0));
  assert.deepEqual(f.prepared[0].cues, ["ship.arrival"]);
  for (const t of [1, 2, at - .1, at - .01, at + .01, at + .03, at + .1, at + 1, at + 2]) f.update(f.input(t));
  assert.equal(f.played.length, 1);
  const event = f.played[0];
  assert.equal(event.id, "account-a:intro-first:arrival-horn-v1");
  assert.equal(event.ownerId, frame.ownerId); assert.equal(event.cueId, "ship.arrival");
  assert.equal(event.maxAgeMs, 350); assert.equal(event.occurredAt, 100_000);
  assert.ok(event.gain > 0 && event.gain <= 1); assert.ok(Math.abs(event.pan) <= .52);
  f.update(f.input(at - .01)); f.update(f.input(at + .01));
  assert.equal(f.played.length, 1, "re-observing the same introduction does not replay its horn");
  f.update(f.input(0, { voyageId: "dev-arrival-2" }));
  f.update(f.input(at - .01, { voyageId: "dev-arrival-2" })); f.update(f.input(at + .01, { voyageId: "dev-arrival-2" }));
  assert.equal(f.played.length, 2, "an explicit new DEV voyage has an independent contact");
  f.dispose();
});

test("horn contact occurs after the actual opaque PNG enters the real world clip", async () => {
  const { TRADE_SHIP_SPRITE: sprite, tradeShipSpritePose } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
  const tiled = JSON.parse(await readFile(root + "/world/tiled/forest.tmj", "utf8"));
  const mapBottom = tiled.height * tiled.tileheight;
  const { data, info } = await sharp(root + "/public" + sprite.src.split("?")[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const minimumY = time => {
    const state = sampleTradeShipMotion("arriving", time), pose = tradeShipSpritePose({ ...state, still: true });
    let min = Infinity;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] <= 64) continue;
      const px = sprite.width - sprite.image.x - x * sprite.image.width / info.width - sprite.pivot.x;
      const py = sprite.image.y + y * sprite.image.height / info.height - sprite.pivot.y;
      min = Math.min(min, state.y + (sprite.pivot.y + px * Math.sin(pose.heading) + py * Math.cos(pose.heading)) * pose.scale);
    }
    return min;
  };
  assert.ok(minimumY(8) > mapBottom, "the former 8-second contact was still below the real map");
  assert.ok(minimumY(contact.contactAt) < mapBottom - 20, "the visible-view gate can hear a ship that has actually entered the map");
});

test("hidden, offscreen, paused, circle, mute and zero volume consume contacts without catch-up", () => {
  for (const mask of [
    { active: false }, { visible: false }, { frame: null }, { frame: { ...frame, soundscape: false } },
    { settings: { enabled: false } }, { settings: { master: 0 } }, { settings: { buses: { world: 0 } } },
  ]) {
    const f = fixture(), { settings, ...overrides } = mask;
    f.update(f.input(at - .01));
    if (settings) Object.assign(f.settings, settings);
    f.update(f.input(at + .01, overrides));
    Object.assign(f.settings, { enabled: true, master: .65, buses: { world: .55 } });
    for (const t of [at + .1, at + 1, at + 2]) f.update(f.input(t));
    assert.equal(f.played.length, 0, JSON.stringify(mask));
    f.dispose();
  }
});

test("joining mid-arrival, seeking and large frames cannot manufacture a late signal", () => {
  for (const times of [[at + .01, at + .03, at + 1], [1, at - 1, at + 1], [at + 2, at - .01, at + .01]]) {
    const f = fixture();
    for (const t of times) f.update(f.input(t));
    assert.equal(f.played.length, 0); f.dispose();
  }
  const f = fixture();
  f.update(f.input(at - .01, { active: false }));
  f.update(f.input(at - .01, { active: false }));
  f.update(f.input(at + .01));
  assert.equal(f.played.length, 1, "a paused simulation does not lose a contact that has not happened yet");
  f.dispose();
});

test("leaving the owner/view aborts preload; account changes never borrow the old contact", () => {
  const f = fixture();
  f.update(f.input(2)); const old = f.prepared[0];
  f.update(f.input(3, { active: false })); assert.equal(old.signal.aborted, true);
  f.update(f.input(4)); const resumed = f.prepared[1]; assert.equal(resumed.signal.aborted, false);
  f.update(f.input(at - .01));
  f.update(f.input(at + .01, { voyageId: "account-b:intro-first", frame: { ...frame, ownerId: "world-owner-b" } }));
  assert.equal(f.played.length, 0, "an account swap establishes a new baseline");
  assert.equal(resumed.signal.aborted, true);
  f.dispose(); f.dispose();
  assert.equal(f.prepared.at(-1).signal.aborted, true);
  f.update(f.input(0)); assert.equal(f.prepared.length, 3);
});

test("docked, departing and missing ships have no arrival signal or speculative preparation", () => {
  const f = fixture();
  for (const phase of ["docked", "deploying", "retracting", "departing", "departed"])
    f.update(f.input(8, { motion: sampleTradeShipMotion(phase, .5) }));
  f.update(f.input(8, { motion: null })); f.update(f.input(8, { voyageId: null }));
  assert.equal(f.played.length, 0); assert.equal(f.prepared.length, 0); f.dispose();
  assert.equal(contact.contactAt, 10.5);
});

test("the persistent horn claim precedes playback and consumes muted or expired contacts", () => {
  for (const scenario of ["audible", "muted", "late", "claimed", "throws"]) {
    const f = fixture(); let claims = 0;
    const claimHorn = () => {
      claims++; assert.equal(f.played.length, 0, "durable claim precedes runtime.play");
      if (scenario === "throws") throw new Error("storage changed owner");
      return scenario !== "claimed";
    };
    if (scenario === "muted") f.settings.enabled = false;
    if (scenario === "late") f.update(f.input(at + 1, { claimHorn }));
    else { f.update(f.input(at - .01, { claimHorn })); f.update(f.input(at + .01, { claimHorn })); }
    f.update(f.input(at + 1.1, { claimHorn }));
    assert.equal(claims, 1, scenario);
    assert.equal(f.played.length, scenario === "audible" ? 1 : 0, scenario); f.dispose();
  }
});

test("arrival sound is original mono PCM48 with headroom, a smooth tail and a quiet world cue", async () => {
  const catalog = JSON.parse(await readFile(root + "/features/audio/catalog/audio-catalog.json", "utf8"));
  const cue = catalog.cues.find(cue => cue.id === "ship.arrival"), asset = catalog.assets.find(asset => asset.id === cue.assets[0]);
  assert.equal(cue.bus, "world"); assert.equal(cue.mode, "one-shot"); assert.equal(cue.maxInstances, 1);
  assert.equal(cue.pitchVariation, 0); assert.equal(cue.gainDb, -13); assert.ok(cue.cooldownMs >= 2600);
  assert.equal(asset.status, "ready"); assert.match(asset.license.sourceUrl, /manifest\.json$/);
  const bytes = await readFile(root + "/public" + asset.src);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  let format, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (id === "fmt ") format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
      rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (id === "data") samples = bytes.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  assert.deepEqual(format, { encoding: 1, channels: 1, rate: 48000, bits: 16 });
  const count = samples.length / 2; assert.equal(count / format.rate, 2.6);
  let square = 0, sum = 0, peak = 0, tail = 0;
  for (let n = 0; n < count; n++) {
    const value = samples.readInt16LE(n * 2) / 32768;
    square += value * value; sum += value; peak = Math.max(peak, Math.abs(value));
    if (n >= count - 4800) tail += value * value;
  }
  assert.ok(20 * Math.log10(peak) <= -8.99, "no aggressive horn peaks");
  const rmsDb = 20 * Math.log10(Math.sqrt(square / count));
  assert.ok(rmsDb >= -23 && rmsDb <= -20, "peak-safe mastering keeps a quiet sustained body");
  assert.ok(Math.abs(sum / count) < .0001, "no DC bias");
  assert.ok(Math.sqrt(tail / 4800) < .0001, "pressure fully releases before the file ends");
  assert.ok(Math.abs(samples.readInt16LE(0)) <= 2 && Math.abs(samples.readInt16LE(samples.length - 2)) <= 2);
});
