"""Original 80-second river waltz; authored notes, no samples or quoted music."""
import hashlib
import numpy as np
from music import _add_circular, _bass, _flute, _pad, _pluck, _room

CHORDS = (
    ("F2", ("A3", "C4", "F4", "G4")),
    ("C3", ("G3", "C4", "E4", "G4")),
    ("D3", ("A3", "C4", "D4", "F4")),
    ("Bb2", ("A3", "Bb3", "D4", "F4")),
    ("F2", ("A3", "C4", "D4", "F4")),
    ("G2", ("Bb3", "D4", "F4", "A4")),
    ("C3", ("G3", "Bb3", "D4", "E4")),
    ("F2", ("A3", "C4", "F4", "G4")),
)
THEME = (
    ((.25, "A4", .75), (1.5, "C5", .5), (2.25, "G4", .5)),
    ((.5, "G4", 1), (2, "E4", .75)),
    ((.25, "F4", .75), (1.5, "A4", .5), (2.25, "D5", .5)),
    ((.5, "C5", 1), (2, "Bb4", .75)),
    ((.25, "A4", 1), (1.75, "F4", 1)),
    ((.5, "G4", .5), (1.5, "Bb4", 1)),
    ((.25, "A4", .5), (1, "G4", .5), (1.75, "E4", .75)),
    ((.5, "F4", 1.75),),
)
ANSWER = (
    ((.5, "C5", 1), (2, "A4", .75)),
    ((.25, "B4", .5), (1, "C5", .5), (1.75, "G4", .75)),
    ((.5, "A4", .5), (1.5, "F5", 1)),
    ((.25, "D5", 1), (1.75, "C5", .75)),
    ((.5, "A4", .75), (1.75, "G4", .75)),
    ((.25, "Bb4", .75), (1.5, "A4", .5), (2.25, "G4", .5)),
    ((.5, "E4", .5), (1.5, "G4", 1)),
    ((.5, "F4", 1.75),),
)


def render(sample_rate=48000):
    seed = int.from_bytes(hashlib.sha256(b"zhiv-river-waltz-v1").digest()[:8], "little")
    rng = np.random.default_rng(seed)
    beat = 60 / 54
    bar_seconds = 3 * beat
    mix = np.zeros((round(24 * bar_seconds * sample_rate), 2), dtype=np.float32)
    send = np.zeros_like(mix)

    def play(instrument, note, start, held, gain, pan, wet=.4):
        signal = instrument(note, held, sample_rate, rng)
        _add_circular(mix, signal, start, sample_rate, gain, pan)
        _add_circular(send, signal, start, sample_rate, gain * wet, pan)

    for bar in range(24):
        section, index = divmod(bar, 8)
        root, chord = CHORDS[index]
        start = bar * bar_seconds
        expression = (.88, .96, 1, .88, 1, .96, .92, .78)[index]
        for voice, pitch in enumerate(chord):
            play(_pad, pitch, start - .16, bar_seconds - .3, .018 * expression,
                 (-.55, .5, -.25, .28)[voice], .5)
        play(_bass, root, start, beat * 1.8, .068, 0, .12)
        for pick, position in enumerate((.12, 1.05, 1.7, 2.25)):
            if index == 7 and pick > 1:
                continue
            play(_pluck, chord[(0, 2, 1, 3)[pick]], start + position * beat,
                 .82 * beat, .068 * expression, -.32 + pick * .12, .48)
        theme = ANSWER if section == 1 else THEME
        instrument = _flute if section == 1 or section == 2 and index in (1, 3, 5) else _pluck
        for position, pitch, held in theme[index]:
            play(instrument, pitch, start + position * beat, held * beat,
                 (.091 if instrument == _flute else .12) * expression, .16, .5)
        if section == 2 and index in (0, 2, 4):
            play(_pluck, chord[1], start + 2.6 * beat, .6 * beat, .035, -.4, .6)
    mix += _room(send, sample_rate)
    return mix, {
        "title": "Тихий плёс", "description": "Оригинальный речной вальс: деревянная арфа, флейта, мягкий бас и тёплые аккорды; 24 такта A–B–A′ с паузами между фразами.",
        "targetRmsDb": -20, "peakDb": -3, "musicalKey": "F major", "bpm": 54,
        "bars": 24, "meter": "3/4", "loop": True,
        "provenance": "Original coded score and deterministic mathematical synthesis; no external recordings or samples.",
    }
