"""Original instrumental scores for Мохлик, composed for this repository.

No recordings, soundfonts, downloaded loops, trained audio models, or quoted
melodies are used. All oscillators, instrumental envelopes and the two scores
below are authored here. These are deliberately quiet background arrangements:
an intimate wooden harp, breathy flute, soft string-like pad and rounded bass.

Edit DAY_CHORDS / NIGHT_CHORDS to change harmony. Each chord covers one 4/4 bar.
Melody events are (beat within the bar, scientific pitch name, length in beats).
The 32-bar form is A (8 bars), A' (8), B (8), A'' (8); pauses are intentional.
Change BPM in render() to change pace. Instrument levels live in _arrange().
Notes and the room return wrap around the exact musical period, so the stored
audio is one continuous musical loop with no extra tail or silent fade-out.

Public API: render(asset_id, sample_rate) -> (float32 stereo array, metadata).
The caller owns final mastering, loudness normalization and delivery codecs.
"""

from __future__ import annotations

import hashlib
import math

import numpy as np
from scipy.signal import butter, sosfilt


# Closed voicings intentionally omit low thirds; the bass supplies the root.
# This keeps the texture open on phone speakers and leaves room for world SFX.
DAY_CHORDS = (
    ("D2", ("F#3", "A3", "D4", "E4")),
    ("A2", ("E3", "A3", "B3", "C#4")),
    ("B2", ("F#3", "A3", "B3", "D4")),
    ("G2", ("F#3", "A3", "B3", "D4")),
    ("F#2", ("F#3", "A3", "D4", "E4")),
    ("E2", ("G3", "B3", "D4", "F#4")),
    ("G2", ("G3", "A3", "B3", "D4")),
    ("A2", ("E3", "A3", "B3", "D4")),
)

DAY_BRIDGE_CHORDS = (
    ("G2", ("G3", "B3", "D4", "F#4")),
    ("D2", ("F#3", "A3", "D4", "E4")),
    ("E2", ("G3", "B3", "D4", "F#4")),
    ("B2", ("F#3", "A3", "B3", "D4")),
    ("G2", ("G3", "B3", "D4", "F#4")),
    ("D2", ("F#3", "A3", "D4", "E4")),
    ("E2", ("G3", "B3", "D4", "F#4")),
    ("A2", ("E3", "A3", "B3", "C#4")),
)

NIGHT_CHORDS = (
    ("B2", ("F#3", "A3", "C#4", "D4")),
    ("G2", ("F#3", "B3", "D4", "A4")),
    ("D2", ("F#3", "A3", "D4", "E4")),
    ("A2", ("E3", "A3", "B3", "C#4")),
    ("E2", ("G3", "B3", "D4", "F#4")),
    ("G2", ("G3", "B3", "D4", "F#4")),
    ("F#2", ("F#3", "A3", "C#4", "E4")),
    ("B2", ("F#3", "B3", "D4", "F#4")),
)

# Five-note rising/falling seed: D–F#–E–A–F#. The later phrases answer it;
# they are written notes rather than a random melody or an endless arpeggio.
DAY_THEME = (
    ((0.25, "D5", 0.75), (1.25, "F#5", 0.5), (2, "E5", 0.75), (3, "A4", 0.75)),
    ((0.5, "C#5", 1), (2, "B4", 0.5), (2.75, "A4", 0.75)),
    ((0.25, "F#5", 1), (1.75, "D5", 0.5), (2.5, "B4", 1)),
    ((0.5, "A4", 0.75), (1.5, "B4", 0.5), (2.5, "D5", 1)),
    ((0.25, "F#5", 0.75), (1.25, "E5", 0.5), (2, "D5", 1.5)),
    ((0.5, "B4", 0.75), (1.5, "D5", 0.5), (2.5, "E5", 0.75)),
    ((0.25, "D5", 1), (1.75, "B4", 0.5), (2.5, "A4", 1)),
    ((0.5, "B4", 0.75), (1.5, "A4", 1.5)),
)

DAY_BRIDGE = (
    ((0.5, "B4", 0.5), (1.25, "D5", 0.5), (2, "F#5", 1.25)),
    ((0.25, "E5", 0.75), (1.5, "D5", 1.5)),
    ((0.5, "G5", 0.5), (1.25, "F#5", 0.5), (2, "E5", 1.25)),
    ((0.5, "D5", 0.75), (1.5, "C#5", 0.5), (2.5, "B4", 1)),
    ((0.25, "D5", 0.75), (1.25, "F#5", 0.75), (2.5, "B5", 0.75)),
    ((0.5, "A5", 0.75), (1.5, "F#5", 0.5), (2.25, "E5", 1)),
    ((0.25, "G5", 0.75), (1.25, "F#5", 0.5), (2.25, "E5", 1)),
    ((0.5, "C#5", 0.75), (1.5, "B4", 0.5), (2.5, "A4", 1)),
)

# A quieter relative-minor answer to the daytime theme. Long empty portions
# are part of the score, giving a night ambience and nearby objects space.
NIGHT_THEME = (
    ((0.5, "D5", 1.25), (2.5, "F#5", 0.75)),
    ((1, "D5", 1.25),),
    ((0.5, "E5", 1), (2, "F#5", 1)),
    ((0.75, "C#5", 1.75),),
    ((0.5, "B4", 1), (2.25, "D5", 1)),
    ((1, "B4", 1.5),),
    ((0.5, "A4", 1), (2.25, "C#5", 1)),
    ((0.5, "B4", 2),),
)

NIGHT_BRIDGE = (
    ((0.5, "F#5", 1), (2.25, "D5", 1)),
    ((0.75, "B4", 1), (2.5, "A4", 0.75)),
    ((0.5, "D5", 1.25), (2.5, "E5", 0.75)),
    ((1, "C#5", 1.75),),
    ((0.5, "G5", 1), (2, "F#5", 1)),
    ((0.5, "D5", 1), (2.25, "B4", 1)),
    ((0.75, "C#5", 1), (2.5, "E5", 0.75)),
    ((0.5, "D5", 1), (2, "B4", 1.5)),
)


def _midi(note: str) -> int:
    semitones = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    accidental = 1 if "#" in note else (-1 if "b" in note else 0)
    return 12 * (int(note[-1]) + 1) + semitones[note[0]] + accidental


def _frequency(note: str, cents: float = 0) -> float:
    return 440.0 * 2 ** ((_midi(note) - 69 + cents / 100) / 12)


def _smooth_gate(t: np.ndarray, held: float, attack: float, release: float) -> np.ndarray:
    rise = np.clip(t / attack, 0, 1)
    rise = rise * rise * (3 - 2 * rise)
    fall = np.clip((held + release - t) / release, 0, 1)
    fall = fall * fall * (3 - 2 * fall)
    return rise * fall


def _time(length: float, sr: int) -> np.ndarray:
    return np.arange(max(1, round(length * sr)), dtype=np.float32) / sr


def _lowpass(signal: np.ndarray, cutoff: float, sr: int) -> np.ndarray:
    return sosfilt(butter(2, min(cutoff, sr * 0.43), fs=sr, output="sos"), signal).astype(np.float32)


def _pluck(note: str, held: float, sr: int, rng: np.random.Generator, soft: bool = False) -> np.ndarray:
    """A pair of lightly inharmonic strings with a quiet wooden body transient."""
    length = max(2.5, held + 2.2)
    t = _time(length, sr)
    frequency = _frequency(note, rng.uniform(-2.8, 2.8))
    decay = 0.88 if soft else 0.70
    signal = np.zeros_like(t)
    # Upper modes die quickly instead of the metallic, sustained sine stack
    # commonly produced by generic synthetic "harp" patches.
    for harmonic, level in ((1, 0.74), (2, 0.18), (3, 0.105), (4, 0.052), (5, 0.024), (6, 0.012)):
        mode = frequency * harmonic * math.sqrt(1 + 0.000075 * harmonic * harmonic)
        if mode > sr * 0.44:
            continue
        damping = np.exp(-t * (decay + harmonic ** 1.12 * 0.50))
        phase = 2 * np.pi * mode * t
        signal += level * damping * (
            np.sin(phase) + 0.18 * np.sin(phase * 1.0009 + 0.45)
        )
    body = _lowpass(rng.standard_normal(t.size).astype(np.float32), 1500, sr)
    signal += body * np.exp(-t * 65) * (0.045 if soft else 0.075)
    attack = 1 - np.exp(-t * (210 if soft else 340))
    signal *= attack * np.minimum(1, np.maximum(0, (length - t) / 0.12))
    return signal.astype(np.float32)


def _flute(note: str, held: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    release = 0.23
    t = _time(held + release, sr)
    frequency = _frequency(note, rng.uniform(-3, 3))
    # Vibrato grows after the breath attack; integrate its frequency offset
    # so phase stays continuous and the sound does not contain FM clicks.
    vibrato = 0.0019 * np.sin(2 * np.pi * 4.65 * t + rng.uniform(0, 6.28))
    vibrato *= 1 - np.exp(-t * 3)
    slow_drift = 0.0006 * np.sin(2 * np.pi * 0.8 * t)
    phase = np.cumsum((1 + vibrato + slow_drift).astype(np.float64)) * (2 * np.pi * frequency / sr)
    signal = (np.sin(phase) + 0.105 * np.sin(2 * phase + 0.3) + 0.025 * np.sin(3 * phase)).astype(np.float32)
    breath = _lowpass(rng.standard_normal(t.size).astype(np.float32), 2500, sr)
    signal += breath * 0.033
    envelope = _smooth_gate(t, held, min(0.17, held * 0.2), release)
    envelope *= 0.90 + 0.10 * np.sin(np.pi * np.clip(t / max(0.1, held), 0, 1))
    return signal * envelope


def _pad(note: str, held: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    release = 1.55
    t = _time(held + release, sr)
    frequency = _frequency(note, rng.uniform(-2, 2))
    phases = rng.uniform(0, 2 * np.pi, 3)
    signal = np.zeros_like(t)
    for detune, phase in zip((-0.0013, 0, 0.0017), phases):
        carrier = 2 * np.pi * frequency * (1 + detune) * t + phase
        signal += (np.sin(carrier) + 0.105 * np.sin(2 * carrier) + 0.032 * np.sin(3 * carrier)) / 3
    swell = 0.87 + 0.13 * np.sin(np.pi * np.clip(t / held, 0, 1))
    return signal * _smooth_gate(t, held, 0.85, release) * swell


def _bass(note: str, held: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    release = 0.50
    t = _time(held + release, sr)
    frequency = _frequency(note, rng.uniform(-1.5, 1.5))
    phase = 2 * np.pi * frequency * t
    signal = np.sin(phase) + 0.24 * np.sin(2 * phase) + 0.035 * np.sin(3 * phase)
    envelope = _smooth_gate(t, held, 0.045, release) * np.exp(-0.30 * t)
    return (signal * envelope).astype(np.float32)


def _wood_tap(sr: int, rng: np.random.Generator, soft: bool) -> np.ndarray:
    t = _time(0.21, sr)
    frequency = rng.uniform(330, 380)
    signal = np.sin(2 * np.pi * frequency * t) * np.exp(-t * 59)
    signal += 0.32 * np.sin(2 * np.pi * frequency * 1.63 * t) * np.exp(-t * 83)
    signal += rng.standard_normal(t.size).astype(np.float32) * np.exp(-t * 110) * 0.12
    signal *= 1 - np.exp(-t * 950)
    return signal.astype(np.float32) * (0.6 if soft else 1)


def _add_circular(bus: np.ndarray, signal: np.ndarray, start: float, sr: int, gain: float, pan: float) -> None:
    """Equal-power stereo panning, with all note tails crossing the loop boundary."""
    offset = round(start * sr) % len(bus)
    gains = (math.cos((pan + 1) * np.pi / 4) * gain, math.sin((pan + 1) * np.pi / 4) * gain)
    consumed = 0
    while consumed < len(signal):
        count = min(len(bus) - offset, len(signal) - consumed)
        part = signal[consumed:consumed + count]
        for channel in (0, 1):
            bus[offset:offset + count, channel] += part * gains[channel]
        consumed += count
        offset = 0


def _room(send: np.ndarray, sr: int) -> np.ndarray:
    """Diffuse circular multi-tap room; no huge convolution or transient reset."""
    result = np.zeros_like(send)
    # Filtering two periods' short prefix establishes the low-pass state at
    # the seam. This avoids resetting the room's damper at sample zero.
    prefix = min(sr, len(send))
    source = np.empty_like(send)
    for channel in (0, 1):
        extended = np.concatenate((send[-prefix:, channel], send[:, channel]))
        source[:, channel] = _lowpass(extended, 3200, sr)[prefix:]
    for seconds, amount, swap in (
        (0.047, 0.20, False), (0.079, 0.18, True), (0.131, 0.15, False),
        (0.193, 0.12, True), (0.277, 0.105, False), (0.383, 0.089, True),
        (0.523, 0.073, False), (0.719, 0.061, True), (0.947, 0.045, False),
        (1.213, 0.033, True), (1.537, 0.023, False), (1.913, 0.015, True),
    ):
        delay = round(seconds * sr) % len(send)
        for channel in (0, 1):
            origin = source[:, 1 - channel if swap else channel]
            result[delay:, channel] += origin[:-delay] * amount
            result[:delay, channel] += origin[-delay:] * amount
    return result


def _arrange(night: bool, bpm: int, sr: int, rng: np.random.Generator) -> np.ndarray:
    beat = 60 / bpm
    bar_duration = 4 * beat
    mix = np.zeros((round(32 * bar_duration * sr), 2), dtype=np.float32)
    send = np.zeros_like(mix)

    def play(instrument, note: str, start: float, held: float, gain: float, pan: float, wet: float = 0.36):
        waveform = instrument(note, held, sr, rng)
        _add_circular(mix, waveform, start, sr, gain, pan)
        _add_circular(send, waveform, start, sr, gain * wet, pan)

    for bar in range(32):
        section, phrase_bar = divmod(bar, 8)
        start = bar * bar_duration
        if night:
            bass_note, voicing = NIGHT_CHORDS[phrase_bar]
            theme = NIGHT_BRIDGE if section == 2 else NIGHT_THEME
        else:
            bass_note, voicing = (DAY_BRIDGE_CHORDS if section == 2 else DAY_CHORDS)[phrase_bar]
            theme = DAY_BRIDGE if section == 2 else DAY_THEME

        # Phrase breath is gently shaped over eight bars; there is no constant
        # random volume wobble. B opens out and the final A settles back down.
        arc = (0.90, 0.95, 1.00, 0.93, 1.03, 1.00, 0.94, 0.82)[phrase_bar]
        section_gain = (0.92, 0.99, 1.06, 0.92)[section]
        expression = arc * section_gain

        for voice, pitch in enumerate(voicing):
            play(_pad, pitch, start - 0.18, bar_duration - 0.38,
                 (0.027 if night else 0.022) * expression,
                 (-0.55, 0.40, -0.25, 0.62)[voice], 0.55)

        play(_bass, bass_note, start + 0.006, beat * (2.5 if night else 2.0),
             0.070 if night else 0.078, 0, 0.13)
        if not night and phrase_bar in (1, 2, 4, 5):
            play(_bass, bass_note, start + 2.5 * beat, beat * 0.82, 0.039, 0, 0.10)

        # Finger-picked accompaniment alternates two patterns, with an empty
        # last beat at cadences and an especially sparse first night section.
        arp_beats = (0.12, 1.5, 2.75) if night else (0.10, 0.75, 1.5, 2.0, 2.75, 3.5)
        pattern = (0, 2, 1, 3, 2, 1) if bar % 2 == 0 else (0, 1, 3, 2, 1, 3)
        for index, position in enumerate(arp_beats):
            if phrase_bar == 7 and position > 2.5:
                continue
            if night and section == 0 and index == 1:
                continue
            pitch = voicing[pattern[index]]
            play(_pluck, pitch, start + position * beat + rng.uniform(-0.014, 0.014),
                 beat * 0.9, (0.090 if night else 0.083) * expression * rng.uniform(0.87, 1.04),
                 -0.35 + index * 0.095, 0.46)

        # Instruments take turns singing the theme. The opening stays small;
        # the flute joins as an answer, then takes the contrasting B section.
        use_flute = (section in (1, 2) and phrase_bar not in (3, 7)) or (not night and section == 3 and phrase_bar < 4)
        melody_instrument = _flute if use_flute else _pluck
        melody_level = (0.089 if night else 0.097) if use_flute else (0.115 if night else 0.137)
        for index, (position, pitch, length) in enumerate(theme[phrase_bar]):
            if night and section == 0 and phrase_bar in (3, 7):
                continue
            # Reprise ends on the tonic, with a long answer rather than an
            # unresolved run. Its resonance becomes the next loop's opening.
            if section == 3 and phrase_bar == 7:
                if index > 0:
                    continue
                pitch, position, length = ("B4" if night else "D5"), 0.5, 2.5
            play(melody_instrument, pitch, start + position * beat + rng.uniform(-0.009, 0.009),
                 length * beat, melody_level * expression * rng.uniform(0.92, 1.04),
                 0.15 if use_flute else 0.23, 0.60 if night else 0.46)

        # A small lower-register response fills selected rests. It never runs
        # beneath an active flute phrase and does not play in the first A.
        if section in (1, 3) and phrase_bar in (1, 3, 5) and not use_flute:
            play(_pluck, voicing[2], start + 3.15 * beat, beat * 0.75,
                 0.060 if night else 0.078, -0.30, 0.56)

        # Organic taps are barely audible accents, not a dance drum pattern.
        if not night and section != 0 and phrase_bar not in (3, 7):
            for accent in (1.0, 3.0):
                waveform = _wood_tap(sr, rng, soft=section == 3)
                _add_circular(mix, waveform, start + accent * beat + rng.uniform(-0.015, 0.015), sr, 0.030, -0.28)
                _add_circular(send, waveform, start + accent * beat, sr, 0.010, -0.28)

    mix += _room(send, sr)
    # Remove energy that tiny speakers cannot reproduce. The wrapped prefix
    # gives the filter the same history it has during continuous playback.
    prefix = min(sr, len(mix))
    highpass = butter(2, 36, "highpass", fs=sr, output="sos")
    for channel in (0, 1):
        extended = np.concatenate((mix[-prefix:, channel], mix[:, channel]))
        mix[:, channel] = sosfilt(highpass, extended)[prefix:].astype(np.float32)
    return mix


def render(asset_id: str, sample_rate: int = 48000) -> tuple[np.ndarray, dict]:
    """Render one of two complete original music loops, deterministically."""
    if asset_id not in ("music.day.01", "music.night.01"):
        raise ValueError(f"Unknown original music asset: {asset_id}")
    if not isinstance(sample_rate, int) or sample_rate < 8000 or sample_rate > 192000:
        raise ValueError("sample_rate must be an integer between 8000 and 192000")
    night = asset_id == "music.night.01"
    seed = int.from_bytes(hashlib.sha256(("zhiv-original-score-v1:" + asset_id).encode()).digest()[:8], "little")
    rng = np.random.default_rng(seed)
    bpm = 62 if night else 72
    samples = _arrange(night, bpm, sample_rate, rng)
    return samples, {
        "title": "Фонарь среди листьев" if night else "Тропинка к дому",
        "description": (
            "Оригинальная ночная миниатюра: редкие щипки деревянной арфы, дыхание флейты, тёплая подложка; 32 такта A–A′–B–A″."
            if night else
            "Оригинальная дневная тема: деревянная арфа, отвечающая флейта, мягкий бас и редкие деревянные акценты; 32 такта A–A′–B–A″."
        ),
        "targetRmsDb": -20 if night else -18,
        "peakDb": -2,
        "musicalKey": "B minor / D major" if night else "D major",
        "bpm": bpm,
        "bars": 32,
        "meter": "4/4",
        "loop": True,
        "provenance": "Original coded score and deterministic mathematical synthesis; no external recordings or samples.",
    }
