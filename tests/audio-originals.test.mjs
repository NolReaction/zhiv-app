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
  assert.equal(manifest.assets.length, 84);
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
    assert.ok(rms > .002 && rms < .3, `${item.id} audible source with restrained level`);
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
  assert.equal(loops.length, 9);
  assert.ok(loops.reduce((sum, item) => sum + item.decodedBytes, 0) < 24 * 1024 * 1024);
  for (const item of manifest.assets.filter(asset => asset.kind === "music")) {
    assert.equal(item.channels, 2);
    assert.ok(item.durationSeconds >= 90 && item.durationSeconds <= 150);
    assert.match(item.files[0].src, /\.opus$/);
    assert.match(item.files[1].src, /\.m4a$/);
  }
});
