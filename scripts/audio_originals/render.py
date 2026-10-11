#!/usr/bin/env python3
"""Rebuild the original forest score and Foley from source; never edits the live catalog.

Python 3.11+, numpy, scipy and ffmpeg are authoring tools only. Runtime ships audio files.
Outputs lossless masters, browser exports, and a reproducible provenance/measurement manifest.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import wave

import numpy as np
import scipy

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_RATE = 48000
PACK = "originals-v1"
MODULES = {"music": "music.py", "loop": "ambience.py", "one-shot": "effects.py"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def measure(signal):
    peak = float(np.max(np.abs(signal)))
    rms = float(np.sqrt(np.mean(np.square(signal, dtype=np.float64))))
    return {
        "peakDb": round(20 * np.log10(max(peak, 1e-12)), 4),
        "rmsDb": round(20 * np.log10(max(rms, 1e-12)), 4),
        "dc": round(float(np.max(np.abs(np.mean(signal, axis=0)))), 9),
        "seamDelta": round(float(np.max(np.abs(signal[-1] - signal[0]))), 9),
        "maxAdjacentDelta": round(float(np.max(np.abs(np.diff(signal, axis=0)))), 9),
    }


def master(signal, info):
    signal = np.asarray(signal, dtype=np.float32)
    if signal.ndim == 1:
        signal = signal[:, None]
    if signal.ndim != 2 or signal.shape[1] not in (1, 2) or len(signal) < 96:
        raise ValueError("Renderer must return mono/stereo audio with at least 96 frames")
    if not np.isfinite(signal).all():
        raise ValueError("Renderer returned non-finite samples")
    signal -= np.mean(signal, axis=0, dtype=np.float64).astype(np.float32)
    peak = float(np.max(np.abs(signal)))
    rms = float(np.sqrt(np.mean(np.square(signal, dtype=np.float64))))
    if peak < 1e-7 or rms < 1e-8:
        raise ValueError("Renderer returned silence")
    # Respect dynamics: whichever ceiling is reached first wins. No hard clipping or brickwall gain.
    target = 10 ** (float(info.get("targetRmsDb", -20)) / 20)
    ceiling = 10 ** (min(-2, float(info.get("peakDb", -3))) / 20)
    signal *= min(target / rms, ceiling / peak)
    return signal


def write_wav(path, signal, seed):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Deterministic TPDF dither; no random generator shared between variants.
    rng = np.random.default_rng(seed)
    dither = (rng.random(signal.shape) - rng.random(signal.shape)) / 32768
    pcm = np.rint(np.clip(signal + dither, -1, 32767 / 32768) * 32768).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(signal.shape[1])
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())


def encode(source, destination, codec):
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
               "-i", str(source), "-map", "0:a:0", "-vn", "-map_metadata", "-1"]
    command += (["-c:a", "libopus", "-b:a", "112k", "-vbr", "on"] if codec == "opus"
                else ["-c:a", "aac", "-b:a", "144k", "-movflags", "+faststart"])
    subprocess.run(command + [str(destination)], check=True, capture_output=True, timeout=120)


def render_all(args):
    # Imports are deferred so --help works without importing instrument definitions.
    import music
    import ambience
    import effects

    out = Path(args.output_dir).resolve()
    if out == ROOT or out == ROOT / "public" or ROOT / "public" in out.parents:
        raise ValueError("Render into a staging folder, not the live public directory")
    catalog = json.loads((ROOT / "features/audio/catalog/audio-catalog.json").read_text())
    mode_by_id = {asset: cue["mode"] for cue in catalog["cues"] for asset in cue["assets"]}
    ids = [asset["id"] for asset in catalog["assets"] if not args.asset or asset["id"] in args.asset]
    if args.asset and set(args.asset) != set(ids):
        raise ValueError("Unknown asset ID requested")
    renderers = {"music": music.render, "loop": ambience.render, "one-shot": effects.render}
    # Refuse collisions before doing work. Versioned exports must not silently overwrite a released pack.
    destinations = [out / "manifest.json"]
    for asset_id in ids:
        kind = "effect" if mode_by_id[asset_id] == "one-shot" else mode_by_id[asset_id]
        destinations.append(out / "masters" / (asset_id + ".wav"))
        for extension in (["opus", "m4a"] if kind == "music" else ["wav"]):
            destinations.append(out / "public/audio" / PACK / kind / (asset_id + "." + extension))
    if any(path.exists() for path in destinations):
        raise ValueError("Output already exists; use a new --output-dir to compare a revision")

    records = []
    for index, asset_id in enumerate(ids):
        mode = mode_by_id[asset_id]
        kind = "effect" if mode == "one-shot" else mode
        signal, info = renderers[mode](asset_id, SAMPLE_RATE)
        signal = master(signal, info)
        duration = len(signal) / SAMPLE_RATE
        if duration > (900 if mode == "music" else 30):
            raise ValueError("Audio exceeds runtime duration budget: " + asset_id)
        measurements = measure(signal)
        if mode == "loop" and measurements["seamDelta"] > max(.003, measurements["maxAdjacentDelta"] * 2):
            raise ValueError("Discontinuous loop boundary: " + asset_id)
        seed = int.from_bytes(hashlib.sha256(asset_id.encode()).digest()[:8], "little")
        source = out / "masters" / (asset_id + ".wav")
        write_wav(source, signal, seed)
        files = []
        for extension in (["opus", "m4a"] if mode == "music" else ["wav"]):
            url = f"/audio/{PACK}/{kind}/{asset_id}.{extension}"
            output = out / "public" / url.lstrip("/")
            if extension == "wav":
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, output)
            else:
                encode(source, output, extension)
            files.append({"src": url, "bytes": output.stat().st_size, "sha256": digest(output)})
        records.append({
            "id": asset_id, "kind": kind, "title": info["title"], "description": info["description"],
            "sampleRate": SAMPLE_RATE, "channels": signal.shape[1], "frames": len(signal),
            "durationSeconds": round(duration, 6), "decodedBytes": len(signal) * signal.shape[1] * 4,
            "masterSha256": digest(source), "measurements": measurements, "files": files,
            "composition": {key: value for key, value in info.items()
                            if key not in ("title", "description", "targetRmsDb", "peakDb")},
        })
        print(f"[{index + 1}/{len(ids)}] {asset_id}: {duration:.2f}s, {signal.shape[1]}ch, "
              f"peak {measurements['peakDb']:.1f}, RMS {measurements['rmsDb']:.1f} dBFS", flush=True)
        del signal
    source_files = sorted(Path(__file__).parent.glob("*.py"))
    report = {
        "schemaVersion": 1, "pack": PACK, "createdAt": "2026-10-11",
        "origin": "Original procedural synthesis and scores generated with Codex for Я живой; no external samples or recordings",
        "toolchain": {"python": sys.version.split()[0], "numpy": np.__version__, "scipy": scipy.__version__,
                      "ffmpeg": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]},
        "sources": [{"path": str(path.relative_to(ROOT)), "sha256": digest(path)} for path in source_files],
        "assets": records,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    total = sum(file["bytes"] for item in records for file in item["files"])
    print(f"Rendered {len(records)} assets; exports {total / 1024 ** 2:.2f} MiB. Staging: {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default=str(ROOT / "work/audio-originals-v1"))
    parser.add_argument("--asset", action="append", help="Render only this catalog ID (repeatable)")
    options = parser.parse_args()
    try:
        render_all(options)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print("Original audio render failed: " + str(error), file=sys.stderr)
        sys.exit(1)
