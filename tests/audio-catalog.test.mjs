import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectAudioCatalog } from "../scripts/lib/audio-catalog.mjs";

const fixture = () => ({
  version: 1,
  assets: [{ id: "water.01", src: null, status: "pending", license: null }],
  cues: [{ id: "water", bus: "world", mode: "loop", assets: ["water.01"], gainDb: -12, priority: 40, maxInstances: 1, cooldownMs: 0, pitchVariation: 0, fadeMs: 800 }],
  profiles: [{ id: "river", cues: ["water"] }],
});
const provenance = () => ({ name: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", author: "Test recorder", sourceUrl: "https://example.org/recording", acquiredAt: "2026-10-08", changes: "Trimmed and exported to PCM WAV", attribution: "No attribution required; Test recorder credited voluntarily" });
const temporary = t => {
  const root = mkdtempSync(path.join(tmpdir(), "zhiv-audio-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/audio/loop"), { recursive: true });
  return root;
};
const ready = (root, extension = "wav") => {
  const catalog = fixture();
  catalog.assets[0] = { ...catalog.assets[0], src: `/audio/loop/water.${extension}`, status: "ready", license: provenance() };
  writeFileSync(path.join(root, `public/audio/loop/water.${extension}`), "media fixture");
  return catalog;
};
const issues = (catalog, options) => inspectAudioCatalog(catalog, options).errors.join("\n");

test("pending catalog is read-only, usable without files and distinguishable from release-ready", t => {
  const root = temporary(t);
  const catalog = fixture();
  const before = structuredClone(catalog);
  const report = inspectAudioCatalog(catalog, { root });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.counts, { assets: 1, ready: 0, pending: 1, cues: 1, profiles: 1 });
  assert.match(issues(catalog, { root, requireReady: true }), /still pending/);
  assert.deepEqual(catalog, before);
});

test("real application catalog and CLI accept intentional silent slots", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const catalog = JSON.parse(readFileSync(path.join(root, "features/audio/catalog/audio-catalog.json"), "utf8"));
  assert.deepEqual(inspectAudioCatalog(catalog, { root }).errors, []);
  const command = spawnSync(process.execPath, [path.join(root, "scripts/check-audio.mjs")], { encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /Audio catalog check passed/);
  const unknown = spawnSync(process.execPath, [path.join(root, "scripts/check-audio.mjs"), "--unsafe"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
});

test("malformed arrays and IDs report errors without crashing", () => {
  for (const catalog of [null, [], {}, { ...fixture(), assets: [null, { id: "../escape" }] }, { ...fixture(), cues: null }, { ...fixture(), profiles: [false] }])
    assert.ok(inspectAudioCatalog(catalog).errors.length);
});

test("duplicate identifiers and references are rejected across all catalogs", () => {
  for (const table of ["assets", "cues", "profiles"]) {
    const catalog = fixture();
    catalog[table].push(structuredClone(catalog[table][0]));
    assert.match(issues(catalog), /duplicate ID/);
  }
  const catalog = fixture();
  catalog.cues[0].assets.push("missing", "water.01");
  catalog.profiles[0].cues.push("unknown", "water");
  assert.match(issues(catalog), /unknown reference missing/);
  assert.match(issues(catalog), /unknown reference unknown/);
  assert.match(issues(catalog), /duplicate reference water/);
});

test("unsafe playback values and unsupported modes cannot reach the mixer", () => {
  for (const [field, value] of [["gainDb", 1], ["gainDb", NaN], ["gainDb", -61], ["priority", 101], ["maxInstances", 0], ["maxInstances", 25], ["maxInstances", 1.5], ["cooldownMs", Infinity], ["cooldownMs", -1], ["pitchVariation", 0.09], ["fadeMs", -1], ["fadeMs", 10001]]) {
    const catalog = fixture();
    catalog.cues[0][field] = value;
    assert.match(issues(catalog), new RegExp(field));
  }
  const catalog = fixture();
  catalog.cues[0].bus = "unknown";
  catalog.cues[0].mode = "stream";
  assert.match(issues(catalog), /unknown audio bus/);
  assert.match(issues(catalog), /expected one-shot/);
});

test("streamed music uses a dedicated bus, one deck and whole-file loops", () => {
  const catalog = fixture();
  catalog.cues[0].mode = "music";
  catalog.cues[0].maxInstances = 2;
  catalog.assets[0].loopStart = 0;
  catalog.assets[0].loopEnd = 10;
  assert.match(issues(catalog), /music mode and music bus/);
  assert.match(issues(catalog), /one deck/);
  assert.match(issues(catalog), /loops the whole file/);
});

test("ready assets require real files and complete provenance", t => {
  const root = temporary(t);
  const catalog = ready(root);
  assert.deepEqual(inspectAudioCatalog(catalog, { root, requireReady: true }).errors, []);
  for (const field of Object.keys(provenance())) {
    const broken = structuredClone(catalog);
    broken.assets[0].license[field] = "";
    assert.match(issues(broken, { root }), new RegExp(`license.${field}`));
  }
  catalog.assets[0].src = "/audio/missing.wav";
  assert.match(issues(catalog, { root }), /audio file does not exist/);
  catalog.assets[0].license = null;
  assert.match(issues(catalog, { root }), /complete provenance record/);
});

test("original recording paths are accepted but impossible dates and source traversal are not", t => {
  const root = temporary(t);
  const catalog = ready(root);
  catalog.assets[0].license.sourceUrl = "art/audio/masters/water.wav";
  assert.deepEqual(inspectAudioCatalog(catalog, { root }).errors, []);
  catalog.assets[0].license.acquiredAt = "2026-02-30";
  catalog.assets[0].license.sourceUrl = "art/audio/../../secret.wav";
  assert.match(issues(catalog, { root }), /sourceUrl/);
  assert.match(issues(catalog, { root }), /real YYYY-MM-DD/);
});

test("pending cannot disguise a media source or an unreviewed license", () => {
  const catalog = fixture();
  catalog.assets[0].src = "/audio/unreviewed.wav";
  assert.match(issues(catalog), /pending assets must/);
});

test("local media paths reject remote sources and plain, encoded or backslash traversal", t => {
  const root = temporary(t);
  const catalog = ready(root);
  for (const src of ["https://example.org/file.wav", "//example.org/a.wav", "/audio/../secret.wav", "/audio/%2e%2e/secret.wav", "/audio/a\\..\\secret.wav", "/audio//water.wav", "/audio/./water.wav", "/audio/a.wav?x=1", "/audio/a.svg", "/other/a.wav"]) {
    catalog.assets[0].src = src;
    assert.match(issues(catalog, { root }), /local \/audio\//, src);
  }
});

test("ready assets reject empty files, directories and symlinked files or parents", t => {
  const root = temporary(t);
  const catalog = ready(root);
  const file = path.join(root, "public/audio/loop/water.wav");
  writeFileSync(file, "");
  assert.match(issues(catalog, { root }), /nonempty audio file/);
  rmSync(file);
  mkdirSync(file);
  assert.match(issues(catalog, { root }), /nonempty audio file/);
  rmSync(file, { recursive: true });
  const outside = path.join(root, "private.wav");
  writeFileSync(outside, "private recording");
  symlinkSync(outside, file);
  assert.match(issues(catalog, { root }), /symlinks are not allowed/);
  rmSync(path.join(root, "public/audio/loop"), { recursive: true });
  mkdirSync(path.join(root, "external"));
  writeFileSync(path.join(root, "external/water.wav"), "recording");
  symlinkSync(path.join(root, "external"), path.join(root, "public/audio/loop"), "dir");
  assert.match(issues(catalog, { root }), /symlinks are not allowed/);
});

test("Opus requires an existing compatible fallback and each source is validated", t => {
  const root = temporary(t);
  const catalog = ready(root, "opus");
  assert.match(issues(catalog, { root }), /requires an AAC/);
  catalog.assets[0].fallbackSrc = "/audio/loop/water.m4a";
  assert.match(issues(catalog, { root }), /audio file does not exist/);
  writeFileSync(path.join(root, "public/audio/loop/water.m4a"), "fallback fixture");
  assert.deepEqual(inspectAudioCatalog(catalog, { root }).errors, []);
  catalog.assets[0].fallbackSrc = "/audio/../../private.wav";
  assert.match(issues(catalog, { root }), /no traversal/);
});

test("loop points are finite, ordered and explicitly paired", () => {
  for (const point of [{ loopStart: -1, loopEnd: 3 }, { loopStart: 3, loopEnd: 2 }, { loopStart: 1 }, { loopEnd: Infinity }]) {
    const catalog = fixture();
    Object.assign(catalog.assets[0], point);
    assert.match(issues(catalog), /loop(Start|End)/);
  }
});

test("effects exceeding the runtime download budget are caught before a release", t => {
  const root = temporary(t);
  const catalog = ready(root);
  truncateSync(path.join(root, "public/audio/loop/water.wav"), 12 * 1024 * 1024 + 1);
  assert.match(issues(catalog, { root }), /12 MiB download limit/);
  catalog.cues[0].bus = "music";
  catalog.cues[0].mode = "music";
  assert.deepEqual(inspectAudioCatalog(catalog, { root }).errors, []);
});

test("preparation preserves originals/catalog, supports a dry run and refuses overwrites", t => {
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0 || spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status !== 0) {
    t.skip("Optional authoring tools ffmpeg/ffprobe are not installed");
    return;
  }
  const root = temporary(t);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "features/audio/catalog"), { recursive: true });
  const script = path.join(root, "scripts/prepare-audio.mjs");
  copyFileSync(fileURLToPath(new URL("../scripts/prepare-audio.mjs", import.meta.url)), script);
  const catalog = JSON.stringify(fixture());
  const catalogPath = path.join(root, "features/audio/catalog/audio-catalog.json");
  writeFileSync(catalogPath, catalog);
  const source = path.join(root, "original recording.wav");
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=0.1", source], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const original = readFileSync(source);
  const args = [script, "--source", source, "--asset", "water.01", "--kind", "loop", "--mono"];
  const dryRun = spawnSync(process.execPath, [...args, "--dry-run"], { encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const output = path.join(root, "public/audio/loop/water.01.wav");
  assert.equal(existsSync(output), false);
  const exported = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(readFileSync(output).length > 44);
  const duplicate = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Refusing to overwrite/);
  assert.deepEqual(readFileSync(source), original);
  assert.equal(readFileSync(catalogPath, "utf8"), catalog);
});
