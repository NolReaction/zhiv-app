import { AUDIO_CATALOG } from "@/features/audio/catalog/catalog";
import { mergeAudioSettings, sanitizeAudioSettings } from "@/features/audio/domain/settings";
import { AUDIO_BUSES, type AudioAsset, type AudioBus, type AudioCatalog, type AudioCue, type AudioDiagnostics, type AudioEvent, type AudioFrame, type AudioLoopTarget, type AudioRuntime, type AudioSettings, type AudioSourceDebug } from "@/features/audio/domain/types";
import { createAudioAssetCache } from "./audio-asset-cache";
import { createAudioAssetTransport } from "./audio-asset-transport";
import { createMusicLoopEnvelope } from "./music-loop-envelope";

const MAX_VOICES = 24;
const MAX_LOOPS = 10;
const MAX_MUSIC_DECKS = 2;
const EVENT_TTL_MS = 2_000;
const MAX_EVENT_IDS = 512;
const DEDUP_TTL_MS = 60_000;
const STREAM_RETRY_MS = 1_000;
const MAX_STREAM_RETRY_MS = 30_000;
const MEDIA_PAUSE_RECOVERY_MS = 250;
const MAX_LOOP_TIMELINES = 128;
const MAX_PREPARED_MUSIC_BYTES = 8 * 1024 * 1024;
const SOUNDSCAPE_BUSES = new Set<AudioBus>(["ambience", "weather", "world", "footsteps", "characters"]);

type Voice = {
  key: string; serial: number; cue: AudioCue; assetId: string; priority: number;
  gain: GainNode; panner: StereoPannerNode | null; source: AudioBufferSourceNode | MediaElementAudioSourceNode | OscillatorNode;
  media: HTMLAudioElement | null; createdAt: number; timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean; reclaimable: boolean; sceneId: string | null;
  feedbackBus?: AudioEvent["feedbackBus"];
  cancelMediaRecovery?: () => void;
  musicGain?: GainNode;
  cancelMusicEnvelope?: () => void;
};
type PendingLoop = { cueId: string; generation: number };
type ParameterRamp = { from: number; target: number; start: number; end: number };
type LoopTimeline = { assetId: string; startedAt: number; playbackRate: number };
type StreamFailure = { retryAt: number; attempts: number };
export type AudioRuntimeOptions = {
  catalog?: AudioCatalog;
  initialSettings?: AudioSettings;
  createContext?: () => AudioContext;
  createMediaElement?: () => HTMLAudioElement;
  fetchAsset?: typeof fetch;
  now?: () => number;
  random?: () => number;
  maxDecodedBytes?: number;
  cacheStorage?: CacheStorage;
};

const finiteClamp = (value: number, low: number, high: number, fallback = low) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
const dbGain = (db: number) => 10 ** (finiteClamp(db, -60, 0) / 20);
const defaultContext = () => {
  const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) throw new Error("Web Audio unavailable");
  return new Constructor({ latencyHint: "balanced", sampleRate: 48_000 });
};

/** One application-wide mixer. Preparation may decode while playback is locked. */
export function createAudioRuntime(options: AudioRuntimeOptions = {}): AudioRuntime {
  const catalog = options.catalog ?? AUDIO_CATALOG;
  const cues = new Map(catalog.cues.map(cue => [cue.id, cue]));
  const assets = new Map(catalog.assets.map(asset => [asset.id, asset]));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let settings = sanitizeAudioSettings(options.initialSettings);
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let compressor: DynamicsCompressorNode | null = null;
  const buses = new Map<AudioBus, GainNode>();
  let frame: AudioFrame | null = null;
  let lastSceneId: string | null = null;
  let frameClearTimer: ReturnType<typeof setTimeout> | null = null;
  let streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let streamRetryAt = Infinity;
  let visible = true;
  let disposed = false;
  let unavailable = false;
  let everUnlocked = false;
  let generation = 0;
  let soundscapeGeneration = 0;
  let sequence = 0;
  let audition = 0;
  let borrowedPreview: { voice: Voice; timer: ReturnType<typeof setTimeout> } | null = null;
  let lastEvent: string | null = null;
  let latestSliderRequest = 0;
  let droppedEvents = 0;
  let loopStarts = 0;
  let musicStarts = 0;
  let snapshot: AudioDiagnostics;
  const subscribers = new Set<() => void>();
  const voices = new Map<string, Voice>();
  const retiring = new Map<number, Voice>();
  const pendingLoops = new Map<string, PendingLoop>();
  const eventIds = new Map<string, number>();
  const cooldowns = new Map<string, number>();
  const playbackCooldowns = new Map<string, number>();
  const lastVariants = new Map<string, string>();
  const failedStreams = new Map<string, StreamFailure>();
  const blockedStreams = new Set<string>();
  const musicPositions = new Map<string, number>();
  const loopTimelines = new Map<string, LoopTimeline>();
  const bufferClaims = new Map<string, number>();
  const pendingEvents = new Set<number>();
  const parameterRamps = new WeakMap<AudioParam, ParameterRamp>();
  const transport = createAudioAssetTransport({ fetchAsset: options.fetchAsset ?? ((...args) => fetch(...args)),
    cacheStorage: options.cacheStorage });
  const preparedMusic = new Map<string, { url: string; bytes: number }>();
  const pendingMusic = new Map<string, Promise<void>>();
  const preparationControllers = new Set<AbortController>();
  let preparationAutoplayAttempted = false;
  const cache = createAudioAssetCache({ context: () => context, fetchAsset: transport.fetch, now,
    maxDecodedBytes: options.maxDecodedBytes, changed: publish,
    isInUse: id => (bufferClaims.get(id) ?? 0) > 0 || [...voices.values(), ...retiring.values()].some(voice => voice.assetId === id),
  });

  function state(): AudioDiagnostics["state"] {
    if (disposed) return "disposed";
    if (unavailable) return "unavailable";
    if (!context || !everUnlocked) return "locked";
    const blockedMusic = frame?.loops.some(loop => loop.gain > .001 && cues.get(loop.cueId)?.assets.some(id => blockedStreams.has(id)));
    return visible && settings.enabled && context.state === "running" && !(settings.buses.music > 0 && blockedMusic) ? "running" : "suspended";
  }
  function publish() {
    const sources: AudioSourceDebug[] = (frame?.sources ?? []).slice(0, 64).map(source => ({ ...source,
      gain: Math.round(source.gain * 100) / 100, pan: Math.round(source.pan * 100) / 100,
    }));
    const next: AudioDiagnostics = { state: state(), settings, activeVoices: voices.size,
      loadedAssets: cache.loadedCount(), pendingAssets: catalog.assets.filter(asset => asset.status === "pending").length + cache.loadingCount(),
      failedAssets: [...new Set([...cache.failedIds(), ...failedStreams.keys()])], sources, lastEvent, droppedEvents,
      playback: { loopStarts, musicStarts, activeOwnerId: frame?.ownerId ?? null } };
    // useSyncExternalStore needs referential stability, including while scene frames keep arriving.
    if (snapshot && snapshot.settings === settings && snapshot.state === next.state && snapshot.activeVoices === next.activeVoices
      && snapshot.loadedAssets === next.loadedAssets && snapshot.pendingAssets === next.pendingAssets && snapshot.lastEvent === next.lastEvent
      && snapshot.droppedEvents === next.droppedEvents && JSON.stringify(snapshot.sources) === JSON.stringify(sources)
      && snapshot.playback?.loopStarts === loopStarts && snapshot.playback?.musicStarts === musicStarts
      && snapshot.playback?.activeOwnerId === next.playback?.activeOwnerId
      && JSON.stringify(snapshot.failedAssets) === JSON.stringify(next.failedAssets)) return;
    snapshot = next;
    for (const listener of subscribers) { try { listener(); } catch { /* A subscriber cannot interrupt game audio cleanup. */ } }
  }
  function contextIsRunning() { return context?.state === "running"; }
  function audible(bus?: AudioBus) {
    return !disposed && visible && settings.enabled && settings.master > 0 && context?.state === "running"
      && (!bus || settings.buses[bus] > 0 && (frame?.soundscape !== false || !SOUNDSCAPE_BUSES.has(bus)));
  }
  function feedbackAudible(bus?: AudioEvent["feedbackBus"]) {
    return bus === undefined || bus === "master" ? settings.master > 0 : settings.buses[bus] > 0;
  }
  function ramp(param: AudioParam, target: number, seconds: number) {
    if (!context) return;
    // Scene frames can arrive at display refresh rate. Holding and restarting an
    // unchanged ramp on each frame postpones its endpoint indefinitely and floods
    // the audio thread with redundant automation. Only retarget a changed value.
    const previous = parameterRamps.get(param);
    if (previous && Math.abs(previous.target - target) < 0.00001) return;
    const time = context.currentTime, end = time + Math.max(.01, seconds);
    // Evaluate our linear envelope before cancellation. AudioParam.value can lag
    // by a render quantum, and cancelling can discard the ongoing ramp endpoint.
    const held = previous ? previous.from + (previous.target - previous.from)
      * finiteClamp((time - previous.start) / (previous.end - previous.start), 0, 1) : param.value;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(time);
    else {
      param.cancelScheduledValues(time);
      // Recreate the truncated ramp up to the hold point. A setValue alone
      // leaves its former start value in the render quantum and causes clicks.
      param.linearRampToValueAtTime(held, time);
      param.setValueAtTime(held, time);
    }
    param.linearRampToValueAtTime(target, end);
    parameterRamps.set(param, { from: held, target, start: time, end });
  }
  function updateMix() {
    if (!master) return;
    ramp(master.gain, settings.enabled && visible ? settings.master : 0, .12);
    for (const [bus, node] of buses) ramp(node.gain, settings.buses[bus] * (bus === "music" ? finiteClamp(frame?.musicDuck ?? 1, 0, 1) : 1), bus === "music" ? .8 : .12);
  }
  function releaseBorrowedPreview() {
    if (!borrowedPreview) return;
    clearTimeout(borrowedPreview.timer);
    borrowedPreview = null;
  }
  function detachMediaCallbacks(voice: Voice) {
    if (!voice.media) return;
    voice.cancelMediaRecovery?.();
    voice.cancelMusicEnvelope?.();
    voice.media.onerror = null; voice.media.onloadedmetadata = null; voice.media.onpause = null; voice.media.onended = null;
    voice.media.ontimeupdate = null; voice.media.onplaying = null; voice.media.onwaiting = null;
  }
  function cleanup(voice: Voice) {
    if (voice.stopped) return;
    if (borrowedPreview?.voice === voice) releaseBorrowedPreview();
    voice.stopped = true; voice.reclaimable = false;
    if (voice.timer) clearTimeout(voice.timer);
    if (voices.get(voice.key) === voice) voices.delete(voice.key);
    retiring.delete(voice.serial);
    if (voice.media) {
      if (voice.key.startsWith("loop:") && voice.sceneId === lastSceneId && Number.isFinite(voice.media.currentTime) && voice.media.currentTime > 0) musicPositions.set(voice.assetId, voice.media.currentTime);
      detachMediaCallbacks(voice);
      voice.media.pause();
      voice.media.removeAttribute("src");
      voice.media.load();
    } else {
      const source = voice.source as AudioBufferSourceNode | OscillatorNode;
      source.onended = null;
      try { source.stop(); } catch { /* An already completed one-shot needs only disconnection. */ }
    }
    voice.source.disconnect(); voice.gain.disconnect(); voice.panner?.disconnect(); voice.musicGain?.disconnect();
    publish();
  }
  function stopVoice(voice: Voice, immediate = false) {
    if (voice.stopped) return;
    if (voice.timer) { clearTimeout(voice.timer); voice.timer = null; }
    voice.reclaimable = false;
    detachMediaCallbacks(voice);
    if (borrowedPreview?.voice === voice) releaseBorrowedPreview();
    if (voices.get(voice.key) === voice) voices.delete(voice.key);
    if (immediate || !context || context.state !== "running") { cleanup(voice); return; }
    retiring.set(voice.serial, voice);
    const seconds = Math.min(1.5, Math.max(.04, voice.cue.fadeMs / 1000));
    ramp(voice.gain.gain, 0, seconds);
    if (!voice.media) {
      try { (voice.source as AudioBufferSourceNode | OscillatorNode).stop(context.currentTime + seconds + .01); } catch { cleanup(voice); }
    }
    // Also disconnect if a context is interrupted and never delivers onended.
    voice.timer = setTimeout(() => cleanup(voice), seconds * 1000 + 80);
    if (retiring.size > MAX_VOICES) cleanup(retiring.values().next().value!);
  }
  function releaseLoop(voice: Voice) {
    if (voice.stopped || voice.reclaimable) return;
    if (voices.get(voice.key) === voice) voices.delete(voice.key);
    retiring.set(voice.serial, voice);
    voice.reclaimable = true;
    const seconds = Math.min(1.5, Math.max(.3, voice.cue.fadeMs / 1000));
    ramp(voice.gain.gain, 0, seconds);
    // Unlike a final stop, a proximity fade must be reversible. Scheduling
    // source.stop() here forces a new sample when the next camera frame returns.
    voice.timer = setTimeout(() => cleanup(voice), seconds * 1000 + 80);
    if (retiring.size > MAX_VOICES) cleanup(retiring.values().next().value!);
  }
  function reclaimLoop(key: string, cue: AudioCue, priority: number): Voice | null {
    const voice = [...retiring.values()].find(item => item.reclaimable && item.key === key
      && item.cue.id === cue.id && item.sceneId === frame?.sceneId);
    if (!voice || !roomFor(cue, priority)) return null;
    if (voice.timer) clearTimeout(voice.timer);
    voice.timer = null; voice.reclaimable = false;
    retiring.delete(voice.serial); voices.set(key, voice);
    return voice;
  }
  function invalidate(immediate = false) {
    cancelStreamRetry();
    releaseBorrowedPreview();
    generation++;
    pendingLoops.clear(); pendingEvents.clear();
    for (const voice of [...voices.values()]) stopVoice(voice, immediate);
    // Retiring proximity voices belong to the previous generation too; an
    // unmute or account change must never revive them through the reclaim path.
    for (const voice of retiring.values()) voice.reclaimable = false;
    if (immediate) for (const voice of [...retiring.values()]) cleanup(voice);
  }
  function cancelStreamRetry() {
    if (streamRetryTimer !== null) clearTimeout(streamRetryTimer);
    streamRetryTimer = null; streamRetryAt = Infinity;
  }
  function scheduleStreamRetry() {
    let nextAt = Infinity;
    if (audible("music")) for (const target of frame?.loops ?? []) {
      const cue = cues.get(target.cueId);
      if (!cue || cue.mode !== "music" || target.gain <= .001 || voices.has(`loop:${target.id}`)) continue;
      for (const id of cue.assets) {
        const failure = failedStreams.get(id);
        if (failure && !blockedStreams.has(id)) nextAt = Math.min(nextAt, failure.retryAt);
      }
    }
    if (nextAt === streamRetryAt) return;
    cancelStreamRetry();
    if (!Number.isFinite(nextAt)) return;
    streamRetryAt = nextAt;
    streamRetryTimer = setTimeout(() => {
      streamRetryTimer = null; streamRetryAt = Infinity;
      // Static menus publish on view changes, so recovery must not depend on a
      // canvas tick or a navigation. Reconcile only the frame still owned now.
      if (!disposed) reconcile();
    }, Math.max(STREAM_RETRY_MS, nextAt - now()));
  }
  function failStream(assetId: string) {
    const attempts = Math.min(6, (failedStreams.get(assetId)?.attempts ?? 0) + 1);
    failedStreams.set(assetId, { attempts, retryAt: now() + Math.min(MAX_STREAM_RETRY_MS, STREAM_RETRY_MS * 2 ** (attempts - 1)) });
  }
  function loadBuffer(asset: AudioAsset, consume: (buffer: AudioBuffer | null) => void, priority = 60) {
    // Reserve through the consumer callback: another simultaneous decode must not evict
    // a buffer in the microtask gap between load completion and voice creation.
    bufferClaims.set(asset.id, (bufferClaims.get(asset.id) ?? 0) + 1);
    void cache.load(asset, priority).then(consume).catch(() => { droppedEvents++; publish(); }).finally(() => {
      const remaining = (bufferClaims.get(asset.id) ?? 1) - 1;
      if (remaining > 0) bufferClaims.set(asset.id, remaining); else bufferClaims.delete(asset.id);
    });
  }
  function chooseAsset(cue: AudioCue): AudioAsset | null {
    const ready = cue.assets.map(id => assets.get(id)).filter((asset): asset is AudioAsset => asset?.status === "ready" && Boolean(asset.src));
    if (!ready.length) return null;
    const choices = ready.length > 1 ? ready.filter(asset => asset.id !== lastVariants.get(cue.id)) : ready;
    const chosen = choices[Math.floor(finiteClamp(random(), 0, .999999) * choices.length)];
    lastVariants.set(cue.id, chosen.id);
    return chosen;
  }
  function roomFor(cue: AudioCue, priority: number) {
    const sameCue = [...voices.values()].filter(voice => voice.cue.id === cue.id);
    if (sameCue.length >= Math.max(1, cue.maxInstances)) return false;
    if (cue.mode === "music") {
      const decks = [...voices.values(), ...retiring.values()].filter(voice => Boolean(voice.media));
      if (decks.length >= MAX_MUSIC_DECKS) {
        const retired = decks.filter(voice => retiring.has(voice.serial)).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (retired) cleanup(retired); else return false;
      }
    }
    if (voices.size < MAX_VOICES) return true;
    const victim = [...voices.values()].filter(voice => voice.priority < priority).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)[0];
    if (!victim) return false;
    stopVoice(victim);
    return true;
  }
  function wireVoice(key: string, cue: AudioCue, assetId: string, source: Voice["source"], media: HTMLAudioElement | null, priority: number): Voice {
    const ctx = context!;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const panner = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
    const musicGain = media && key.startsWith("loop:") ? ctx.createGain() : undefined;
    if (musicGain) { musicGain.gain.value = 0; musicGain.connect(buses.get(cue.bus)!); }
    source.connect(gain);
    if (panner) { gain.connect(panner); panner.connect(musicGain ?? buses.get(cue.bus)!); }
    else gain.connect(musicGain ?? buses.get(cue.bus)!);
    const voice: Voice = { key, serial: ++sequence, cue, assetId, priority, gain, panner, source, media, musicGain, createdAt: now(), timer: null, stopped: false, reclaimable: false, sceneId: frame?.sceneId ?? lastSceneId };
    voices.set(key, voice);
    if (!media) (source as AudioBufferSourceNode | OscillatorNode).onended = () => cleanup(voice);
    return voice;
  }
  function tune(voice: Voice, gain: number, pan: number) {
    ramp(voice.gain.gain, dbGain(voice.cue.gainDb) * finiteClamp(gain, 0, 4), Math.max(.025, Math.min(1.5, voice.cue.fadeMs / 1000)));
    if (voice.panner) ramp(voice.panner.pan, finiteClamp(pan, -1, 1), .1);
  }
  function borrowSceneVoice(cueId: string) {
    const existing = [...voices.values()].find(voice => voice.key.startsWith("loop:") && voice.cue.id === cueId);
    if (!existing) return false;
    tune(existing, 1, 0);
    borrowedPreview = { voice: existing, timer: setTimeout(() => {
      releaseBorrowedPreview(); reconcile();
    }, 4000) };
    return true;
  }
  function startBuffer(key: string, cue: AudioCue, asset: AudioAsset, buffer: AudioBuffer, gain: number, pan: number, priority: number, playbackRate = 1, feedbackBus?: AudioEvent["feedbackBus"]) {
    if (!audible(cue.bus) || !roomFor(cue, priority)) return false;
    const source = context!.createBufferSource();
    source.buffer = buffer;
    source.loop = cue.mode === "loop";
    if (source.loop) {
      source.loopStart = finiteClamp(asset.loopStart ?? 0, 0, Math.max(0, buffer.duration - .01));
      source.loopEnd = finiteClamp(asset.loopEnd ?? buffer.duration, source.loopStart + .01, buffer.duration, buffer.duration);
    }
    source.playbackRate.value = finiteClamp(playbackRate, .88, 1.18, 1)
      * (1 + (finiteClamp(random(), 0, 1) * 2 - 1) * finiteClamp(cue.pitchVariation, 0, .08));
    let offset = 0;
    if (source.loop && key.startsWith("loop:")) {
      const previous = loopTimelines.get(key);
      if (previous?.assetId === asset.id) {
        source.playbackRate.value = previous.playbackRate;
        const elapsed = Math.max(0, context!.currentTime - previous.startedAt) * previous.playbackRate;
        offset = elapsed < source.loopEnd ? elapsed : source.loopStart + (elapsed - source.loopStart) % (source.loopEnd - source.loopStart);
      } else {
        loopTimelines.set(key, { assetId: asset.id, startedAt: context!.currentTime, playbackRate: source.playbackRate.value });
        while (loopTimelines.size > MAX_LOOP_TIMELINES) loopTimelines.delete(loopTimelines.keys().next().value!);
      }
    }
    const voice = wireVoice(key, cue, asset.id, source, null, priority);
    voice.feedbackBus = feedbackBus;
    tune(voice, gain, pan);
    try { source.start(0, offset); } catch { cleanup(voice); return false; }
    if (source.loop) loopStarts++;
    publish();
    return true;
  }
  function startMusic(key: string, cue: AudioCue, asset: AudioAsset, gain: number, pan: number, priority: number) {
    if (!audible(cue.bus) || !roomFor(cue, priority)) return;
    if (blockedStreams.has(asset.id) || (failedStreams.get(asset.id)?.retryAt ?? -Infinity) > now()) return;
    let voice: Voice | null = null;
    let media: HTMLAudioElement | null = null;
    try {
      media = options.createMediaElement?.() ?? new Audio();
      media.preload = "none"; media.loop = true; media.crossOrigin = "anonymous";
      const source = context!.createMediaElementSource(media);
      voice = wireVoice(key, cue, asset.id, source, media, priority);
      musicStarts++;
      const liveVoice = voice;
      const player = media;
      const ownsPlayback = () => !disposed && !liveVoice.stopped && voices.get(key) === liveVoice && liveVoice.sceneId === lastSceneId;
      const envelope = liveVoice.musicGain ? createMusicLoopEnvelope(context!, liveVoice.musicGain.gain, player,
        () => ownsPlayback() && audible(cue.bus)) : null;
      liveVoice.cancelMusicEnvelope = () => envelope?.dispose();
      player.ontimeupdate = player.onplaying = player.onwaiting = () => envelope?.refresh();
      const urls = [...new Set([asset.src, asset.fallbackSrc].filter((url): url is string => Boolean(url)))];
      // Preparation chooses a supported codec; consume its ready Blob first.
      urls.sort((a, b) => Number(preparedMusic.has(b)) - Number(preparedMusic.has(a)));
      let attempt = 0;
      const acceptsCallback = (request: number) => {
        // A fading deck can settle its play promise after an account change,
        // mute or replacement. It no longer owns shared retry/autoplay state.
        // Its bounded retirement timer still owns the existing fade/cleanup.
        return request === attempt && ownsPlayback();
      };
      let pauseRecovery: ReturnType<typeof setTimeout> | null = null;
      liveVoice.cancelMediaRecovery = () => { if (pauseRecovery !== null) clearTimeout(pauseRecovery); pauseRecovery = null; };
      const savedPosition = key.startsWith("loop:") ? musicPositions.get(asset.id) ?? 0 : 0;
      const restorePosition = () => {
        if (savedPosition <= 0 || !ownsPlayback()) return;
        try { player.currentTime = Number.isFinite(player.duration) && player.duration > 0 ? savedPosition % player.duration : savedPosition; } catch { /* Metadata callback retries seeking when the stream is ready. */ }
      };
      const tryUrl = (index: number) => {
        const request = ++attempt;
        let playPending = false;
        liveVoice.cancelMediaRecovery?.();
        const onFailure = (allowFallback: boolean) => {
          if (!acceptsCallback(request)) return;
          if (allowFallback && urls[index + 1]) { tryUrl(index + 1); return; }
          failStream(asset.id); cleanup(liveVoice); scheduleStreamRetry(); publish();
        };
        player.onerror = () => onFailure(true);
        player.onloadedmetadata = () => { restorePosition(); envelope?.refresh(); };
        player.src = preparedMusic.get(urls[index])?.url ?? urls[index]; restorePosition();
        const playCurrent = () => {
          if (playPending || !ownsPlayback() || request !== attempt) return;
          playPending = true;
          // A failed codec may use the fallback; autoplay denial needs a new gesture instead.
          void player.play().then(() => {
            playPending = false;
            if (!acceptsCallback(request)) return;
            envelope?.refresh();
            failedStreams.delete(asset.id); blockedStreams.delete(asset.id); scheduleStreamRetry(); publish();
          }).catch((error: unknown) => {
            playPending = false;
            if (!acceptsCallback(request)) return;
            const name = error instanceof Error ? error.name : "";
            if (name === "NotAllowedError") blockedStreams.add(asset.id);
            onFailure(name !== "NotAllowedError" && name !== "AbortError");
          });
        };
        player.onpause = player.onended = () => {
          envelope?.refresh();
          if (pauseRecovery !== null || playPending || liveVoice.stopped || request !== attempt || voices.get(key) !== liveVoice
            || !key.startsWith("loop:") || !audible(cue.bus) || !(player.paused || player.ended)) return;
          pauseRecovery = setTimeout(() => {
            pauseRecovery = null;
            if (liveVoice.stopped || voices.get(key) !== liveVoice || !audible(cue.bus)
              || !targets().some(target => `loop:${target.id}` === key && target.cueId === cue.id) || !(player.paused || player.ended)) return;
            // Native media can pause while AudioContext remains running. Reuse
            // this deck and its currentTime; never restart it on every frame.
            playCurrent();
          }, MEDIA_PAUSE_RECOVERY_MS);
        };
        playCurrent();
      };
      tune(liveVoice, gain, pan);
      // HTMLMediaElement keeps long songs out of the decoded effect cache.
      tryUrl(0);
      publish();
    } catch {
      failStream(asset.id);
      if (voice) cleanup(voice);
      else if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
      scheduleStreamRetry(); publish();
    }
  }
  function targets(): AudioLoopTarget[] {
    const unique = new Map<string, AudioLoopTarget>();
    for (const target of frame?.loops ?? []) {
      const cue = cues.get(target.cueId);
      if (cue && cue.mode !== "one-shot" && Number.isFinite(target.gain) && target.gain > .001 && audible(cue.bus)) unique.set(`loop:${target.id}`, target);
    }
    // Rank only playable instances: twelve construction sites with a one-voice
    // cue must not occupy every slot and silently evict the forest ambience.
    // A modest preference for an active emitter avoids swapping equal-distance
    // sources on every camera pixel; a clearly closer source still takes over.
    const score = (target: AudioLoopTarget) => target.gain * (voices.get(`loop:${target.id}`)?.cue.id === target.cueId ? 1.15 : 1);
    const ranked = [...unique.values()].sort((a, b) => (b.priority ?? cues.get(b.cueId)!.priority)
      - (a.priority ?? cues.get(a.cueId)!.priority) || score(b) - score(a));
    const selected: AudioLoopTarget[] = [], instances = new Map<string, number>();
    for (const target of ranked) {
      const count = instances.get(target.cueId) ?? 0;
      if (count >= Math.max(1, cues.get(target.cueId)!.maxInstances)) continue;
      instances.set(target.cueId, count + 1); selected.push(target);
      if (selected.length === MAX_LOOPS) break;
    }
    return selected;
  }
  function reconcile() {
    if (!audible()) { cancelStreamRetry(); return; }
    const wanted = new Map(targets().map(target => [`loop:${target.id}`, target]));
    for (const [key, pending] of pendingLoops) if (wanted.get(key)?.cueId !== pending.cueId) pendingLoops.delete(key);
    for (const [key, voice] of voices) if (key.startsWith("loop:") && borrowedPreview?.voice !== voice && wanted.get(key)?.cueId !== voice.cue.id) {
      if (!wanted.has(key) && voice.cue.mode === "loop") releaseLoop(voice);
      else stopVoice(voice);
    }
    for (const [key, target] of wanted) {
      const cue = cues.get(target.cueId)!;
      const priority = target.priority ?? cue.priority;
      const active = voices.get(key) ?? reclaimLoop(key, cue, priority);
      if (active) {
        pendingLoops.delete(key);
        if (borrowedPreview?.voice !== active) tune(active, target.gain, target.pan);
        continue;
      }
      if (pendingLoops.has(key)) continue;
      const savedAsset = assets.get(loopTimelines.get(key)?.assetId ?? "");
      const asset = savedAsset?.status === "ready" && savedAsset.src && cue.assets.includes(savedAsset.id) ? savedAsset : chooseAsset(cue);
      if (!asset) continue;
      if (cue.mode === "music") { startMusic(key, cue, asset, target.gain, target.pan, priority); continue; }
      const token: PendingLoop = { cueId: cue.id, generation };
      pendingLoops.set(key, token);
      loadBuffer(asset, buffer => {
        if (pendingLoops.get(key) !== token) return;
        pendingLoops.delete(key);
        const current = targets().find(item => `loop:${item.id}` === key && item.cueId === cue.id);
        if (buffer && current && token.generation === generation) startBuffer(key, cue, asset, buffer, current.gain, current.pan, current.priority ?? cue.priority);
      }, 20);
    }
    scheduleStreamRetry(); publish();
  }

  function ensureContext(): boolean {
    if (disposed) return false;
    if (context) return context.state !== "closed";
    try {
      context = (options.createContext ?? defaultContext)();
      master = context.createGain(); master.gain.value = 0;
      if (typeof context.createDynamicsCompressor === "function") {
        compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -3; compressor.knee.value = 6; compressor.ratio.value = 12;
        compressor.attack.value = .003; compressor.release.value = .25;
        master.connect(compressor); compressor.connect(context.destination);
      } else master.connect(context.destination);
      for (const bus of AUDIO_BUSES) { const gain = context.createGain(); gain.gain.value = settings.buses[bus]; gain.connect(master); buses.set(bus, gain); }
      context.onstatechange = () => {
        if (disposed) return;
        if (context?.state !== "running") invalidate(true);
        else if (everUnlocked && visible && settings.enabled) { updateMix(); reconcile(); }
        publish();
      };
      unavailable = false;
      return true;
    } catch { unavailable = true; publish(); return false; }
  }

  async function unlock(): Promise<boolean> {
    if (disposed || !visible || !settings.enabled || !ensureContext()) return false;
    unavailable = false;
    try {
      // A running context may still have gesture-blocked HTML media. Retry those
      // synchronously in this gesture, without yielding to context.resume().
      if (context!.state === "running") {
        everUnlocked = true;
        for (const id of blockedStreams) failedStreams.delete(id);
        blockedStreams.clear();
        updateMix(); reconcile(); publish(); return true;
      }
      // Invoked directly in the user gesture, before any await.
      await context!.resume();
      if (disposed || !visible || !settings.enabled) {
        if (!disposed && contextIsRunning()) void context!.suspend().catch(() => {});
        return false;
      }
      everUnlocked = contextIsRunning();
      if (everUnlocked) {
        // A new gesture is allowed to retry blocked media playback immediately.
        for (const id of blockedStreams) failedStreams.delete(id);
        blockedStreams.clear(); updateMix(); reconcile();
      }
      publish(); return everUnlocked;
    } catch { publish(); return false; }
  }

  function prepareMusic(asset: AudioAsset): Promise<void> {
    const urls = [...new Set([asset.src, asset.fallbackSrc].filter((url): url is string => Boolean(url)))];
    if (!urls.length || typeof URL.createObjectURL !== "function") return Promise.resolve();
    if (urls.some(url => preparedMusic.has(url))) return Promise.resolve();
    const alreadyPending = urls.map(url => pendingMusic.get(url)).find(Boolean);
    if (alreadyPending) return alreadyPending;
    // Prefer the codec this browser can stream. A full song stays compressed;
    // its cached Blob is consumed by HTMLAudioElement, not decodeAudioData.
    const player = options.createMediaElement?.() ?? (typeof Audio === "function" ? new Audio() : null);
    const mime = (url: string) => /\.m4a(?:\?|$)/.test(url) ? 'audio/mp4; codecs="mp4a.40.2"'
      : /\.opus(?:\?|$)/.test(url) ? 'audio/ogg; codecs="opus"' : /\.mp3(?:\?|$)/.test(url) ? "audio/mpeg" : "audio/wav";
    const url = urls.find(candidate => !player?.canPlayType || Boolean(player.canPlayType(mime(candidate)))) ?? urls[0];
    if (preparedMusic.has(url)) return Promise.resolve();
    const existing = pendingMusic.get(url);
    if (existing) return existing;
    const controller = new AbortController(); preparationControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12_000);
    const pending = (async () => {
      try {
        const response = await transport.fetch(url, { signal: controller.signal, credentials: "same-origin" });
        if (!response.ok) return;
        const length = Number(response.headers.get("content-length"));
        if (length > 12 * 1024 * 1024) return;
        const blob = await response.blob();
        if (disposed || controller.signal.aborted || blob.size > MAX_PREPARED_MUSIC_BYTES) return;
        let bytes = [...preparedMusic.values()].reduce((total, item) => total + item.bytes, 0);
        for (const [key, cached] of preparedMusic) {
          if (bytes + blob.size <= MAX_PREPARED_MUSIC_BYTES && preparedMusic.size < MAX_MUSIC_DECKS) break;
          // A stream already playing its Blob must retain that URL.
          if ([...voices.values(), ...retiring.values()].some(voice => voice.media?.src === cached.url)) continue;
          URL.revokeObjectURL(cached.url); preparedMusic.delete(key); bytes -= cached.bytes;
        }
        if (bytes + blob.size <= MAX_PREPARED_MUSIC_BYTES && preparedMusic.size < MAX_MUSIC_DECKS)
          preparedMusic.set(url, { url: URL.createObjectURL(blob), bytes: blob.size });
      } catch { /* Preparation is optional; normal streaming can retry later. */ }
      finally { controller.abort(); clearTimeout(timer); preparationControllers.delete(controller); pendingMusic.delete(url); }
    })();
    pendingMusic.set(url, pending);
    return pending;
  }

  async function prepareEncoded(asset: AudioAsset): Promise<void> {
    if (!asset.src) return;
    const controller = new AbortController(); preparationControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await transport.fetch(asset.src, { signal: controller.signal, credentials: "same-origin" });
      if (response.ok && Number(response.headers.get("content-length")) <= 12 * 1024 * 1024) await response.arrayBuffer();
    } catch { /* Muted prefetch never blocks app entry or requires audio permission. */ }
    finally { controller.abort(); clearTimeout(timer); preparationControllers.delete(controller); }
  }

  async function prepare(cueIds: readonly string[], config?: { signal?: AbortSignal }): Promise<void> {
    const signal = config?.signal;
    if (disposed || signal?.aborted) return;
    // Muted first visits still warm encoded files without acquiring an audio
    // device or decoding buffers. Enabling sound later uses those cached bytes.
    const decodingAllowed = settings.enabled && settings.master > 0 && visible && ensureContext();
    // A returning visitor may already have browser autoplay permission. Never
    // await resume here: a denied/pending permission must not hold the splash.
    if (!preparationAutoplayAttempted && decodingAllowed) {
      preparationAutoplayAttempted = true;
      void unlock();
    }
    for (const id of [...new Set(cueIds)].slice(0, 16)) {
      if (disposed || signal?.aborted) break;
      const cue = cues.get(id);
      if (!cue) continue;
      const ready = cue.assets.map(assetId => assets.get(assetId))
        .filter((item): item is AudioAsset => item?.status === "ready" && Boolean(item.src));
      // Tiny UI variants are all needed: the first real tap is randomized.
      for (const asset of ready.slice(0, cue.mode === "one-shot" ? 4 : 1)) {
        if (disposed || signal?.aborted) break;
        const work = cue.mode === "music" ? prepareMusic(asset)
          : decodingAllowed ? new Promise<void>(resolve => { loadBuffer(asset, () => resolve(), 0); })
            : prepareEncoded(asset);
        if (!signal) await work;
        else await new Promise<void>(resolve => {
          const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
          signal.addEventListener("abort", finish, { once: true });
          void work.then(finish, finish);
          if (signal.aborted) finish();
        });
      }
    }
  }

  const runtime: AudioRuntime = {
    unlock, prepare,
    setSettings(patch) {
      if (disposed) return;
      const previous = settings;
      settings = mergeAudioSettings(settings, patch);
      if (JSON.stringify(previous) === JSON.stringify(settings)) { settings = previous; return; }
      if (!settings.enabled || settings.master === 0) invalidate();
      else {
        if (AUDIO_BUSES.some(bus => previous.buses[bus] > 0 && settings.buses[bus] === 0)) { generation++; pendingLoops.clear(); pendingEvents.clear(); }
        for (const voice of [...voices.values(), ...retiring.values()]) if (settings.buses[voice.cue.bus] === 0 || !feedbackAudible(voice.feedbackBus)) {
          if (voice.reclaimable) cleanup(voice); else if (voices.get(voice.key) === voice) stopVoice(voice);
        }
        reconcile();
      }
      updateMix(); publish();
    },
    getSettings: () => settings,
    updateFrame(next) {
      if (disposed) return;
      if (frameClearTimer) { clearTimeout(frameClearTimer); frameClearTimer = null; }
      if (lastSceneId !== null && lastSceneId !== next.sceneId) {
        invalidate(); eventIds.clear(); cooldowns.clear(); playbackCooldowns.clear(); musicPositions.clear(); loopTimelines.clear(); blockedStreams.clear();
      }
      if (next.soundscape === false && frame?.soundscape !== false) {
        soundscapeGeneration++;
        if (borrowedPreview && SOUNDSCAPE_BUSES.has(borrowedPreview.voice.cue.bus)) releaseBorrowedPreview();
        // Leaving the map also fades ongoing footsteps/voices. An ambient loop
        // may still be reclaimed if the map is reopened during its fade, but old
        // asynchronous action decodes must never catch up in the new visit.
        for (const voice of [...voices.values()]) if (SOUNDSCAPE_BUSES.has(voice.cue.bus) && !voice.key.startsWith("loop:")) stopVoice(voice);
      }
      lastSceneId = next.sceneId;
      frame = next;
      updateMix(); reconcile(); publish();
    },
    clearFrame(ownerId) {
      if (!frame || frame.ownerId !== ownerId || disposed) return;
      frame = null;
      cancelStreamRetry();
      if (![...voices.values()].some(voice => voice.key.startsWith("loop:"))) {
        invalidate(); updateMix(); publish(); return;
      }
      // Invalidate pending events immediately. Existing loops get a brief handoff window
      // so circle and fullscreen canvases can exchange ownership without restarting music.
      generation++; pendingLoops.clear(); pendingEvents.clear();
      for (const voice of [...voices.values()]) if (!voice.key.startsWith("loop:")) stopVoice(voice);
      frameClearTimer = setTimeout(() => {
        frameClearTimer = null;
        if (!frame && !disposed) { invalidate(); updateMix(); publish(); }
      }, 120);
      publish();
    },
    play(event: AudioEvent) {
      if (disposed) return;
      const cue = cues.get(event.cueId);
      const time = now();
      const occurredAt = event.occurredAt ?? time;
      const eventTtl = Number.isFinite(event.maxAgeMs) ? Math.max(0, Math.min(EVENT_TTL_MS, event.maxAgeMs!)) : EVENT_TTL_MS;
      const sliderRequest = cue?.id === "ui.slider" ? ++latestSliderRequest : null;
      const feedbackBus = sliderRequest !== null ? event.feedbackBus : undefined;
      for (const [id, seenAt] of eventIds) if (time - seenAt > DEDUP_TTL_MS) eventIds.delete(id);
      if (!cue || cue.mode !== "one-shot" || !event.id || eventIds.has(event.id) || !Number.isFinite(occurredAt)
        || time - occurredAt > eventTtl || occurredAt - time > 1000) { droppedEvents++; publish(); return; }
      eventIds.set(event.id, time);
      while (eventIds.size > MAX_EVENT_IDS) eventIds.delete(eventIds.keys().next().value!);
      // Events while muted, backgrounded or locked are consumed, never queued for replay.
      if (!audible(cue.bus) || !feedbackAudible(feedbackBus) || (event.gain ?? 1) <= 0
        || time - (cooldowns.get(cue.id) ?? -Infinity) < cue.cooldownMs) { droppedEvents++; publish(); return; }
      if (pendingEvents.size >= MAX_VOICES) { droppedEvents++; publish(); return; }
      const asset = chooseAsset(cue);
      if (!asset) { droppedEvents++; publish(); return; }
      cooldowns.set(cue.id, time);
      const token = generation;
      const soundscapeToken = soundscapeGeneration;
      const request = ++sequence;
      pendingEvents.add(request);
      lastEvent = cue.id; publish();
      loadBuffer(asset, buffer => {
        pendingEvents.delete(request);
        if (buffer && token === generation && (!SOUNDSCAPE_BUSES.has(cue.bus) || soundscapeToken === soundscapeGeneration)
          && feedbackAudible(feedbackBus) && (sliderRequest === null || sliderRequest === latestSliderRequest)
          && now() - occurredAt <= Math.min(eventTtl, sliderRequest === null ? EVENT_TTL_MS : 180)) {
          // Several contacts can await the same cold download/decode. Their
          // request-time cooldowns do not prevent every callback from playing
          // at once when it finishes; enforce spacing at actual playback too.
          const startedAt = now();
          if (startedAt - (playbackCooldowns.get(cue.id) ?? -Infinity) < cue.cooldownMs
            || !startBuffer(`event:${++sequence}`, cue, asset, buffer, event.gain ?? 1, event.pan ?? 0, cue.priority, event.playbackRate, feedbackBus)) { droppedEvents++; publish(); }
          else playbackCooldowns.set(cue.id, startedAt);
        }
      }, cue.bus === "ui" ? 100 : 60);
    },
    preview(cueId) {
      if (process.env.NODE_ENV === "production" || disposed) return;
      const cue = cues.get(cueId);
      if (!cue || !audible(cue.bus)) return;
      const auditionToken = ++audition;
      releaseBorrowedPreview();
      for (const voice of [...voices.values()]) if (voice.key.startsWith("preview:")) stopVoice(voice);
      reconcile();
      if (cue.mode === "one-shot") { runtime.play({ id: `preview:${++sequence}`, cueId }); return; }
      // Scene beds have maxInstances=1. Audition their existing voice without
      // creating a second deck or restarting the song; restore the latest scene
      // target after four seconds, including camera changes during the preview.
      if (borrowSceneVoice(cueId)) return;
      // A bounded audition has no scene ownership and cannot outlive mute/dispose.
      const asset = chooseAsset(cue);
      if (!asset) return;
      const key = `preview:${++sequence}`;
      const token = generation;
      const scheduleStop = () => {
        const voice = voices.get(key);
        if (voice) voice.timer = setTimeout(() => stopVoice(voice), 4000);
      };
      if (cue.mode === "music") { startMusic(key, cue, asset, 1, 0, cue.priority); scheduleStop(); }
      else loadBuffer(asset, buffer => {
        if (token !== generation || auditionToken !== audition || !buffer) return;
        // A scene request can finish the same shared decode before this callback.
        if (!borrowSceneVoice(cueId) && startBuffer(key, cue, asset, buffer, 1, 0, cue.priority)) scheduleStop();
      });
    },
    previewTone(bus = "ui") {
      if (process.env.NODE_ENV === "production" || !audible(bus) || !buses.has(bus)) return;
      const cue: AudioCue = { id: "dev.test-tone", bus, mode: "one-shot", assets: [], gainDb: -24, priority: 100, maxInstances: 1, cooldownMs: 200, pitchVariation: 0, fadeMs: 20 };
      if (!roomFor(cue, cue.priority)) return;
      const source = context!.createOscillator(); source.type = "sine"; source.frequency.value = 440;
      const voice = wireVoice(`tone:${++sequence}`, cue, "dev.test-tone", source, null, cue.priority);
      tune(voice, 1, 0); source.start();
      voice.gain.gain.setValueAtTime(dbGain(-24), context!.currentTime + .15);
      voice.gain.gain.linearRampToValueAtTime(0, context!.currentTime + .23);
      // This bounded test tone has its own attack/hold/release envelope. A later
      // mute must sample it, rather than reuse the initial attack-only segment.
      parameterRamps.delete(voice.gain.gain);
      source.stop(context!.currentTime + .25); publish();
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        invalidate(true);
        if (context && context.state !== "closed") void context.suspend().then(() => {
          // Repair a hide/show race where an old suspension finishes after foreground resume.
          if (visible && settings.enabled && everUnlocked && !disposed) void unlock();
        }).catch(() => {});
      } else if (everUnlocked && settings.enabled) void unlock();
      updateMix(); publish();
    },
    getDiagnostics: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    dispose() {
      if (disposed) return;
      disposed = true; frame = null;
      if (frameClearTimer) { clearTimeout(frameClearTimer); frameClearTimer = null; }
      invalidate(true); cache.dispose(); transport.dispose();
      for (const controller of preparationControllers) controller.abort();
      preparationControllers.clear(); pendingMusic.clear();
      for (const cached of preparedMusic.values()) URL.revokeObjectURL(cached.url);
      preparedMusic.clear();
      eventIds.clear(); cooldowns.clear(); playbackCooldowns.clear(); lastVariants.clear(); failedStreams.clear(); blockedStreams.clear(); musicPositions.clear(); loopTimelines.clear();
      if (context) {
        context.onstatechange = null;
        for (const gain of buses.values()) gain.disconnect();
        master?.disconnect(); compressor?.disconnect();
        void context.close().catch(() => {});
      }
      buses.clear(); publish(); subscribers.clear();
    },
  };
  publish();
  return runtime;
}
