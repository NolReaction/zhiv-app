"""Original warm steam-whistle arrival call; no recordings or external samples.

Two gently detuned resonant chambers open under rising steam pressure, hold one
short chord, then lose pressure into a soft breath. This is a single arrival
gesture, not a repeating foghorn or an engine loop.
"""

import hashlib
import math

import numpy as np
from scipy import signal


def render(asset_id: str, sample_rate: int) -> tuple[np.ndarray, dict]:
    if asset_id != "ship.arrival.01":
        raise ValueError("Unknown steamship sound: " + asset_id)
    duration = 2.6
    t = np.arange(round(duration * sample_rate), dtype=np.float64) / sample_rate
    rng = np.random.default_rng(int.from_bytes(hashlib.sha256(asset_id.encode()).digest()[:8], "little"))
    attack = np.clip(t / .24, 0, 1)
    attack = attack * attack * (3 - 2 * attack)
    release = np.clip((2.34 - t) / .58, 0, 1)
    release = release * release * (3 - 2 * release)
    envelope = attack * release
    pressure = 1 - .026 * np.exp(-t / .16) + .0014 * np.sin(2 * math.pi * 3.7 * t)
    body = np.zeros(len(t), dtype=np.float64)
    for index, (frequency, level) in enumerate([(174.6, .72), (220.0, .43)]):
        for detune, weight in [(-.0012, .48), (.0012, .52)]:
            phase = 2 * math.pi * np.cumsum(frequency * (1 + detune) * pressure) / sample_rate
            for harmonic, amount in [(1, 1), (2, .31), (3, .13), (4, .055), (5, .018)]:
                body += level * weight * amount * np.sin(phase * harmonic + index * .37)
    # A soft steam bed keeps the call from reading as an electronic oscillator.
    noise = rng.standard_normal(len(t))
    air = signal.sosfilt(signal.butter(2, [170, 1900], btype="bandpass", fs=sample_rate, output="sos"), noise)
    air /= max(float(np.sqrt(np.mean(air * air))), 1e-9)
    audio = (body * (1 + .014 * np.sin(2 * math.pi * 6.2 * t)) + air * .055) * envelope
    # Quiet, short reflections impart a little body without a long ambient tail.
    for delay, gain in [(.043, .12), (.081, .045)]:
        offset = round(delay * sample_rate)
        audio[offset:] += audio[:-offset].copy() * gain
    audio = signal.sosfilt(signal.butter(2, 42, btype="highpass", fs=sample_rate, output="sos"), audio)
    audio *= np.sin(np.clip(t / .018, 0, 1) * math.pi / 2) ** 2
    audio *= np.sin(np.clip((duration - t) / .10, 0, 1) * math.pi / 2) ** 2
    audio[0] = audio[-1] = 0
    return audio.astype(np.float32), {
        "title": "Warm steamship arrival whistle",
        "description": "A single low two-chamber steam whistle, gently opening under pressure and fading into breath; no repeated foghorn or recordings.",
        "targetRmsDb": -20, "peakDb": -9,
        "fundamentalsHz": [174.6, 220.0], "durationSeconds": duration,
        "attackSeconds": .24, "releaseSeconds": .58,
        "method": "Deterministic additive resonators, seeded filtered steam noise, pressure envelope and two quiet early reflections",
    }
