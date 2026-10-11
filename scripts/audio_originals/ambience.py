"""Original deterministic forest and work ambience, generated without recordings.

The beds are periodic Fourier noise and every spot effect is added with circular
tail wrapping. Loops therefore retain their texture at the join instead of
fading to silence. Returned samples are float32; the exporter applies the
declared RMS/peak targets. All durations and event arrangements are authored here.
"""

from __future__ import annotations

import hashlib

import numpy as np
from scipy import signal


_SPECS = {
    "forest.day.01": (10.0, "Leaves in the Sun", "Soft leaf movement with five original, low-register bird phrases.", -23.0),
    "forest.night.01": (10.0, "The Forest Settles", "Quiet tree air and sparse, softened insect conversations.", -24.0),
    "weather.rain.01": (8.0, "Rain through the Canopy", "A sheltered rain bed with scattered, rounded leaf droplets.", -22.0),
    "river.01": (8.0, "Water around Roots", "Flowing water, low ripples and irregular resonant bubbles.", -21.5),
    "campfire.01": (8.0, "Small Evening Fire", "A warm rolling fire with restrained little twig crackles.", -23.0),
    "workshop.woodworking.01": (10.0, "The Carpenter's Afternoon", "Uneven wooden mallet taps, short hand-saw strokes and a quiet room bed.", -22.0),
    "workshop.kiln.01": (8.0, "Warm Kiln", "Enclosed low fire, two soft bellows breaths and light fuel movement.", -23.0),
    "quarry.working.01": (10.0, "Stone by Stone", "Low mineral knocks, small falling fragments and short gravel scrapes.", -22.0),
    "construction.working.01": (10.0, "A Home Taking Shape", "Grouped wooden hammering, a timber scrape and scattered saw strokes.", -22.0),
}


def _noise(count: int, rate: int, rng: np.random.Generator, low: float,
           high: float, slope: float = 0.0) -> np.ndarray:
    """Unit-RMS periodic noise with soft spectral shoulders and no DC."""
    frequencies = np.fft.rfftfreq(count, 1.0 / rate)
    safe = np.maximum(frequencies, 1.0)
    spectrum = rng.normal(size=len(safe)) + 1j * rng.normal(size=len(safe))
    # Eighth-order shoulders keep the soft ambience out of sub-bass and hiss.
    weight = 1.0 / np.sqrt(1.0 + (low / safe) ** 8)
    weight *= 1.0 / np.sqrt(1.0 + (safe / high) ** 8)
    weight *= (safe / np.sqrt(low * high)) ** slope
    spectrum *= weight
    spectrum[0] = 0.0
    spectrum[-1] = spectrum[-1].real
    samples = np.fft.irfft(spectrum, n=count)
    return samples / max(float(np.sqrt(np.mean(samples * samples))), 1e-12)


def _swell(count: int, cycles: int, phase: float, floor: float = 0.55) -> np.ndarray:
    """A seamless slow gain curve, with integer periods across the loop."""
    angle = np.arange(count, dtype=np.float64) * (2.0 * np.pi * cycles / count)
    return floor + (1.0 - floor) * (0.5 + 0.5 * np.sin(angle + phase))


def _window(count: int, attack: float = 0.08) -> np.ndarray:
    """Smooth finite event envelope; both boundaries have zero slope."""
    return signal.windows.tukey(count, alpha=min(1.0, max(0.01, attack * 2.0)))


def _add(destination: np.ndarray, event: np.ndarray, start: float,
         rate: int, gain: float = 1.0, pan: float = 0.0) -> None:
    """Add one event, wrapping every tail into the beginning of the loop."""
    indices = (np.arange(len(event)) + int(round(start * rate))) % len(destination)
    if destination.ndim == 1:
        np.add.at(destination, indices, event * gain)
    else:
        angle = (np.clip(pan, -1.0, 1.0) + 1.0) * np.pi / 4.0
        np.add.at(destination[:, 0], indices, event * gain * np.cos(angle))
        np.add.at(destination[:, 1], indices, event * gain * np.sin(angle))


def _air(count: int, rate: int, rng: np.random.Generator,
         stereo: bool = False, amount: float = 0.1) -> np.ndarray:
    """Tree air has separate low wind and leaf layers, without a pitched drone."""
    shared = _noise(count, rate, rng, 65, 450, -0.25) * _swell(count, 2, 0.3)
    channels = 2 if stereo else 1
    output = np.empty((count, channels), dtype=np.float64)
    for channel in range(channels):
        leaves = _noise(count, rate, rng, 380, 1750, -0.3)
        leaves *= _swell(count, 3 + channel, 1.1 + channel, 0.35)
        output[:, channel] = amount * (0.80 * shared + 0.24 * leaves)
    return output if stereo else output[:, 0]


def _bird(rate: int, rng: np.random.Generator, frequency: float,
          duration: float, upward: bool) -> np.ndarray:
    """A small invented bird syllable made from FM, breath and soft harmonics."""
    count = int(duration * rate)
    time = np.arange(count) / rate
    movement = np.sin(np.pi * time / duration)
    pitch = frequency * (1.0 + (0.18 if upward else -0.16) * movement)
    pitch += frequency * 0.009 * np.sin(2.0 * np.pi * 19.0 * time)
    phase = 2.0 * np.pi * np.cumsum(pitch) / rate
    tone = np.sin(phase) + 0.12 * np.sin(phase * 2.0 + 0.2)
    breath = _noise(count, rate, rng, 450, 2100) * 0.025
    envelope = np.maximum(0.0, np.sin(np.pi * np.arange(count) / (count - 1))) ** 1.8
    return (tone + breath) * envelope


def _impact(rate: int, rng: np.random.Generator, kind: str,
            frequency: float, duration: float = 0.3) -> np.ndarray:
    """Short damped modal impacts; wood and stone have different resonances."""
    count = int(rate * duration)
    time = np.arange(count) / rate
    if kind == "wood":
        ratios, amplitudes, decay = (1.0, 1.61, 2.73), (1.0, 0.43, 0.18), 0.038
    else:
        ratios, amplitudes, decay = (1.0, 2.39, 3.57), (0.65, 0.43, 0.19), 0.075
    event = np.zeros(count)
    for index, (ratio, amplitude) in enumerate(zip(ratios, amplitudes)):
        mode = np.sin(2.0 * np.pi * frequency * ratio * time)
        event += amplitude * mode * np.exp(-time / (decay / (1.0 + index * 0.8)))
    noise = _noise(count, rate, rng, 250, 2200 if kind == "stone" else 1400)
    event += noise * np.exp(-time / 0.013) * 0.30
    return event * (1.0 - np.exp(-time / 0.0009)) * _window(count, 0.02)


def _scrape(rate: int, rng: np.random.Generator, duration: float,
            low: float, high: float, rate_hz: float = 0.0) -> np.ndarray:
    """Friction noise, optionally pulsed like teeth passing through wood."""
    count = int(rate * duration)
    time = np.arange(count) / rate
    event = _noise(count, rate, rng, low, high, -0.2)
    if rate_hz:
        event *= 0.68 + 0.32 * np.sin(2.0 * np.pi * rate_hz * time)
    event *= np.maximum(0.0, np.sin(np.pi * np.arange(count) / (count - 1))) ** 1.35
    return event


def _bubble(rate: int, rng: np.random.Generator, frequency: float,
            duration: float) -> np.ndarray:
    """Rounded dispersive bubble with a falling pitch and a little water noise."""
    count = int(rate * duration)
    time = np.arange(count) / rate
    phase = 2.0 * np.pi * frequency * (time + 0.30 * duration * (1.0 - np.exp(-time / duration)))
    body = np.sin(phase) * np.exp(-time / (duration * 0.18))
    body += _noise(count, rate, rng, 150, 1500) * np.exp(-time / (duration * 0.10)) * 0.12
    return body * (1.0 - np.exp(-time / 0.003)) * _window(count, 0.04)


def _fire(count: int, rate: int, rng: np.random.Generator, enclosed: bool) -> np.ndarray:
    """Low flame movement plus small finite twig crackles, never a harsh roar."""
    duration = count / rate
    output = _noise(count, rate, rng, 55, 260, -0.1) * _swell(count, 3, 0.4) * 0.15
    output += _noise(count, rate, rng, 260, 950, -0.35) * _swell(count, 5, 2.2, 0.2) * 0.033
    for _ in range(24 if enclosed else 37):
        length = rng.uniform(0.018, 0.065)
        event = _scrape(rate, rng, length, 350, 1750 if enclosed else 2600)
        _add(output, event, rng.uniform(0, duration), rate, rng.uniform(0.025, 0.09))
    return output


def render(asset_id: str, sample_rate: int) -> tuple[np.ndarray, dict]:
    """Render one catalog ID at the requested sample rate with provenance labels.

    No files, sample libraries, external recordings or model weights are read.
    The hash seed keeps renders stable without depending on Python's hash salt.
    """
    if asset_id not in _SPECS:
        raise ValueError(f"Unknown original ambience: {asset_id}")
    if sample_rate < 8000:
        raise ValueError("sample_rate must be at least 8000 Hz")
    duration, title, description, rms_db = _SPECS[asset_id]
    seed = int.from_bytes(hashlib.sha256(asset_id.encode("utf-8")).digest()[:8], "little")
    rng = np.random.default_rng(seed)
    count = int(round(duration * sample_rate))

    if asset_id == "forest.day.01":
        output = _air(count, sample_rate, rng, stereo=True, amount=0.13)
        for index, start in enumerate((0.6, 2.35, 4.9, 7.6, 9.65)):
            pitch = (1050, 770, 1240, 920, 1080)[index]
            pan = (-0.55, 0.40, -0.20, 0.65, -0.45)[index]
            for syllable in range(2 if index % 2 else 3):
                event = _bird(sample_rate, rng, pitch * (1.0 + syllable * 0.06), 0.13 + syllable * 0.025, bool(index % 2))
                _add(output, event, start + syllable * 0.24, sample_rate, 0.034, pan)

    elif asset_id == "forest.night.01":
        output = _air(count, sample_rate, rng, stereo=True, amount=0.085)
        for index, start in enumerate((0.9, 3.4, 6.9, 9.55)):
            length = 0.75 + index * 0.09
            event_count = int(length * sample_rate)
            time = np.arange(event_count) / sample_rate
            insect = _noise(event_count, sample_rate, rng, 1550, 2700)
            pulses = (0.5 + 0.5 * np.sin(2.0 * np.pi * (11 + index) * time)) ** 4
            insect *= pulses * _window(event_count, 0.20)
            _add(output, insect, start, sample_rate, 0.019, (-1) ** index * 0.65)

    elif asset_id == "weather.rain.01":
        shared = _noise(count, sample_rate, rng, 120, 900, -0.1)
        output = np.empty((count, 2))
        for channel in range(2):
            veil = _noise(count, sample_rate, rng, 500, 2600, -0.35)
            output[:, channel] = (shared * 0.055 + veil * 0.075) * _swell(count, 2, 0.2, 0.8)
        for _ in range(230):
            drop = _bubble(sample_rate, rng, rng.uniform(380, 1050), rng.uniform(0.03, 0.09))
            _add(output, drop, rng.uniform(0, duration), sample_rate, rng.uniform(0.018, 0.065), rng.uniform(-0.9, 0.9))

    elif asset_id == "river.01":
        output = _noise(count, sample_rate, rng, 80, 550, -0.1) * _swell(count, 3, 0.4) * 0.10
        output += _noise(count, sample_rate, rng, 400, 1850, -0.1) * _swell(count, 5, 1.1, 0.55) * 0.07
        for _ in range(41):
            bubble = _bubble(sample_rate, rng, rng.uniform(130, 650), rng.uniform(0.09, 0.22))
            _add(output, bubble, rng.uniform(0, duration), sample_rate, rng.uniform(0.03, 0.10))
        for _ in range(20):
            splash = _scrape(sample_rate, rng, rng.uniform(0.2, 0.55), 500, 1850)
            _add(output, splash, rng.uniform(0, duration), sample_rate, 0.021)

    elif asset_id in ("campfire.01", "workshop.kiln.01"):
        enclosed = asset_id == "workshop.kiln.01"
        output = _fire(count, sample_rate, rng, enclosed)
        if enclosed:
            for start in (3.3, 6.5):
                breath = _scrape(sample_rate, rng, 1.25, 90, 750)
                _add(output, breath, start, sample_rate, 0.065)
            for start in (0.8, 5.6):
                _add(output, _impact(sample_rate, rng, "wood", 145, 0.25), start, sample_rate, 0.045)

    elif asset_id == "workshop.woodworking.01":
        output = _air(count, sample_rate, rng, amount=0.027)
        for index, start in enumerate((0.5, 1.12, 1.78, 3.6, 4.28, 6.7, 7.24, 7.93)):
            knock = _impact(sample_rate, rng, "wood", (185, 160, 213)[index % 3])
            _add(output, knock, start, sample_rate, 0.40 if index % 3 else 0.48)
        for start, length in ((2.3, 0.8), (4.9, 1.05), (8.55, 1.0)):
            saw = _scrape(sample_rate, rng, length, 240, 1400, 31.0)
            _add(output, saw, start, sample_rate, 0.050)

    elif asset_id == "quarry.working.01":
        output = _air(count, sample_rate, rng, amount=0.035)
        for index, start in enumerate((0.8, 2.1, 4.1, 5.7, 7.65, 9.4)):
            stone = _impact(sample_rate, rng, "stone", (240, 195, 285)[index % 3], 0.45)
            _add(output, stone, start, sample_rate, 0.36)
            for fragment in range(3):
                debris = _impact(sample_rate, rng, "stone", rng.uniform(350, 630), 0.16)
                _add(output, debris, start + 0.14 + fragment * 0.10, sample_rate, 0.038 / (1 + fragment * 0.5))
        for start in (3.0, 6.3, 9.8):
            _add(output, _scrape(sample_rate, rng, 0.9, 160, 1200), start, sample_rate, 0.040)

    else:  # construction.working.01
        output = _air(count, sample_rate, rng, amount=0.033)
        for start in (0.55, 3.6, 7.7):
            for hit, offset in enumerate((0.0, 0.37, 0.81)):
                hammer = _impact(sample_rate, rng, "wood", 210 + hit * 23, 0.24)
                _add(output, hammer, start + offset, sample_rate, 0.40 - hit * 0.04)
        _add(output, _scrape(sample_rate, rng, 1.3, 90, 850, 14.0), 2.1, sample_rate, 0.059)
        for start in (5.4, 6.2):
            _add(output, _scrape(sample_rate, rng, 0.64, 270, 1500, 38.0), start, sample_rate, 0.056)

    # Removing DC is safe for loops and keeps exporter normalization predictable.
    output -= np.mean(output, axis=0)
    peak = float(np.max(np.abs(output)))
    if peak > 0.70:
        output *= 0.70 / peak
    metadata = {
        "title": title,
        "description": description,
        "targetRmsDb": rms_db,
        "peakDb": -3.0,
    }
    return output.astype(np.float32), metadata
