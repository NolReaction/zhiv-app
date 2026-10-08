import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const BUSES = new Set(["music", "ambience", "world", "characters", "ui"]);
const MODES = new Set(["one-shot", "loop", "music"]);
const AUDIO_EXTENSION = /\.(?:wav|ogg|opus|m4a|mp3|aac|webm)$/;
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const LICENSE_FIELDS = ["name", "url", "author", "sourceUrl", "acquiredAt", "changes", "attribution"];
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const httpUrl = value => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

/** Runtime URLs are local public files, never untrusted network requests or encoded traversal. */
export function audioFilePath(src, root) {
  if (typeof src !== "string" || !/^\/audio\/[a-zA-Z0-9/_\-.]+$/.test(src)
    || src.slice(1).split("/").some(segment => segment === "." || segment === ".." || !segment)
    || !AUDIO_EXTENSION.test(src)) throw new Error("expected a local /audio/ file with a supported lowercase extension and no traversal");
  return path.resolve(root, "public", src.slice(1));
}

/** Reject symlinked components as well as directory traversal before reading an exported file. */
export function inspectAudioFile(src, root) {
  const absolute = audioFilePath(src, root);
  const publicRoot = path.resolve(root, "public");
  let current = publicRoot;
  for (const segment of path.relative(publicRoot, absolute).split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("symlinks are not allowed in public/audio");
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size === 0) throw new Error("expected a nonempty audio file");
  const realPublicRoot = realpathSync(publicRoot);
  if (!realpathSync(absolute).startsWith(`${realPublicRoot}${path.sep}`)) throw new Error("audio file escapes public/");
  return stat;
}

/** Read-only structural/provenance check. Pending slots are deliberate and need no media files. */
export function inspectAudioCatalog(catalog, { root = process.cwd(), requireReady = false, checkFiles = true } = {}) {
  const errors = [];
  const warnings = [];
  const issue = (at, message) => errors.push(`${at}: ${message}`);
  const result = { errors, warnings, counts: { assets: 0, ready: 0, pending: 0, cues: 0, profiles: 0 } };
  if (!record(catalog)) { issue("catalog", "expected an object"); return result; }
  if (catalog.version !== 1) issue("version", "unsupported catalog version (expected 1)");
  const tables = {};
  const fileSizes = new Map();
  for (const name of ["assets", "cues", "profiles"]) {
    const rows = catalog[name];
    const table = tables[name] = new Map();
    if (!Array.isArray(rows) || rows.length === 0) { issue(name, "expected a nonempty array"); continue; }
    result.counts[name] = rows.length;
    rows.forEach((row, index) => {
      const at = `${name}[${index}]`;
      if (!record(row)) { issue(at, "expected an object"); return; }
      if (typeof row.id !== "string" || !ID.test(row.id)) { issue(`${at}.id`, "expected a stable lowercase ID"); return; }
      if (table.has(row.id)) issue(`${at}.id`, `duplicate ID ${row.id}`);
      else table.set(row.id, row);
    });
  }
  const number = (row, field, at, min, max, integer = false) => {
    const value = row[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value))
      issue(`${at}.${field}`, `expected ${integer ? "an integer" : "a finite number"} from ${min} to ${max}`);
  };
  const references = (row, field, at, target) => {
    if (!Array.isArray(row[field]) || row[field].length === 0) { issue(`${at}.${field}`, "expected a nonempty reference array"); return; }
    const used = new Set();
    row[field].forEach((id, index) => {
      if (typeof id !== "string" || !target.has(id)) issue(`${at}.${field}[${index}]`, `unknown reference ${String(id)}`);
      if (used.has(id)) issue(`${at}.${field}[${index}]`, `duplicate reference ${String(id)}`);
      used.add(id);
    });
  };
  const source = (value, at) => {
    try {
      if (checkFiles) return inspectAudioFile(value, root).size;
      audioFilePath(value, root);
    }
    catch (error) { issue(at, error.code === "ENOENT" ? `audio file does not exist: ${value}` : error.message); }
  };

  for (const asset of tables.assets.values()) {
    const at = `asset ${asset.id}`;
    if (!["pending", "ready"].includes(asset.status)) { issue(`${at}.status`, "expected pending or ready"); continue; }
    result.counts[asset.status]++;
    if (asset.status === "pending") {
      if (asset.src !== null || asset.fallbackSrc !== undefined || asset.license !== null)
        issue(at, "pending assets must have src: null, license: null and no fallbackSrc; add provenance when marking ready");
      if (requireReady) issue(at, "asset is still pending (--require-ready)");
    } else {
      const sizes = [source(asset.src, `${at}.src`)];
      if (asset.fallbackSrc !== undefined) {
        sizes.push(source(asset.fallbackSrc, `${at}.fallbackSrc`));
        if (asset.fallbackSrc === asset.src) issue(`${at}.fallbackSrc`, "must differ from src");
      }
      fileSizes.set(asset.id, sizes);
      if (typeof asset.src === "string" && /\.(?:opus|ogg|webm)$/.test(asset.src)
        && (typeof asset.fallbackSrc !== "string" || !/\.(?:m4a|mp3|wav)$/.test(asset.fallbackSrc)))
        issue(`${at}.fallbackSrc`, "Opus/Ogg/WebM requires an AAC .m4a, .mp3 or .wav fallback");
      if (!record(asset.license)) issue(`${at}.license`, "ready assets require a complete provenance record");
      else {
        for (const field of LICENSE_FIELDS) if (!nonempty(asset.license[field])) issue(`${at}.license.${field}`, "required nonempty text");
        if (!httpUrl(asset.license.url)) issue(`${at}.license.url`, "expected an http(s) license URL without credentials");
        // Original user recordings can cite a preserved repository master instead of a public upload.
        const original = asset.license.sourceUrl;
        if (!httpUrl(original) && !(typeof original === "string" && /^art\/audio\/[a-zA-Z0-9/_\-.]+$/.test(original)
          && !original.split("/").some(segment => segment === ".." || segment === "." || !segment)))
          issue(`${at}.license.sourceUrl`, "expected an http(s) source URL or a local art/audio/ master path");
        const date = asset.license.acquiredAt;
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
          issue(`${at}.license.acquiredAt`, "expected a real YYYY-MM-DD acquisition date");
      }
    }
    if (asset.loopStart !== undefined) number(asset, "loopStart", at, 0, 600);
    if (asset.loopEnd !== undefined) {
      number(asset, "loopEnd", at, 0.001, 600);
      if (asset.loopEnd <= (asset.loopStart ?? 0)) issue(`${at}.loopEnd`, "must be later than loopStart");
    }
    if (asset.loopStart !== undefined && asset.loopEnd === undefined) issue(`${at}.loopEnd`, "required when loopStart is specified");
  }

  const referencedAssets = new Set();
  for (const cue of tables.cues.values()) {
    const at = `cue ${cue.id}`;
    if (!BUSES.has(cue.bus)) issue(`${at}.bus`, "unknown audio bus");
    if (!MODES.has(cue.mode)) issue(`${at}.mode`, "expected one-shot, loop or music");
    if ((cue.mode === "music") !== (cue.bus === "music")) issue(at, "music mode and music bus must be used together");
    if (cue.mode !== "one-shot" && cue.pitchVariation !== 0) issue(`${at}.pitchVariation`, "continuous sources must keep their original playback rate");
    references(cue, "assets", at, tables.assets);
    if (Array.isArray(cue.assets)) for (const id of cue.assets) referencedAssets.add(id);
    number(cue, "gainDb", at, -60, 0);
    number(cue, "priority", at, 0, 100, true);
    number(cue, "maxInstances", at, 1, 24, true);
    number(cue, "cooldownMs", at, 0, 600_000, true);
    number(cue, "pitchVariation", at, 0, 0.08);
    number(cue, "fadeMs", at, 0, 10_000, true);
    if (cue.mode === "music" && cue.maxInstances !== 1) issue(`${at}.maxInstances`, "music cues use one deck per cue (the mixer crossfades two cues)");
    if (cue.mode === "music" && Array.isArray(cue.assets)) for (const id of cue.assets) {
      const asset = tables.assets.get(id);
      if (asset && (asset.loopStart !== undefined || asset.loopEnd !== undefined)) issue(at, `streamed music ${id} loops the whole file; loop points only work for decoded effects`);
    }
    if (cue.mode !== "music" && Array.isArray(cue.assets)) for (const id of cue.assets) {
      if (fileSizes.get(id)?.some(size => size > 12 * 1024 * 1024)) issue(at, `decoded asset ${id} exceeds the 12 MiB download limit; trim/export a shorter effect or loop`);
    }
  }
  for (const profile of tables.profiles.values()) references(profile, "cues", `profile ${profile.id}`, tables.cues);
  for (const id of tables.assets.keys()) if (!referencedAssets.has(id)) warnings.push(`asset ${id}: not referenced by a cue`);
  return result;
}
