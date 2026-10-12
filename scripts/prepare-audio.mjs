#!/usr/bin/env node
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const usage = `Usage: node scripts/prepare-audio.mjs --source <edited-master> --asset <catalog-id> --kind effect|loop|music [--mono] [--gain-db -6] [--dry-run]
Requires ffmpeg + ffprobe on PATH. Effects/loops: PCM WAV. Music: Opus + AAC fallback.
Creates new exports only; never overwrites originals or existing exports and never marks the catalog ready.
No automatic loudness normalization, noise reduction, loop editing or licensing decision is performed.`;
const root = fileURLToPath(new URL("..", import.meta.url));
let temporary = null;
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--mono", "--dry-run", "--help"].includes(arg)) options[arg] = true;
    else if (["--source", "--asset", "--kind", "--gain-db"].includes(arg) && args[index + 1] !== undefined) options[arg] = args[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (options["--help"]) console.log(usage);
  else {
    if (!options["--source"] || !options["--asset"] || !["effect", "loop", "music"].includes(options["--kind"])) throw new Error(usage);
    const source = path.resolve(options["--source"]);
    if (!lstatSync(source).isFile()) throw new Error("Source must be a regular file (not a symlink).");
    const assetId = options["--asset"];
    const kind = options["--kind"];
    const catalog = JSON.parse(readFileSync(path.join(root, "features/audio/catalog/audio-catalog.json"), "utf8"));
    const asset = catalog.assets.find(item => item.id === assetId);
    if (!asset || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(assetId)) throw new Error(`Unknown asset ID: ${assetId}`);
    if (asset.status !== "pending") throw new Error("Only pending slots can be prepared; add a new variant to replace a released recording.");
    const modes = new Set(catalog.cues.filter(cue => cue.assets.includes(assetId)).map(cue => cue.mode));
    if (!modes.size || [...modes].some(mode => mode !== (kind === "effect" ? "one-shot" : kind))) throw new Error(`The --kind ${kind} does not match this asset's catalog cues.`);
    const gain = options["--gain-db"] === undefined ? 0 : Number(options["--gain-db"]);
    if (!Number.isFinite(gain) || gain < -36 || gain > 0) throw new Error("--gain-db must be a finite attenuation from -36 to 0 dB.");
    const exports = kind === "music"
      ? [{ extension: "opus", codec: ["-c:a", "libopus", "-b:a", "128k", "-vbr", "on"] }, { extension: "m4a", codec: ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"] }]
      : [{ extension: "wav", codec: ["-c:a", "pcm_s16le"] }];
    const outputDirectory = path.join(root, "public/audio", kind);
    // Check each existing component before mkdir/copy: authoring must not write through symlinks.
    let current = root;
    for (const segment of ["public", "audio", kind]) {
      current = path.join(current, segment);
      if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) throw new Error(`Unsafe export directory: ${current}`);
    }
    for (const output of exports) {
      output.file = path.join(outputDirectory, `${assetId}.${output.extension}`);
      output.url = `/audio/${kind}/${assetId}.${output.extension}`;
      if (existsSync(output.file)) throw new Error(`Refusing to overwrite existing export: ${output.file}`);
    }
    const run = (command, commandArgs) => {
      const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 });
      if (result.error) throw new Error(`${command}: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`${command}: ${result.stderr.trim() || `exit ${result.status}`}`);
      return result.stdout;
    };
    const info = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type,channels,duration:format=duration", "-of", "json", source]));
    if (!info.streams?.length) throw new Error("Source contains no audio stream.");
    const duration = Number(info.format?.duration ?? info.streams[0].duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Source duration could not be verified.");
    if (duration > (kind === "music" ? 900 : 30)) throw new Error(kind === "music" ? "Trim music to at most 15 minutes." : "Trim decoded effects/loops to at most 30 seconds; short loops conserve mobile memory.");
    const channels = options["--mono"] ? 1 : Math.min(2, info.streams[0].channels ?? 2);
    console.log(`Preparing ${assetId}: ${duration.toFixed(2)} s, ${channels} channel(s), ${gain} dB attenuation.`);
    for (const output of exports) console.log(`${options["--dry-run"] ? "Would create" : "Export"}: ${output.url}`);
    if (!options["--dry-run"]) {
      temporary = mkdtempSync(path.join(tmpdir(), "zhiv-audio-export-"));
      for (const output of exports) {
        output.temporary = path.join(temporary, `${assetId}.${output.extension}`);
        run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", realpathSync(source), "-map", "0:a:0", "-vn", "-map_metadata", "-1",
          "-ar", "48000", "-ac", String(channels), ...(gain ? ["-af", `volume=${gain}dB`] : []), ...output.codec, output.temporary]);
      }
      mkdirSync(outputDirectory, { recursive: true });
      // All encoders succeeded before exposing a file in public/. COPYFILE_EXCL also prevents races.
      for (const output of exports) copyFileSync(output.temporary, output.file, constants.COPYFILE_EXCL);
      console.log("Original preserved. After listening and recording the license, set the catalog slot to ready:");
      console.log(JSON.stringify({ id: assetId, src: exports[0].url, ...(exports[1] ? { fallbackSrc: exports[1].url } : {}), status: "ready", license: "REQUIRED: supply the complete provenance record" }, null, 2));
    }
  }
} catch (error) {
  console.error(`Audio preparation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
