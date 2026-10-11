"""Original, deterministic one-shot sound design for the forest game.

No recordings, sample packs, speech models or third-party melodies are used.
All excitation signals are analytic oscillators or locally seeded noise. The
three creatures have their own harmonic/formant profiles and gesture rhythms;
they intentionally make nonverbal sounds rather than pronounce dialogue.

``render(asset_id, sample_rate)`` returns mono float32 PCM and mastering notes.
Mastering here makes auditioning safe; the export pipeline may master again.
"""

from __future__ import annotations

import hashlib
import math

import numpy as np
from scipy import signal


def _rng(asset_id: str) -> np.random.Generator:
    seed = int.from_bytes(hashlib.sha256(asset_id.encode("utf-8")).digest()[:8], "little")
    return np.random.default_rng(seed)


def _time(duration: float, sample_rate: int) -> np.ndarray:
    return np.arange(round(duration * sample_rate), dtype=np.float64) / sample_rate


def _noise(size: int, rng: np.random.Generator, sample_rate: int,
           low: float = 80, high: float = 4000) -> np.ndarray:
    """Band-limited stochastic excitation, measured before its amplitude envelope."""
    if size <= 0:
        return np.empty(0)
    high = min(high, sample_rate * 0.43)
    low = min(low, high * 0.5)
    filt = signal.butter(2, [low, high], btype="bandpass", fs=sample_rate, output="sos")
    noise = signal.sosfilt(filt, rng.standard_normal(size))
    return noise / max(float(np.sqrt(np.mean(noise * noise))), 1e-9)


def _fade(audio: np.ndarray, sample_rate: int,
          attack: float = 0.004, release: float = 0.018) -> np.ndarray:
    audio = audio.copy()
    a = min(round(attack * sample_rate), len(audio) // 2)
    r = min(round(release * sample_rate), len(audio) // 2)
    if a:
        audio[:a] *= np.sin(np.linspace(0, math.pi / 2, a)) ** 2
    if r:
        audio[-r:] *= np.cos(np.linspace(0, math.pi / 2, r)) ** 2
    # Set endpoints exactly, so decoded consecutive one-shots cannot click.
    if len(audio):
        audio[0] = audio[-1] = 0
    return audio


def _add(destination: np.ndarray, source: np.ndarray, when: float,
         sample_rate: int, gain: float = 1) -> None:
    start = round(when * sample_rate)
    first = max(0, -start)
    start = max(0, start)
    length = min(len(source) - first, len(destination) - start)
    if length > 0:
        destination[start:start + length] += source[first:first + length] * gain


def _modal(duration: float, frequency: float, sample_rate: int,
           rng: np.random.Generator, material: str = "wood") -> np.ndarray:
    """Excite a handful of damped modes: wood, ceramic bell or soft earth."""
    t = _time(duration, sample_rate)
    if material == "bell":
        ratios, amplitudes, decay = [1, 2.01, 3.98, 5.32], [1, .28, .08, .025], .27
    elif material == "earth":
        ratios, amplitudes, decay = [1, 1.54, 2.33], [1, .24, .09], .028
    else:
        ratios, amplitudes, decay = [1, 2.18, 3.73, 5.05], [1, .29, .1, .035], .068
    audio = np.zeros(len(t))
    for index, (ratio, amplitude) in enumerate(zip(ratios, amplitudes)):
        detune = rng.uniform(.991, 1.009)
        modal_frequency = frequency * ratio * detune
        if modal_frequency >= sample_rate * .43:
            continue
        envelope = np.exp(-t / (decay / (1 + .33 * index)))
        audio += amplitude * np.sin(2 * math.pi * modal_frequency * t) * envelope
    return _fade(audio, sample_rate, .0025, .022)


def _air_swish(duration: float, sample_rate: int, rng: np.random.Generator,
               opening: bool = True) -> np.ndarray:
    t = _time(duration, sample_rate)
    position = np.clip(t / duration, 0, 1)
    envelope = np.sin(math.pi * position) ** (1.5 if opening else 2.1)
    slow = _noise(len(t), rng, sample_rate, 130, 1200)
    fine = _noise(len(t), rng, sample_rate, 900, 3400)
    mix = position if opening else 1 - position
    return _fade((.28 * slow + .1 * fine * mix) * envelope, sample_rate)


def _finish(audio: np.ndarray, sample_rate: int, title: str, description: str,
            target_db: float = -20) -> tuple[np.ndarray, dict]:
    if not np.isfinite(audio).all() or not len(audio):
        raise ValueError("Synthesis produced invalid PCM")
    # Remove subsonic offsets without altering the first transient's timing.
    highpass = signal.butter(2, 32, "highpass", fs=sample_rate, output="sos")
    audio = _fade(signal.sosfilt(highpass, audio), sample_rate)
    rms = float(np.sqrt(np.mean(audio * audio)))
    peak = float(np.max(np.abs(audio)))
    if rms < 1e-10:
        raise ValueError("Synthesis produced silence")
    gain = min(10 ** (target_db / 20) / rms, 10 ** (-3.5 / 20) / peak)
    return (audio * gain).astype(np.float32), {
        "title": title,
        "description": description,
        "targetRmsDb": target_db,
        "peakDb": -3.5,
    }


def _ui(kind: str, variant: int, sample_rate: int,
        rng: np.random.Generator) -> tuple[np.ndarray, dict]:
    """Quiet tactile interface language, with intentionally consonant rewards."""
    if kind == "click":
        durations = [.26, .29, .27]
        pitches = [410, 465, 385]
        length = durations[variant - 1]
        audio = _modal(length, pitches[variant - 1], sample_rate, rng)
        t = _time(length, sample_rate)
        audio += .09 * _noise(len(t), rng, sample_rate, 350, 2300) * np.exp(-t / .011)
        title, description, target = "Acorn button", "A soft hollow wooden tap with a tiny fingertip texture.", -22
    elif kind in ("open", "close"):
        length = .43 if kind == "open" else .35
        audio = np.zeros(round(length * sample_rate))
        _add(audio, _air_swish(.21 + variant * .016, sample_rate, rng, kind == "open"), 0, sample_rate, .7)
        notes = ([523.25, 659.25] if variant == 1 else [587.33, 783.99])
        if kind == "close":
            notes = [notes[1] * .75, notes[0] * .75]
        for index, pitch in enumerate(notes):
            _add(audio, _modal(.27, pitch, sample_rate, rng), .035 + index * .06, sample_rate, .24)
        title = "Unfolding leaf" if kind == "open" else "Folding leaf"
        description, target = "A papery breath and two muted woody tones follow the panel motion.", -21
    elif kind == "confirm":
        audio = np.zeros(round(.72 * sample_rate))
        notes = [523.25, 783.99] if variant == 1 else [659.25, 880]
        for index, pitch in enumerate(notes):
            _add(audio, _modal(.55, pitch, sample_rate, rng, "bell"), index * .1, sample_rate, .65)
        title, description, target = "Little agreement", "Two rounded ceramic notes make a calm upward confirmation.", -20
    elif kind == "error":
        audio = np.zeros(round(.58 * sample_rate))
        notes = [349.23, 293.66] if variant == 1 else [329.63, 261.63]
        for index, pitch in enumerate(notes):
            _add(audio, _modal(.32, pitch, sample_rate, rng), index * .145, sample_rate, .7)
        title, description, target = "Gentle hesitation", "A short descending wooden interval without a harsh alarm.", -21
    elif kind == "reward":
        audio = np.zeros(round(1.35 * sample_rate))
        notes = [523.25, 659.25, 783.99, 1046.5] if variant == 1 else [440, 659.25, 880, 1108.73]
        moments = [0, .095, .205, .36] if variant == 1 else [0, .12, .22, .4]
        for index, (pitch, when) in enumerate(zip(notes, moments)):
            note = _modal(.95, pitch, sample_rate, rng, "bell")
            _add(audio, note, when, sample_rate, .62 - index * .07)
            _add(audio, note, when + .072, sample_rate, .09)
        title, description, target = "Found a little treasure", "A small original four-note chime with soft fading reflections.", -20
    else:
        raise ValueError(f"Unknown UI sound: {kind}")
    return _finish(audio, sample_rate, f"{title} {variant}", description, target)


_CREATURES = {
    # Fundamental, vocal resonances, breath amount, hollow body component.
    "mochlik": (182, (540, 1120, 1850), .055, .2),
    "plesk": (263, (760, 1530, 2450), .04, .08),
    "builder": (126, (390, 860, 1510), .075, .3),
}

# Each event has three independently phrased alternatives: start, duration,
# frequency contour (relative to the actor), amplitude. These are gestures,
# not recorded speech or a transcript in an invented language.
_GESTURES = {
    "greeting": [
        [(0, .25, [.93, 1.06, 1.18], .8), (.34, .34, [1.07, 1.22, 1.1], 1)],
        [(0, .4, [.89, 1.03, 1.19, 1.1], 1), (.49, .17, [1.22, 1.15, 1.02], .7)],
        [(0, .16, [.98, 1.1, 1.03], .66), (.24, .18, [1.1, 1.19, 1.1], .8),
         (.48, .32, [1.15, 1.26, 1.13], .9)],
    ],
    "joy": [
        [(0, .16, [.98, 1.13, 1.06], .85), (.21, .19, [1.1, 1.25, 1.2], 1),
         (.48, .32, [1.24, 1.34, 1.09], .82)],
        [(0, .31, [1.05, 1.3, 1.16], 1), (.39, .16, [1.25, 1.35, 1.18], .8),
         (.6, .15, [1.2, 1.29, 1.13], .7)],
        [(0, .14, [1, 1.14, 1.08], .65), (.18, .14, [1.09, 1.25, 1.15], .75),
         (.38, .15, [1.17, 1.31, 1.18], .9), (.61, .25, [1.22, 1.3, 1.04], 1)],
    ],
    "effort": [
        [(0, .34, [.92, 1.05, .86], 1)],
        [(0, .12, [.88, .95, .9], .52), (.18, .3, [.98, 1.08, .87], 1)],
        [(0, .42, [.84, 1.02, .97, .8], 1)],
    ],
    "sleep": [
        [(0, .64, [.8, .85, .75], .8), (.78, .43, [.74, .7, .69], .5)],
        [(0, .86, [.75, .81, .73, .67], .85)],
        [(0, .48, [.78, .83, .77], .64), (.62, .61, [.81, .77, .68], .77)],
    ],
}


def _vocal_gesture(duration: float, contour: list[float], character: str,
                   emotion: str, sample_rate: int, rng: np.random.Generator) -> np.ndarray:
    """Additive creature oscillator whose broad resonances move while it hums."""
    base, formants, breath, body = _CREATURES[character]
    t = _time(duration, sample_rate)
    progress = t / duration
    fundamental = base * np.interp(progress, np.linspace(0, 1, len(contour)), contour)
    fundamental *= 1 + .009 * np.sin(2 * math.pi * (4.2 + rng.uniform(0, 1.1)) * t)
    # The Plesk has a watery burble, the builder a slower chesty flutter.
    flutter_rate = {"mochlik": 13, "plesk": 18, "builder": 9}[character]
    flutter = 1 + (.008 if emotion == "sleep" else .021) * np.sin(2 * math.pi * flutter_rate * t)
    fundamental *= flutter
    phase = 2 * math.pi * np.cumsum(fundamental) / sample_rate
    envelope = np.sin(math.pi * np.clip(progress, 0, 1)) ** (.82 if emotion == "sleep" else .68)
    audio = np.zeros(len(t))
    formant_motion = .95 + .11 * np.sin(math.pi * progress)
    if emotion == "sleep":
        formant_motion *= .83
    for harmonic in range(1, 15):
        frequency = fundamental * harmonic
        colour = np.full(len(t), .12 if harmonic == 1 else .02)
        for resonance, weight, width in zip(formants, [1, .43, .13], [.24, .17, .16]):
            center = resonance * formant_motion
            colour += weight * np.exp(-.5 * ((frequency - center) / (center * width)) ** 2)
        colour *= (frequency < sample_rate * .43)
        audio += np.sin(phase * harmonic) * colour / harmonic ** 1.24
    audio += body * np.sin(phase) * (.8 + .2 * np.sin(2 * math.pi * 3 * t))
    airy = _noise(len(t), rng, sample_rate, 350, 2500)
    audio += airy * breath * (1.8 if emotion in ("effort", "sleep") else 1)
    if emotion == "sleep":
        # A soft exhale; no sharp snore or nasal buzz.
        audio *= .7 + .3 * np.sin(math.pi * progress)
    elif emotion == "effort":
        audio *= .6 + .4 * np.exp(-((progress - .31) / .27) ** 2)
    return _fade(audio * envelope, sample_rate, .016, .035)


def _actor(character: str, emotion: str, variant: int, sample_rate: int,
           rng: np.random.Generator) -> tuple[np.ndarray, dict]:
    if character not in _CREATURES or emotion not in _GESTURES:
        raise ValueError(f"Unknown creature gesture: {character}.{emotion}")
    gestures = _GESTURES[emotion][variant - 1]
    pace = {"mochlik": 1, "plesk": .9, "builder": 1.11}[character]
    length = max(start + duration for start, duration, _, _ in gestures) * pace + .14
    audio = np.zeros(round(length * sample_rate))
    for start, duration, contour, amplitude in gestures:
        note = _vocal_gesture(duration * pace, contour, character, emotion, sample_rate, rng)
        _add(audio, note, start * pace, sample_rate, amplitude)
        # Very short enclosure reflection keeps these close and intimate.
        _add(audio, note, start * pace + .031, sample_rate, .065)
    tone = {"mochlik": "warm hollow forest hum", "plesk": "light rounded watery burble",
            "builder": "low soft chesty rumble"}[character]
    gestures_text = {"greeting": "curious rising greeting", "joy": "bouncing happy phrase",
                     "effort": "brief breathy effort", "sleep": "slow sleepy sigh"}[emotion]
    return _finish(audio, sample_rate, f"{character.title()} {emotion} {variant}",
                   f"An original nonverbal {tone}, shaped into a {gestures_text}. No voice recordings.",
                   -22 if emotion == "sleep" else -20)


def _bubble(duration: float, frequency: float, sample_rate: int,
            rng: np.random.Generator, strength: float = 1) -> np.ndarray:
    t = _time(duration, sample_rate)
    pitch = frequency * (1 + .27 * np.exp(-t / .014))
    phase = 2 * math.pi * np.cumsum(pitch) / sample_rate
    audio = np.sin(phase) * np.exp(-t / (.018 + rng.uniform(0, .018)))
    return strength * _fade(audio, sample_rate, .004, .018)


def _action(kind: str, variant: int, sample_rate: int,
            rng: np.random.Generator) -> tuple[np.ndarray, dict]:
    if kind == "step.grass":
        length = [.33, .36, .31, .38][variant - 1]
        t = _time(length, sample_rate)
        texture = _noise(len(t), rng, sample_rate, 180, 2400)
        envelope = (1 - np.exp(-t / .008)) * np.exp(-t / (.046 + variant * .003))
        audio = texture * envelope * .24
        _add(audio, _modal(.22, 90 + variant * 7, sample_rate, rng, "earth"), .006, sample_rate, .34)
        # Heel then toe compress the grass at independently varied moments.
        rub = _air_swish(.11 + variant * .009, sample_rate, rng)
        _add(audio, rub, .055 + variant * .007, sample_rate, .16)
        title, description, target = "Moss footfall", "A low padded footstep and a small brushing grass texture.", -21
    elif kind == "step.wood":
        length = .36 + variant * .015
        audio = _modal(length, [168, 151, 182, 161][variant - 1], sample_rate, rng)
        _add(audio, _modal(.24, 99 + variant * 4, sample_rate, rng, "earth"), .025, sample_rate, .4)
        t = _time(length, sample_rate)
        audio += .035 * _noise(len(t), rng, sample_rate, 300, 2300) * np.exp(-t / .026)
        title, description, target = "Old board footfall", "A small hollow board flex with a softened heel and toe.", -21
    elif kind == "hammer":
        length = .54 + variant * .018
        audio = _modal(length, [207, 182, 226, 196][variant - 1], sample_rate, rng)
        t = _time(length, sample_rate)
        audio += .26 * _noise(len(t), rng, sample_rate, 260, 3300) * np.exp(-t / .017)
        knock = _modal(.28, 118 + variant * 6, sample_rate, rng)
        _add(audio, knock, .01, sample_rate, .45)
        _add(audio, knock, .073 + variant * .004, sample_rate, .09)
        title, description, target = "Workbench mallet", "One rounded wooden mallet strike with a warm bench resonance.", -19
    elif kind == "water.pour":
        length = [1.48, 1.68, 1.57, 1.8][variant - 1]
        t = _time(length, sample_rate)
        envelope = np.sin(math.pi * t / length) ** .7
        flow = _noise(len(t), rng, sample_rate, 240, 3600)
        uneven = .73 + .19 * np.sin(2 * math.pi * (6 + variant * .4) * t) + .08 * np.sin(2 * math.pi * 17 * t)
        audio = .2 * flow * envelope * uneven
        for _ in range(24 + variant * 3):
            when = rng.uniform(.06, length - .18)
            bubble = _bubble(rng.uniform(.055, .14), rng.uniform(460, 1300), sample_rate, rng)
            _add(audio, bubble, when, sample_rate, rng.uniform(.02, .09))
        title, description, target = "Watering the roots", "An uneven gentle stream with original resonant droplets and a soft release.", -21
    elif kind == "fish.splash":
        length = [1.15, 1.31, 1.22, 1.43][variant - 1]
        t = _time(length, sample_rate)
        body = _noise(len(t), rng, sample_rate, 120, 1100)
        spray = _noise(len(t), rng, sample_rate, 700, 4100)
        envelope = (1 - np.exp(-t / .011)) * np.exp(-t / (.13 + variant * .007))
        audio = envelope * (.4 * body + .16 * spray)
        # A trailing ripple and a falling sequence of irregular water drops.
        ripple = _air_swish(.34, sample_rate, rng)
        _add(audio, ripple, .17 + variant * .013, sample_rate, .32)
        for index in range(12 + variant):
            when = rng.uniform(.11, length - .16)
            bubble = _bubble(.15, rng.uniform(340, 1100), sample_rate, rng)
            _add(audio, bubble, when, sample_rate, .095 * (1 - when / length))
        title, description, target = "Small fish landing", "A rounded splash, gentle ripple and scattered droplets, without a sharp slap.", -20
    elif kind == "berry.pick":
        length = [.48, .54, .51, .57][variant - 1]
        audio = np.zeros(round(length * sample_rate))
        stem = _modal(.18, [640, 580, 715, 615][variant - 1], sample_rate, rng)
        _add(audio, stem, .009, sample_rate, .38)
        _add(audio, _air_swish(.16, sample_rate, rng), .02, sample_rate, .17)
        basket = _modal(.22, [272, 249, 293, 262][variant - 1], sample_rate, rng)
        _add(audio, basket, .19 + variant * .011, sample_rate, .31)
        title, description, target = "Berry into basket", "A delicate stem pop and leaf movement followed by a small woven-basket tap.", -21
    else:
        raise ValueError(f"Unknown action sound: {kind}")
    return _finish(audio, sample_rate, f"{title} {variant}", description, target)


def render(asset_id: str, sample_rate: int) -> tuple[np.ndarray, dict]:
    """Render a catalog UI, character or action variation into finite mono PCM.

    Asset IDs are checked explicitly so a misspelled catalog slot cannot silently
    export a generic beep. The generator's normal mastering rate is 48 kHz.
    """
    if not isinstance(sample_rate, int) or sample_rate < 16000:
        raise ValueError("sample_rate must be an integer of at least 16000 Hz")
    parts = asset_id.split(".")
    if len(parts) < 3 or parts[-1] not in ("01", "02", "03", "04"):
        raise ValueError(f"Not a supported one-shot asset ID: {asset_id}")
    variant = int(parts[-1])
    rng = _rng(asset_id)
    if parts[0] == "ui" and len(parts) == 3:
        if variant > (3 if parts[1] == "click" else 2):
            raise ValueError(f"Unknown UI variation: {asset_id}")
        return _ui(parts[1], variant, sample_rate, rng)
    if parts[0] == "actor" and len(parts) == 4 and variant <= 3:
        return _actor(parts[1], parts[2], variant, sample_rate, rng)
    if parts[0] == "action" and len(parts) in (3, 4):
        return _action(".".join(parts[1:-1]), variant, sample_rate, rng)
    raise ValueError(f"Not a supported one-shot asset ID: {asset_id}")
