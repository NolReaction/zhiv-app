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


def _felt_pluck(duration: float, frequency: float, sample_rate: int,
                decay: float = .033) -> np.ndarray:
    """A fixed-pitch, softly struck tine without a noise scrape or pitch gulp."""
    t = _time(duration, sample_rate)
    audio = np.sin(2 * math.pi * frequency * t) * np.exp(-t / decay)
    audio += .11 * np.sin(2 * math.pi * frequency * 2 * t) * np.exp(-t / (decay * .65))
    audio += .018 * np.sin(2 * math.pi * frequency * 3 * t) * np.exp(-t / (decay * .45))
    return _fade(audio, sample_rate, .007, .028)


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
        # A padded wooden/bubble pluck. Keep the whole tail shorter than two
        # 80 ms tap intervals, so rapid tapping never steals an audible voice.
        durations = [.145, .150, .155]
        pitches = [390, 402, 382]
        length = durations[variant - 1]
        t = _time(length, sample_rate)
        # A small falling pitch gives the tap character without a piercing bell
        # or a sharp noise transient. Integrate frequency to keep phase smooth.
        frequency = pitches[variant - 1] * (1 + .14 * np.exp(-t / .014))
        phase = 2 * math.pi * np.cumsum(frequency) / sample_rate
        audio = np.sin(phase) * np.exp(-t / .030)
        audio += .16 * np.sin(phase * 2) * np.exp(-t / .019)
        audio += .025 * np.sin(phase * 3.01) * np.exp(-t / .012)
        audio += .07 * np.sin(phase * .5) * np.exp(-t / .025)
        audio += .012 * _noise(len(t), rng, sample_rate, 200, 1300) * np.exp(-t / .013)
        audio = signal.sosfilt(signal.butter(3, 2200, "lowpass", fs=sample_rate, output="sos"), audio)
        audio = _fade(audio, sample_rate, .008, .035)
        title = "Moss bubble"
        description = "A short padded wooden pluck with a rounded falling pitch, soft attack and closely matched variants."
        target = -23.5
    elif kind in ("open", "close"):
        # Navigation must not sound like handling wet paper. A single rounded
        # tine is shorter and quieter than the former broad-band swish; fixed
        # pitch also avoids the rubbery/bubble gesture reserved for the circle.
        pitches = [622.25, 659.25] if kind == "open" else [493.88, 523.25]
        length = .165 if kind == "open" else .145
        audio = _felt_pluck(length, pitches[variant - 1], sample_rate)
        title = "Felt opening" if kind == "open" else "Felt closing"
        description, target = "One clean fixed-pitch felt pluck, softly attacked and damped, without breath, scraping noise or pitch sweep.", -25
    elif kind == "tab":
        audio = _felt_pluck(.110, [587.33, 622.25][variant - 1], sample_rate, .023)
        title, description, target = "Small felt step", "A brief, quiet rounded tine for selecting an internal tab, with no swish or pitch movement.", -27
    elif kind == "slider":
        audio = _felt_pluck(.080, 560, sample_rate, .016)
        title, description, target = "Felt dial", "One very short muted tine; the interface gently adjusts its playback pitch with the selected volume.", -28
    elif kind == "startup":
        # Two rounded, consonant notes mirror the logo's pop and small settle.
        # A soft octave underneath adds body without a broadband whoosh, so
        # the signature stays compact and unobtrusive on repeated launches.
        audio = np.zeros(round(.56 * sample_rate))
        _add(audio, _felt_pluck(.40, 392, sample_rate, .070), 0, sample_rate, .75)
        _add(audio, _felt_pluck(.34, 196, sample_rate, .055), .004, sample_rate, .14)
        _add(audio, _felt_pluck(.45, 587.33, sample_rate, .080), .085, sample_rate, .58)
        title = "A small awakening"
        description = "A compact two-note felt signature, with a warm padded pop and a gentle rising fifth for the logo reveal. No noise sweep or long fanfare."
        target = -24.5
    elif kind == "daily-reward":
        # The daily gift has its own little ascending gesture, shorter and
        # more damped than the general treasure chime. Sparse upper harmonics
        # keep the higher final note rounded rather than metallic.
        audio = np.zeros(round(.76 * sample_rate))
        for pitch, when, strength, decay in [
            (523.25, 0, .72, .072), (659.25, .065, .58, .073),
            (783.99, .135, .49, .076), (1046.5, .225, .32, .085),
        ]:
            _add(audio, _felt_pluck(.50, pitch, sample_rate, decay), when, sample_rate, strength)
        _add(audio, _felt_pluck(.34, 261.63, sample_rate, .052), .006, sample_rate, .16)
        title = "A gift gathered"
        description = "A short original ascending felt arpeggio for collecting the daily gift, with a padded low note and a softly damped high finish."
        target = -23.5
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
    elif kind == "bush.rustle":
        length = .54 + variant * .035
        audio = np.zeros(round(length * sample_rate))
        # A broad leaf brush followed by a softer settling movement, with a
        # padded moss landing rather than the bright snap of a UI sound.
        _add(audio, _air_swish(.29 + variant * .02, sample_rate, rng), 0, sample_rate, .7)
        _add(audio, _air_swish(.24, sample_rate, rng, False), .25, sample_rate, .36)
        _add(audio, _modal(.17, 108 + variant * 8, sample_rate, rng, "earth"), .07, sample_rate, .1)
        title, description, target = "Into the berry leaves", "A soft leaf brush, padded moss contact and a short settling rustle.", -25
    elif kind == "mushroom.eat":
        length = .19 + variant * .025
        audio = np.zeros(round(length * sample_rate))
        bite_length = .11 + .015 * variant
        t = _time(bite_length, sample_rate)
        texture = _noise(len(t), rng, sample_rate, 210, 1500)
        envelope = np.sin(math.pi * t / bite_length) ** 2
        _add(audio, texture * envelope, .01, sample_rate, .14)
        _add(audio, _modal(.12, 190 + variant * 15, sample_rate, rng, "earth"), .01, sample_rate, .09)
        title, description, target = "A mushroom snack", "One small muted bite with a soft earthy texture; no wet mouth or sharp chewing noise.", -26
    elif kind == "water.drop":
        length = .24 + variant * .025
        audio = np.zeros(round(length * sample_rate))
        _add(audio, _bubble(.16, 520 + variant * 85, sample_rate, rng), .008, sample_rate, .45)
        _add(audio, _bubble(.12, 330 + variant * 30, sample_rate, rng), .045, sample_rate, .11)
        ripple = _air_swish(.14, sample_rate, rng)
        _add(audio, ripple, .055, sample_rate, .055)
        title, description, target = "A drop in the river", "One rounded falling droplet and a tiny soft ripple, for the visible water-drop animation.", -28
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
        if variant > {"click": 3, "slider": 1, "startup": 1, "daily-reward": 1}.get(parts[1], 2):
            raise ValueError(f"Unknown UI variation: {asset_id}")
        return _ui(parts[1], variant, sample_rate, rng)
    if parts[0] == "actor" and len(parts) == 4 and variant <= 3:
        return _actor(parts[1], parts[2], variant, sample_rate, rng)
    if parts[0] == "action" and len(parts) in (3, 4):
        if ".".join(parts[1:-1]) in ("bush.rustle", "mushroom.eat") and variant > 2:
            raise ValueError(f"Unknown action variation: {asset_id}")
        return _action(".".join(parts[1:-1]), variant, sample_rate, rng)
    if parts[:2] == ["water", "drop"] and len(parts) == 3 and variant <= 2:
        return _action("water.drop", variant, sample_rate, rng)
    raise ValueError(f"Not a supported one-shot asset ID: {asset_id}")
