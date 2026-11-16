"""Original riverside acoustic groove: 4/4 nylon/marimba score, no samples."""
import hashlib
import numpy as np
from music import _add_circular, _bass, _frequency, _lowpass, _room, _time

# A completely separate score/timbre from the former F-major river waltz.
CHORDS = (
    ("G2", ("G3", "B3", "D4", "A4")),
    ("E2", ("G3", "B3", "D4", "E4")),
    ("C3", ("G3", "B3", "C4", "E4")),
    ("D3", ("A3", "D4", "E4", "F#4")),
    ("A2", ("G3", "A3", "C4", "E4")),
    ("C3", ("G3", "B3", "C4", "E4")),
    ("B2", ("G3", "B3", "D4", "G4")),
    ("D3", ("A3", "C4", "D4", "F#4")),
)
BRIDGE_CHORDS = (CHORDS[2], CHORDS[0], CHORDS[1], CHORDS[3], CHORDS[4], CHORDS[2], CHORDS[0], CHORDS[3])
THEME = (
    ((.5, "B4", .5), (1.5, "D5", .75), (3, "A4", .5)),
    ((.25, "G4", .75), (1.75, "B4", .5), (2.75, "E5", .75)),
    ((.5, "D5", .5), (1.5, "E5", 1), (3, "B4", .5)),
    ((.25, "A4", .75), (1.75, "F#4", .5), (3, "D5", .5)),
    ((.5, "E5", .5), (1.5, "D5", .5), (2.75, "B4", .75)),
    ((.25, "G4", .75), (2, "A4", .5), (3, "E5", .5)),
    ((.5, "D5", .75), (2, "B4", .5), (3, "G4", .5)),
    ((.5, "A4", .5), (1.5, "F#4", .5), (2.5, "D4", .75)),
)
ANSWER = (
    ((.25, "G5", .75), (1.75, "E5", .75), (3, "D5", .5)),
    ((.5, "B4", .5), (1.5, "D5", .5), (2.5, "G5", 1)),
    ((.25, "E5", .75), (1.75, "B4", .75)),
    ((.5, "A4", .5), (1.5, "D5", .5), (3, "F#5", .5)),
    ((.25, "E5", .75), (1.75, "D5", .5), (2.75, "C5", .75)),
    ((.5, "B4", .5), (1.5, "A4", .5), (2.5, "G4", 1)),
    ((.5, "B4", .75), (2, "D5", 1)),
    ((.25, "E5", .5), (1.25, "D5", .5), (2.25, "A4", 1)),
)


def _nylon(note, held, sr, rng):
    """Soft bridge pluck with independently damped string/body modes."""
    length = max(1.7, held + .9)
    t = _time(length, sr)
    f = _frequency(note, rng.uniform(-1.8, 1.8))
    signal = np.zeros_like(t)
    for partial in range(1, 10):
        # Plucking nearer the middle reduces brittle high harmonics.
        level = np.sin(partial * np.pi * .31) / partial ** 1.55
        signal += level * np.sin(2 * np.pi * f * partial * t) * np.exp(-t * (1.7 + partial * .73))
    body = _lowpass(rng.standard_normal(t.size).astype(np.float32), 1050, sr)
    signal += .06 * body * np.exp(-t * 95)
    signal *= (1 - np.exp(-t * 600)) * np.clip((length - t) / .08, 0, 1)
    return signal


def _marimba(note, held, sr, rng):
    """Mellow wooden bar: short inharmonic modes, no ringing bell tail."""
    t = _time(max(1.2, held + .45), sr)
    f = _frequency(note, rng.uniform(-.7, .7))
    signal = np.zeros_like(t)
    for ratio, gain, decay in ((1, .9, 3.2), (3.98, .13, 13), (9.95, .025, 28)):
        signal += gain * np.sin(2 * np.pi * f * ratio * t) * np.exp(-t * decay)
    return signal * (1 - np.exp(-t * 950)) * np.clip((t[-1] - t) / .08, 0, 1)


def _brush(sr, rng, long=False):
    t = _time(.24 if long else .065, sr)
    noise = rng.standard_normal(t.size).astype(np.float32)
    # A band-limited soft brush, with no sharp clap or high-frequency hiss.
    band = _lowpass(noise, 3600, sr) - _lowpass(noise, 900, sr)
    envelope = np.maximum(0, np.sin(np.pi * np.clip(t / t[-1], 0, 1))) ** 1.8
    return band * envelope * (.28 if long else .16)


def render(sample_rate=48000):
    rng = np.random.default_rng(int.from_bytes(hashlib.sha256(b"zhiv-light-bite-acoustic-v2").digest()[:8], "little"))
    beat, bars = 60 / 76, 24
    mix = np.zeros((round(bars * 4 * beat * sample_rate), 2), dtype=np.float32)
    send = np.zeros_like(mix)

    def play(instrument, note, start, held, gain, pan, wet=.14):
        signal = instrument(note, held, sample_rate, rng)
        _add_circular(mix, signal, start, sample_rate, gain, pan)
        _add_circular(send, signal, start, sample_rate, gain * wet, pan)

    for bar in range(bars):
        section, index = divmod(bar, 8)
        root, chord = (BRIDGE_CHORDS if section == 1 else CHORDS)[index]
        start = bar * 4 * beat
        expression = (.94, .86, .92, .82, .94, .86, .9, .72)[index]
        play(_bass, root, start, beat * .65, .08 * expression, -.02, .08)
        play(_bass, root, start + 2.5 * beat, beat * .45, .043, .04, .08)
        for pick, position in enumerate((.0, .75, 1.5, 2, 2.75, 3.5)):
            if index == 7 and pick > 3:
                continue
            play(_nylon, chord[(0, 2, 1, 3, 2, 1)[pick]], start + position * beat,
                 .6 * beat, .105 * expression, -.28 + pick * .07)
        melody = ANSWER if section == 1 else THEME
        for position, pitch, held in melody[index]:
            play(_marimba if section != 2 else _nylon, pitch, start + position * beat,
                 held * beat, .095 if section != 2 else .17, .18, .2)
        # A quiet brushed backbeat and sparse offbeat shaker provide motion,
        # leaving the bobber/catch effects in the foreground.
        for position in (1, 3):
            _add_circular(mix, _brush(sample_rate, rng, True), start + position * beat, sample_rate, .017, .12)
        for position in (.5, 1.5, 2.5, 3.5):
            if index != 7 or position < 2:
                _add_circular(mix, _brush(sample_rate, rng), start + position * beat, sample_rate, .012, -.15)
    mix += _room(send, sample_rate) * .55
    return mix, {
        "title": "Лёгкий клёв", "description": "Новая оригинальная речная тема: нейлоновые струны, маримба, округлый бас, тихие щётки и шейкер; 24 такта A–B–A′ с синкопированными ответами.",
        "targetRmsDb": -21, "peakDb": -3, "musicalKey": "G major", "bpm": 76,
        "bars": bars, "meter": "4/4", "loop": True, "revision": "riverside-v2",
        "instruments": ["nylon-string plucks", "marimba", "rounded bass", "brushes", "shaker"],
        "provenance": "Original coded score and deterministic mathematical synthesis; no external recordings or samples.",
    }
