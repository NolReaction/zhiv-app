import { AUDIO_CATALOG } from "@/features/audio/catalog/catalog";
import { mergeAudioSettings, sanitizeAudioSettings } from "@/features/audio/domain/settings";
import { AUDIO_BUSES, type AudioAsset, type AudioBus, type AudioCatalog, type AudioCue, type AudioDiagnostics, type AudioEvent, type AudioFrame, type AudioLoopTarget, type AudioRuntime, type AudioSettings, type AudioSourceDebug } from "@/features/audio/domain/types";
import { createAudioAssetCache } from "./audio-asset-cache";

const MAX_VOICES = 24;
const MAX_LOOPS = 10;
const MAX_MUSIC_DECKS = 2;
const EVENT_TTL_MS = 2_000;
const MAX_EVENT_IDS = 512;
const DEDUP_TTL_MS = 60_000;
const STREAM_RETRY_MS = 30_000;

type Voice = {
  key: string; serial: number; cue: AudioCue; assetId: string; priority: number;
  gain: GainNode; panner: StereoPannerNode | null; source: AudioBufferSourceNode | MediaElementAudioSourceNode | OscillatorNode;
  media: HTMLAudioElement | null; createdAt: number; timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean; sceneId: string | null;
};
type PendingLoop = { cueId: string; generation: number };
export type AudioRuntimeOptions = {
  catalog?: AudioCatalog;
  initialSettings?: AudioSettings;
  createContext?: () => AudioContext;
  createMediaElement?: () => HTMLAudioElement;
  fetchAsset?: typeof fetch;
  now?: () => number;
  random?: () => number;
  maxDecodedBytes?: number;
};

const finiteClamp = (value: number, low: number, high: number, fallback = low) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
const dbGain = (db: number) => 10 ** (finiteClamp(db, -60, 0) / 20);
const defaultContext = () => {
  const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) throw new Error("Web Audio unavailable");
  return new Constructor({ latencyHint: "interactive" });
};

/** One application-wide mixer. Browser resources are only acquired from unlock(). */
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
  let visible = true;
  let disposed = false;
  let unavailable = false;
  let everUnlocked = false;
  let generation = 0;
  let sequence = 0;
  let audition = 0;
  let lastEvent: string | null = null;
  let droppedEvents = 0;
  let snapshot: AudioDiagnostics;
  const subscribers = new Set<() => void>();
  const voices = new Map<string, Voice>();
  const retiring = new Map<number, Voice>();
  const pendingLoops = new Map<string, PendingLoop>();
  const eventIds = new Map<string, number>();
  const cooldowns = new Map<string, number>();
  const lastVariants = new Map<string, string>();
  const failedStreams = new Map<string, number>();
  const blockedStreams = new Set<string>();
  const musicPositions = new Map<string, number>();
  const bufferClaims = new Map<string, number>();
  const pendingEvents = new Set<number>();
  const cache = createAudioAssetCache({ context: () => context, fetchAsset: options.fetchAsset ?? ((...args) => fetch(...args)), now,
    maxDecodedBytes: options.maxDecodedBytes, changed: publish,
    isInUse: id => (bufferClaims.get(id) ?? 0) > 0 || [...voices.values(), ...retiring.values()].some(voice => voice.assetId === id),
  });

  function state(): AudioDiagnostics["state"] {
    if (disposed) return "disposed";
    if (unavailable) return "unavailable";
    if (!context || !everUnlocked) return "locked";
    return visible && settings.enabled && context.state === "running" && blockedStreams.size === 0 ? "running" : "suspended";
  }
  function publish() {
    const sources: AudioSourceDebug[] = (frame?.sources ?? []).slice(0, 64).map(source => ({ ...source,
      gain: Math.round(source.gain * 100) / 100, pan: Math.round(source.pan * 100) / 100,
    }));
    const next: AudioDiagnostics = { state: state(), settings, activeVoices: voices.size,
      loadedAssets: cache.loadedCount(), pendingAssets: catalog.assets.filter(asset => asset.status === "pending").length + cache.loadingCount(),
      failedAssets: [...new Set([...cache.failedIds(), ...failedStreams.keys()])], sources, lastEvent, droppedEvents };
    // useSyncExternalStore needs referential stability, including while scene frames keep arriving.
    if (snapshot && snapshot.settings === settings && snapshot.state === next.state && snapshot.activeVoices === next.activeVoices
      && snapshot.loadedAssets === next.loadedAssets && snapshot.pendingAssets === next.pendingAssets && snapshot.lastEvent === next.lastEvent
      && snapshot.droppedEvents === next.droppedEvents && JSON.stringify(snapshot.sources) === JSON.stringify(sources)
      && JSON.stringify(snapshot.failedAssets) === JSON.stringify(next.failedAssets)) return;
    snapshot = next;
    for (const listener of subscribers) { try { listener(); } catch { /* A subscriber cannot interrupt game audio cleanup. */ } }
  }
  function contextIsRunning() { return context?.state === "running"; }
  function audible(bus?: AudioBus) {
    return !disposed && visible && settings.enabled && settings.master > 0 && context?.state === "running"
      && (!bus || settings.buses[bus] > 0);
  }
  function ramp(param: AudioParam, target: number, seconds: number) {
    if (!context) return;
    const time = context.currentTime;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(time);
    else { param.cancelScheduledValues(time); param.setValueAtTime(param.value, time); }
    param.linearRampToValueAtTime(target, time + Math.max(.01, seconds));
  }
  function updateMix() {
    if (!master) return;
    ramp(master.gain, settings.enabled && visible ? settings.master : 0, .12);
    for (const [bus, node] of buses) ramp(node.gain, settings.buses[bus] * (bus === "music" ? finiteClamp(frame?.musicDuck ?? 1, 0, 1) : 1), bus === "music" ? .8 : .12);
  }
  function cleanup(voice: Voice) {
    if (voice.stopped) return;
    voice.stopped = true;
    if (voice.timer) clearTimeout(voice.timer);
    if (voices.get(voice.key) === voice) voices.delete(voice.key);
    retiring.delete(voice.serial);
    if (voice.media) {
      if (voice.key.startsWith("loop:") && voice.sceneId === lastSceneId && Number.isFinite(voice.media.currentTime) && voice.media.currentTime > 0) musicPositions.set(voice.assetId, voice.media.currentTime);
      voice.media.onerror = null; voice.media.onloadedmetadata = null;
      voice.media.pause();
      voice.media.removeAttribute("src");
      voice.media.load();
    } else {
      const source = voice.source as AudioBufferSourceNode | OscillatorNode;
      source.onended = null;
      try { source.stop(); } catch { /* An already completed one-shot needs only disconnection. */ }
    }
    voice.source.disconnect(); voice.gain.disconnect(); voice.panner?.disconnect();
    publish();
  }
  function stopVoice(voice: Voice, immediate = false) {
    if (voice.stopped) return;
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
  function invalidate(immediate = false) {
    generation++;
    pendingLoops.clear(); pendingEvents.clear();
    for (const voice of [...voices.values()]) stopVoice(voice, immediate);
    if (immediate) for (const voice of [...retiring.values()]) cleanup(voice);
  }
  function loadBuffer(asset: AudioAsset, consume: (buffer: AudioBuffer | null) => void) {
    // Reserve through the consumer callback: another simultaneous decode must not evict
    // a buffer in the microtask gap between load completion and voice creation.
    bufferClaims.set(asset.id, (bufferClaims.get(asset.id) ?? 0) + 1);
    void cache.load(asset).then(consume).catch(() => { droppedEvents++; publish(); }).finally(() => {
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
    source.connect(gain);
    if (panner) { gain.connect(panner); panner.connect(buses.get(cue.bus)!); }
    else gain.connect(buses.get(cue.bus)!);
    const voice: Voice = { key, serial: ++sequence, cue, assetId, priority, gain, panner, source, media, createdAt: now(), timer: null, stopped: false, sceneId: frame?.sceneId ?? lastSceneId };
    voices.set(key, voice);
    if (!media) (source as AudioBufferSourceNode | OscillatorNode).onended = () => cleanup(voice);
    return voice;
  }
  function tune(voice: Voice, gain: number, pan: number) {
    ramp(voice.gain.gain, dbGain(voice.cue.gainDb) * finiteClamp(gain, 0, 4), Math.max(.025, Math.min(1.5, voice.cue.fadeMs / 1000)));
    if (voice.panner) ramp(voice.panner.pan, finiteClamp(pan, -1, 1), .1);
  }
  function startBuffer(key: string, cue: AudioCue, asset: AudioAsset, buffer: AudioBuffer, gain: number, pan: number, priority: number) {
    if (!audible(cue.bus) || !roomFor(cue, priority)) return false;
    const source = context!.createBufferSource();
    source.buffer = buffer;
    source.loop = cue.mode === "loop";
    if (source.loop) {
      source.loopStart = finiteClamp(asset.loopStart ?? 0, 0, Math.max(0, buffer.duration - .01));
      source.loopEnd = finiteClamp(asset.loopEnd ?? buffer.duration, source.loopStart + .01, buffer.duration, buffer.duration);
    }
    source.playbackRate.value = 1 + (finiteClamp(random(), 0, 1) * 2 - 1) * finiteClamp(cue.pitchVariation, 0, .08);
    const voice = wireVoice(key, cue, asset.id, source, null, priority);
    tune(voice, gain, pan);
    try { source.start(); } catch { cleanup(voice); return false; }
    publish();
    return true;
  }
  function startMusic(key: string, cue: AudioCue, asset: AudioAsset, gain: number, pan: number, priority: number) {
    if (!audible(cue.bus) || !roomFor(cue, priority)) return;
    const failedAt = failedStreams.get(asset.id);
    if (failedAt !== undefined && now() - failedAt < STREAM_RETRY_MS) return;
    let voice: Voice | null = null;
    let media: HTMLAudioElement | null = null;
    try {
      media = options.createMediaElement?.() ?? new Audio();
      media.preload = "none"; media.loop = true; media.crossOrigin = "anonymous";
      const source = context!.createMediaElementSource(media);
      voice = wireVoice(key, cue, asset.id, source, media, priority);
      const liveVoice = voice;
      const player = media;
      const urls = [...new Set([asset.src, asset.fallbackSrc].filter((url): url is string => Boolean(url)))];
      let attempt = 0;
      const savedPosition = key.startsWith("loop:") ? musicPositions.get(asset.id) ?? 0 : 0;
      const restorePosition = () => {
        if (savedPosition <= 0 || liveVoice.stopped) return;
        try { player.currentTime = Number.isFinite(player.duration) && player.duration > 0 ? savedPosition % player.duration : savedPosition; } catch { /* Metadata callback retries seeking when the stream is ready. */ }
      };
      const tryUrl = (index: number) => {
        const request = ++attempt;
        const onFailure = (allowFallback: boolean) => {
          if (liveVoice.stopped || disposed || request !== attempt) return;
          if (allowFallback && urls[index + 1]) { tryUrl(index + 1); return; }
          failedStreams.set(asset.id, now()); cleanup(liveVoice); publish();
        };
        player.onerror = () => onFailure(true);
        player.onloadedmetadata = restorePosition;
        player.src = urls[index]; restorePosition();
        // A failed codec may use the fallback; autoplay denial needs a new gesture instead.
        void player.play().then(() => {
          if (liveVoice.stopped) { player.pause(); return; }
          if (request !== attempt) return;
          failedStreams.delete(asset.id); blockedStreams.delete(asset.id); publish();
        }).catch((error: unknown) => {
          const name = error instanceof Error ? error.name : "";
          if (name === "NotAllowedError" && !liveVoice.stopped && request === attempt) blockedStreams.add(asset.id);
          onFailure(name !== "NotAllowedError" && name !== "AbortError");
        });
      };
      tune(liveVoice, gain, pan);
      // HTMLMediaElement keeps long songs out of the decoded effect cache.
      tryUrl(0);
      publish();
    } catch {
      failedStreams.set(asset.id, now());
      if (voice) cleanup(voice);
      else if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
      publish();
    }
  }
  function targets(): AudioLoopTarget[] {
    const unique = new Map<string, AudioLoopTarget>();
    for (const target of frame?.loops ?? []) {
      const cue = cues.get(target.cueId);
      if (cue && cue.mode !== "one-shot" && Number.isFinite(target.gain) && target.gain > .001 && audible(cue.bus)) unique.set(`loop:${target.id}`, target);
    }
    return [...unique.values()].sort((a, b) => (b.priority ?? cues.get(b.cueId)!.priority) - (a.priority ?? cues.get(a.cueId)!.priority)).slice(0, MAX_LOOPS);
  }
  function reconcile() {
    if (!audible()) return;
    const wanted = new Map(targets().map(target => [`loop:${target.id}`, target]));
    for (const [key, pending] of pendingLoops) if (wanted.get(key)?.cueId !== pending.cueId) pendingLoops.delete(key);
    for (const [key, voice] of voices) if (key.startsWith("loop:") && wanted.get(key)?.cueId !== voice.cue.id) stopVoice(voice);
    for (const [key, target] of wanted) {
      const cue = cues.get(target.cueId)!;
      const active = voices.get(key);
      if (active) { tune(active, target.gain, target.pan); continue; }
      if (pendingLoops.has(key)) continue;
      const asset = chooseAsset(cue);
      if (!asset) continue;
      const priority = target.priority ?? cue.priority;
      if (cue.mode === "music") { startMusic(key, cue, asset, target.gain, target.pan, priority); continue; }
      const token: PendingLoop = { cueId: cue.id, generation };
      pendingLoops.set(key, token);
      loadBuffer(asset, buffer => {
        if (pendingLoops.get(key) !== token) return;
        pendingLoops.delete(key);
        const current = targets().find(item => `loop:${item.id}` === key && item.cueId === cue.id);
        if (buffer && current && token.generation === generation) startBuffer(key, cue, asset, buffer, current.gain, current.pan, current.priority ?? cue.priority);
      });
    }
    publish();
  }

  async function unlock(): Promise<boolean> {
    if (disposed || !visible || !settings.enabled) return false;
    if (!context) {
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
          if (context?.state !== "running") invalidate(true);
          publish();
        };
      } catch { unavailable = true; publish(); return false; }
    }
    unavailable = false;
    try {
      // A running context may still have gesture-blocked HTML media. Retry those
      // synchronously in this gesture, without yielding to context.resume().
      if (context.state === "running") {
        everUnlocked = true;
        for (const id of blockedStreams) failedStreams.delete(id);
        blockedStreams.clear();
        updateMix(); reconcile(); publish(); return true;
      }
      // Invoked directly in the user gesture, before any await.
      await context.resume();
      if (disposed || !visible || !settings.enabled) {
        if (!disposed && contextIsRunning()) void context.suspend().catch(() => {});
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

  const runtime: AudioRuntime = {
    unlock,
    setSettings(patch) {
      if (disposed) return;
      const previous = settings;
      settings = mergeAudioSettings(settings, patch);
      if (JSON.stringify(previous) === JSON.stringify(settings)) { settings = previous; return; }
      if (!settings.enabled || settings.master === 0) invalidate();
      else {
        if (AUDIO_BUSES.some(bus => previous.buses[bus] > 0 && settings.buses[bus] === 0)) { generation++; pendingLoops.clear(); pendingEvents.clear(); }
        for (const voice of [...voices.values()]) if (settings.buses[voice.cue.bus] === 0) stopVoice(voice);
        reconcile();
      }
      updateMix(); publish();
    },
    getSettings: () => settings,
    updateFrame(next) {
      if (disposed) return;
      if (frameClearTimer) { clearTimeout(frameClearTimer); frameClearTimer = null; }
      if (lastSceneId !== null && lastSceneId !== next.sceneId) {
        invalidate(); eventIds.clear(); cooldowns.clear(); musicPositions.clear(); blockedStreams.clear();
      }
      lastSceneId = next.sceneId;
      frame = next;
      updateMix(); reconcile(); publish();
    },
    clearFrame(ownerId) {
      if (!frame || frame.ownerId !== ownerId || disposed) return;
      frame = null;
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
      for (const [id, seenAt] of eventIds) if (time - seenAt > DEDUP_TTL_MS) eventIds.delete(id);
      if (!cue || cue.mode !== "one-shot" || !event.id || eventIds.has(event.id) || !Number.isFinite(occurredAt)
        || time - occurredAt > EVENT_TTL_MS || occurredAt - time > 1000) { droppedEvents++; publish(); return; }
      eventIds.set(event.id, time);
      while (eventIds.size > MAX_EVENT_IDS) eventIds.delete(eventIds.keys().next().value!);
      // Events while muted, backgrounded or locked are consumed, never queued for replay.
      if (!audible(cue.bus) || time - (cooldowns.get(cue.id) ?? -Infinity) < cue.cooldownMs) { droppedEvents++; publish(); return; }
      if (pendingEvents.size >= MAX_VOICES) { droppedEvents++; publish(); return; }
      const asset = chooseAsset(cue);
      if (!asset) { droppedEvents++; publish(); return; }
      cooldowns.set(cue.id, time);
      const token = generation;
      const request = ++sequence;
      pendingEvents.add(request);
      lastEvent = cue.id; publish();
      loadBuffer(asset, buffer => {
        pendingEvents.delete(request);
        if (buffer && token === generation && now() - occurredAt <= EVENT_TTL_MS) {
          if (!startBuffer(`event:${++sequence}`, cue, asset, buffer, event.gain ?? 1, event.pan ?? 0, cue.priority)) { droppedEvents++; publish(); }
        }
      });
    },
    preview(cueId) {
      if (process.env.NODE_ENV === "production" || disposed) return;
      const cue = cues.get(cueId);
      if (!cue || !audible(cue.bus)) return;
      const auditionToken = ++audition;
      for (const voice of [...voices.values()]) if (voice.key.startsWith("preview:")) stopVoice(voice);
      if (cue.mode === "one-shot") { runtime.play({ id: `preview:${++sequence}`, cueId }); return; }
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
        if (token === generation && auditionToken === audition && buffer && startBuffer(key, cue, asset, buffer, 1, 0, cue.priority)) scheduleStop();
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
      invalidate(true); cache.dispose();
      eventIds.clear(); cooldowns.clear(); lastVariants.clear(); failedStreams.clear(); blockedStreams.clear(); musicPositions.clear();
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
