import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectAudioCatalog } from "../scripts/lib/audio-catalog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(root, "features/audio/catalog/audio-catalog.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "art/audio/originals-v1/manifest.json"), "utf8"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function pcmWave(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  let format, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + size <= bytes.length, "complete WAV chunks");
    if (id === "fmt ") {
      assert.equal(bytes.readUInt16LE(start), 1, "PCM format");
      format = { channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    }
    if (id === "data") samples = bytes.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  assert.ok(format && samples?.length);
  assert.equal(format.bits, 16);
  return { ...format, samples };
}

test("original pack fills the catalog, documents source and verifies every shipped byte", () => {
  assert.deepEqual(inspectAudioCatalog(catalog, { root, requireReady: true }).errors, []);
  assert.equal(manifest.assets.length, 111);
  assert.deepEqual(new Set(manifest.assets.map(item => item.id)), new Set(catalog.assets.map(item => item.id)));
  const hashes = new Set();
  for (const source of manifest.sources) assert.equal(sha(readFileSync(path.join(root, source.path))), source.sha256, source.path);
  for (const item of manifest.assets) {
    const slot = catalog.assets.find(asset => asset.id === item.id);
    assert.equal(slot.src, item.files[0].src);
    assert.equal(slot.fallbackSrc, item.files[1]?.src);
    for (const file of item.files) {
      const bytes = readFileSync(path.join(root, "public", file.src));
      assert.equal(bytes.length, file.bytes, file.src);
      assert.equal(sha(bytes), file.sha256, file.src);
    }
    assert.ok(!hashes.has(item.masterSha256), `distinct variation: ${item.id}`);
    hashes.add(item.masterSha256);
  }
});

test("three new neighbours have distinct original greeting timbres with three short quiet variants each", () => {
  const voices = [["lopukh", 302], ["kamneshmyg", 102], ["leaftail", 219]];
  const sources = new Set();
  let deliveryBytes = 0;
  for (const [actor, fundamental] of voices) {
    const cue = catalog.cues.find(item => item.id === `actor.${actor}.greeting`);
    assert.equal(cue.bus, "characters", "speech obeys the character volume and mute");
    assert.equal(cue.mode, "one-shot");
    assert.equal(cue.maxInstances, 1, "repeated markers do not layer one neighbour's voice");
    assert.ok(cue.gainDb <= -3 && cue.cooldownMs >= 2500 && cue.pitchVariation <= .012);
    assert.equal(cue.assets.length, 3);
    for (const [index, id] of cue.assets.entries()) {
      assert.equal(id, `actor.${actor}.greeting.${String(index + 1).padStart(2, "0")}`);
      const item = manifest.assets.find(entry => entry.id === id);
      assert.equal(item.channels, 1);
      assert.ok(item.durationSeconds > .5 && item.durationSeconds < .9, "a short nonverbal line leaves room for dialogue");
      assert.ok(Math.abs(item.measurements.rmsDb + 22) <= .01 && item.measurements.peakDb <= -8,
        "soft source level with measured peak headroom");
      assert.equal(item.composition.creature, actor);
      assert.equal(item.composition.gesture, "greeting");
      assert.equal(item.composition.variant, index + 1);
      assert.equal(item.composition.fundamentalHz, fundamental);
      assert.equal(item.composition.formantsHz.length, 3);
      assert.ok(item.composition.syllables >= 2 && item.composition.syllables <= 3);
      sources.add(item.masterSha256);
      deliveryBytes += item.files[0].bytes;
      assert.match(item.description, /original nonverbal/i);
      assert.match(catalog.assets.find(asset => asset.id === id).license.sourceUrl, /manifest\.json$/);
    }
  }
  assert.equal(sources.size, 9, "all greetings are original variants, rather than shared old audio");
  assert.ok(deliveryBytes < 700 * 1024, "nine short mono responses stay lightweight");
});

test("weather noise and overlapping close footsteps keep headroom even at full player volume", () => {
  const peak = id => {
    const item = manifest.assets.find(entry => entry.id === id);
    const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
    let maximum = 0;
    for (let offset = 0; offset < wav.samples.length; offset += 2)
      maximum = Math.max(maximum, Math.abs(wav.samples.readInt16LE(offset) / 32768));
    return maximum;
  };
  const cuePeak = id => {
    const cue = catalog.cues.find(entry => entry.id === id);
    return Math.max(...cue.assets.map(peak)) * 10 ** (cue.gainDb / 20);
  };
  // Worst-case peaks summed in phase, before user attenuation or the master
  // compressor. The bus sliders must not be the only protection for old saves.
  assert.ok(cuePeak("weather.wind") + cuePeak("weather.rain") < .17,
    "both weather beds leave headroom even without rain's additional wind duck");
  assert.ok(cuePeak("weather.wind") < .002,
    "wind stays barely noticeable even before attenuation by the weather/master sliders");
  const touch = catalog.cues.find(entry => entry.id === "action.water.touch");
  assert.ok(cuePeak(touch.id) * touch.maxInstances < .105,
    "even two simultaneous water touches keep a quiet ceiling at full user volume");
  for (const id of ["action.step.grass", "action.step.wood"]) {
    const cue = catalog.cues.find(entry => entry.id === id);
    assert.ok(cuePeak(id) * cue.maxInstances < .12,
      `${id}: two nearby residents cannot produce a near-full-scale impact`);
    assert.ok(cuePeak(id) > .03, `${id}: close steps remain audible`);
  }
});

test("decoded WAV effects are non-silent, unclipped and match their declared duration", () => {
  for (const item of manifest.assets.filter(asset => asset.kind !== "music")) {
    const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
    assert.equal(wav.rate, 48000, item.id);
    assert.equal(wav.channels, item.channels, item.id);
    const count = wav.samples.length / 2;
    assert.equal(count / wav.channels, item.frames, item.id);
    let peak = 0, sum = 0, squares = 0;
    for (let i = 0; i < count; i++) {
      const sample = wav.samples.readInt16LE(i * 2) / 32768;
      peak = Math.max(peak, Math.abs(sample)); sum += sample; squares += sample * sample;
    }
    const rms = Math.sqrt(squares / count);
    assert.ok(peak <= .795, `${item.id} peak headroom`);
    const minimumRms = item.id.startsWith("forest.") ? .0005 : .002;
    assert.ok(rms > minimumRms && rms < .3, `${item.id} audible source with restrained level (wildlife includes long silences)`);
    assert.ok(Math.abs(sum / count) < .0001, `${item.id} negligible DC`);
    assert.ok(Math.abs(20 * Math.log10(rms) - item.measurements.rmsDb) < .015, `${item.id} measured RMS`);
    for (let channel = 0; channel < wav.channels; channel++) {
      const first = wav.samples.readInt16LE(channel * 2) / 32768;
      const last = wav.samples.readInt16LE((count - wav.channels + channel) * 2) / 32768;
      if (item.kind === "effect") {
        assert.ok(Math.abs(first) < .002 && Math.abs(last) < .002, `${item.id} faded edges`);
      } else {
        assert.ok(Math.abs(first - last) < Math.max(.003, item.measurements.maxAdjacentDelta * 2), `${item.id} continuous loop`);
      }
    }
  }
});

test("ambient bank leaves mobile buffer headroom and music has a Safari fallback", () => {
  const loops = manifest.assets.filter(item => item.kind === "loop");
  assert.equal(loops.length, 11);
  assert.ok(loops.reduce((sum, item) => sum + item.decodedBytes, 0) < 24 * 1024 * 1024);
  for (const item of manifest.assets.filter(asset => asset.kind === "music")) {
    assert.equal(item.channels, 2);
    assert.ok(item.durationSeconds >= 90 && item.durationSeconds <= 150);
    assert.match(item.files[0].src, /\.opus$/);
    assert.match(item.files[1].src, /\.m4a$/);
  }
});

test("wildlife phrases are sparse and individual peaks remain quieter than the previous dense loops", () => {
  for (const [id, phrases, maximumPeakDb, minimumGap] of [
    ["forest.day.01", 2, -29, 8],
    ["forest.night.01", 1, -21, 18],
  ]) {
    const item = manifest.assets.find(entry => entry.id === id);
    const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
    assert.equal(item.durationSeconds, 20);
    assert.equal(wav.channels, 1, "long pauses do not double the decoded mobile footprint");
    assert.ok(item.measurements.peakDb <= maximumPeakDb + .01, `${id}: silence must not boost individual calls`);
    const active = [];
    const window = wav.rate / 10;
    for (let start = 0; start < item.frames; start += window) {
      let squares = 0;
      for (let index = start; index < start + window; index++) {
        squares += (wav.samples.readInt16LE(index * 2) / 32768) ** 2;
      }
      if (Math.sqrt(squares / window) > .00015) active.push(start / wav.rate);
    }
    const groups = [];
    for (const start of active) {
      const last = groups.at(-1);
      if (!last || start - last.end > .5) groups.push({ start, end: start + .1 });
      else last.end = start + .1;
    }
    assert.equal(groups.length, phrases, `${id}: actual PCM phrase count`);
    for (let index = 0; index < groups.length; index++) {
      const next = groups[(index + 1) % groups.length].start + (index === groups.length - 1 ? 20 : 0);
      assert.ok(next - groups[index].end >= minimumGap, `${id}: long quiet pauses including the loop join`);
    }
    assert.ok(active.length / 200 < .09, `${id}: mostly quiet, without hidden wind`);
  }
});

test("campfire has calmer, softer crackles instead of a constant wind bed", () => {
  const fire = manifest.assets.find(item => item.id === "campfire.01");
  assert.match(fire.files[0].src, /calm-v4/);
  assert.ok(fire.measurements.peakDb <= -25 && fire.measurements.rmsDb <= -41);
  const wav = pcmWave(readFileSync(path.join(root, "public", fire.files[0].src)));
  const window = wav.rate / 20;
  const levels = [];
  for (let start = 0; start < fire.frames; start += window) {
    let squares = 0;
    for (let index = start; index < start + window; index++) squares += (wav.samples.readInt16LE(index * 2) / 32768) ** 2;
    const rms = Math.sqrt(squares / window);
    assert.ok(rms > .0002, "faint embers remain between crackles without silent chopped segments");
    levels.push(rms);
  }
  levels.sort((a, b) => a - b);
  const contrast = levels[Math.floor(levels.length * .9)] / levels[Math.floor(levels.length * .1)];
  assert.ok(contrast > 4 && contrast < 25, "wood events stand above the faint bed; the old constant whoosh had a 1.3 ratio");

  const old = pcmWave(readFileSync(path.join(root, "public/audio/originals-v1/loop/campfire.01.wood-v3.wav")));
  const energy = audio => {
    let squares = 0, differences = 0, previous = 0;
    for (let offset = 0; offset < audio.samples.length; offset += 2) {
      const sample = audio.samples.readInt16LE(offset) / 32768;
      squares += sample * sample;
      differences += (sample - previous) ** 2;
      previous = sample;
    }
    return { squares, differences };
  };
  const currentEnergy = energy(wav), oldEnergy = energy(old);
  assert.ok(currentEnergy.squares < oldEnergy.squares / 4, "same duration at least 6 dB quieter than the reported harsh revision");
  assert.ok(currentEnergy.differences / currentEnergy.squares < .04,
    "softer spectrum rather than turning down the same sharp transients");
});

test("cooking is quiet finite liquid bubbles without a continuous wind-like bed", () => {
  const cooking = manifest.assets.find(item => item.id === "cooking.simmer.01");
  assert.match(cooking.files[0].src, /bubbles-v2/);
  assert.ok(cooking.measurements.peakDb <= -24 && cooking.measurements.rmsDb <= -36);
  const wav = pcmWave(readFileSync(path.join(root, "public", cooking.files[0].src)));
  const window = wav.rate / 20;
  let quietWindows = 0, quietRun = 0, longestQuietRun = 0, squares = 0, differences = 0, previous = 0;
  for (let start = 0; start < cooking.frames; start += window) {
    let windowSquares = 0;
    for (let frame = start; frame < start + window; frame++) {
      const sample = wav.samples.readInt16LE(frame * 2) / 32768;
      windowSquares += sample * sample;
      differences += (sample - previous) ** 2;
      previous = sample;
    }
    squares += windowSquares;
    if (Math.sqrt(windowSquares / window) < .0002) {
      quietWindows++;
      quietRun++;
      longestQuietRun = Math.max(longestQuietRun, quietRun);
    } else quietRun = 0;
  }
  assert.ok(quietWindows / (cooking.frames / window) > .25,
    "actual PCM has pauses between bubbles; the reported airy revision had none");
  assert.ok(longestQuietRun <= 6, "small simmer releases continue without long silent gaps");
  assert.ok(differences / squares < .005, "rounded low bubbles, without sharp or hissing upper texture");
});

test("added action sounds have bounded, restrained tails", () => {
  for (const [prefix, count, duration, rmsDb] of [
    ["cooking.simmer.", 1, 6, -25],
    ["action.bush.rustle.", 2, .65, -25],
    ["action.mushroom.eat.", 2, .25, -26],
    ["water.drop.", 2, .31, -28],
    ["action.mine.strike.", 2, .36, -27],
    ["action.fish.bobber.", 2, .37, -29],
  ]) {
    const entries = manifest.assets.filter(item => item.id.startsWith(prefix));
    assert.equal(entries.length, count);
    for (const item of entries) {
      assert.equal(item.channels, 1);
      assert.ok(item.durationSeconds <= duration, item.id);
      assert.ok(item.measurements.rmsDb <= rmsDb + .01, item.id);
    }
  }
});

test("bobber and pick contacts stay quiet even with two actors and end without clicks", () => {
  for (const id of ["action.mine.strike", "action.fish.bobber"]) {
    const cue = catalog.cues.find(entry => entry.id === id);
    let loudest = 0;
    for (const assetId of cue.assets) {
      const item = manifest.assets.find(entry => entry.id === assetId);
      assert.ok(item.measurements.peakDb <= -14, `${assetId}: restrained impact`);
      const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
      const tailFrames = Math.round(wav.rate * .02);
      let tailSquares = 0;
      for (let frame = item.frames - tailFrames; frame < item.frames; frame++)
        tailSquares += (wav.samples.readInt16LE(frame * 2) / 32768) ** 2;
      assert.ok(Math.sqrt(tailSquares / tailFrames) < .001, `${assetId}: quiet final 20 ms`);
      loudest = Math.max(loudest, 10 ** (item.measurements.peakDb / 20));
    }
    assert.ok(loudest * 10 ** (cue.gainDb / 20) * cue.maxInstances < .3,
      `${id}: worst-case overlap leaves headroom before player/master attenuation`);
  }
});

test("repeated navigation and volume feedback have short, quiet tails", () => {
  const specifications = [
    { prefix: "ui.open.", duration: .17, rmsDb: -25 },
    { prefix: "ui.close.", duration: .15, rmsDb: -25 },
    { prefix: "ui.tab.", duration: .12, rmsDb: -27 },
    { prefix: "ui.slider.", duration: .09, rmsDb: -28 },
  ];
  for (const spec of specifications) {
    const entries = manifest.assets.filter(item => item.id.startsWith(spec.prefix));
    assert.ok(entries.length > 0, spec.prefix);
    for (const item of entries) {
      assert.ok(item.durationSeconds <= spec.duration, `${item.id}: no lingering navigation swish`);
      assert.ok(item.measurements.rmsDb <= spec.rmsDb + .05, `${item.id}: restrained repeated feedback`);
      const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
      const tailSamples = Math.round(wav.rate * .015);
      let squares = 0;
      for (let offset = wav.samples.length - tailSamples * 2; offset < wav.samples.length; offset += 2) {
        squares += (wav.samples.readInt16LE(offset) / 32768) ** 2;
      }
      assert.ok(Math.sqrt(squares / tailSamples) < .0032, `${item.id}: quiet final 15 ms avoids a cut-off tail`);
    }
  }
});

test("logo and daily gift signatures stay short, soft and cheap to preload", () => {
  let deliveryBytes = 0;
  for (const [id, maximumDuration, maximumRms] of [
    ["ui.startup.01", .65, -24], ["ui.daily-reward.01", .85, -23],
  ]) {
    const item = manifest.assets.find(entry => entry.id === id);
    assert.equal(item.channels, 1, `${id}: no extra stereo buffer for a centered UI gesture`);
    assert.ok(item.durationSeconds >= .4 && item.durationSeconds <= maximumDuration, `${id}: compact signature`);
    assert.ok(item.measurements.rmsDb <= maximumRms && item.measurements.peakDb <= -9, `${id}: restrained level`);
    const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
    const tailFrames = Math.round(wav.rate * .025);
    let tailSquares = 0, differenceSquares = 0, squares = 0, previous = 0;
    for (let frame = 0; frame < item.frames; frame++) {
      const sample = wav.samples.readInt16LE(frame * 2) / 32768;
      squares += sample * sample;
      differenceSquares += (sample - previous) ** 2;
      if (frame >= item.frames - tailFrames) tailSquares += sample * sample;
      previous = sample;
    }
    assert.ok(Math.sqrt(tailSquares / tailFrames) < .001, `${id}: final tail has no audible cut-off`);
    assert.ok(differenceSquares / squares < .025, `${id}: no added broadband hiss or sharp upper partials`);
    deliveryBytes += item.files[0].bytes;
  }
  assert.ok(deliveryBytes < 140 * 1024, "preloading the two signatures stays lightweight");
});

test("construction finish has a compact original signature with a quiet tail", () => {
  const item = manifest.assets.find(entry => entry.id === "ui.construction-complete.01");
  assert.equal(item.channels, 1);
  assert.ok(item.durationSeconds >= .6 && item.durationSeconds <= 1);
  assert.ok(item.files[0].bytes < 100 * 1024, "small enough to prepare before the first upgrade");
  assert.ok(item.measurements.peakDb <= -9 && item.measurements.rmsDb <= -22);
  const wav = pcmWave(readFileSync(path.join(root, "public", item.files[0].src)));
  const tailFrames = Math.round(wav.rate * .025);
  let tailSquares = 0;
  for (let frame = item.frames - tailFrames; frame < item.frames; frame++) {
    tailSquares += (wav.samples.readInt16LE(frame * 2) / 32768) ** 2;
  }
  assert.ok(Math.sqrt(tailSquares / tailFrames) < .001, "finishing chord fades without cutting off");
  const reward = manifest.assets.find(entry => entry.id === "ui.reward.01");
  assert.notEqual(item.masterSha256, reward.masterSha256, "a dedicated building sound, not a renamed reward");
});
