import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";
import { distanceGain, stereoPan } from "@/features/audio/domain/spatial";
import type { TradeShipMotion } from "@/features/world/objects/trade-ship/trade-ship-motion";

// The opaque PNG has entered the real map by this point; the extended workshop sea is not a visibility signal.
export const TRADE_SHIP_ARRIVAL_AUDIO = { cueId: "ship.arrival", contactAt: 10.5, maxAgeMs: 350 } as const;
export const TRADE_SHIP_DEPARTURE_AUDIO = { cueId: "ship.departure", maxAgeMs: 350, transitionWindowMs: 1500 } as const;
export type TradeShipAudioInput = {
  /** Stable per voyage; DEV replays use their own monotonically new ID. */
  voyageId: string | null;
  /** Only confirmed production voyages can announce departure. */
  kind?: "arrival" | "dev";
  motion: TradeShipMotion | null;
  /** The already published full-map AudioFrame, never a second audio owner. */
  frame: AudioFrame | null;
  active: boolean;
  /** Actual intersection of the moving PNG with the visible map viewport. */
  visible: boolean;
  /** Persist the at-most-once contact before playback; false means already claimed. */
  claimHorn?: () => boolean;
  now?: number;
};

/** Observe live arrival contact and confirmed departure. Hidden/muted/stale contacts are consumed,
 * not queued for a later view or autoplay unlock. Rendering never invokes this. */
export function createTradeShipAudioController(runtime: Pick<AudioRuntime, "prepare" | "play" | "getSettings">) {
  let previous: { id: string; phase: TradeShipMotion["phase"]; elapsed: number; kind: TradeShipAudioInput["kind"]; owner: string | null; active: boolean; at: number } | null = null;
  let preparation: { id: string; abort: AbortController } | null = null, disposed = false;
  const consumed = new Set<string>();
  function stopPreparation() { preparation?.abort.abort(); preparation = null; }
  function consume(id: string) {
    consumed.add(id);
    while (consumed.size > 64) consumed.delete(consumed.values().next().value!);
  }
  function claim(input: TradeShipAudioInput) {
    try { return input.claimHorn?.() ?? true; } catch { return false; }
  }
  function playHorn(input: TradeShipAudioInput, cueId: string, id: string, occurredAt: number, maxAgeMs: number) {
    if (!input.motion || !input.frame) return;
    const motion = input.motion, listener = input.frame.listener;
    const position = { x: motion.x + motion.width * .5, y: motion.y + motion.width * .35 };
    const distance = Math.hypot(position.x - listener.position.x, position.y - listener.position.y);
    if (!Number.isFinite(distance)) return;
    // A visible port signal retains presence even at the full-map overview.
    const gain = .65 + .35 * distanceGain(distance, 120, 1000);
    runtime.play({ id, cueId, ownerId: input.frame.ownerId, occurredAt, maxAgeMs, gain, pan: stereoPan(position, listener) * .65 });
  }
  return {
    update(input: TradeShipAudioInput) {
      if (disposed) return;
      const { voyageId, motion, frame } = input, before = previous;
      const now = Number.isFinite(input.now) ? input.now! : Date.now();
      previous = voyageId && motion ? { id: voyageId, phase: motion.phase, elapsed: motion.elapsed,
        kind: input.kind, owner: frame?.ownerId ?? null, active: input.active, at: now } : null;
      const settings = runtime.getSettings();
      const soundEnabled = settings.enabled && settings.master > 0 && settings.buses.world > 0;
      const arriving = Boolean(voyageId && motion?.phase === "arriving");
      const waitingToDepart = Boolean(voyageId && input.kind === "arrival" && (motion?.phase === "docked" || motion?.phase === "deploying"));
      if ((!arriving && !waitingToDepart) || !input.active || !soundEnabled || !frame || frame.soundscape === false) stopPreparation();
      else if (!preparation || preparation.id !== voyageId) {
        stopPreparation();
        const abort = new AbortController(); preparation = { id: voyageId!, abort };
        const cues = input.kind === "arrival" ? [TRADE_SHIP_ARRIVAL_AUDIO.cueId, TRADE_SHIP_DEPARTURE_AUDIO.cueId] : [TRADE_SHIP_ARRIVAL_AUDIO.cueId];
        void runtime.prepare(cues, { signal: abort.signal }).catch(() => {});
      }
      if (input.kind === "arrival" && voyageId && motion?.phase === "departing") {
        const departureId = `${frame?.ownerId ?? "unheard"}:${voyageId}:departure-horn-v1`;
        if (consumed.has(departureId)) return;
        // Consume the first departure sample even when it is restored, muted or
        // hidden. A later frame, owner handoff or backward clock cannot replay it.
        consume(departureId);
        const fresh = before && before.kind === "arrival" && before.owner === frame?.ownerId && before.active
          && ["arriving", "deploying", "docked"].includes(before.phase) && before.id !== voyageId
          && now >= before.at && now - before.at <= TRADE_SHIP_DEPARTURE_AUDIO.transitionWindowMs
          && motion.elapsed >= 0 && motion.elapsed * 1000 <= TRADE_SHIP_DEPARTURE_AUDIO.transitionWindowMs;
        if (fresh && input.active && input.visible && soundEnabled && frame && frame.soundscape !== false)
          playHorn(input, TRADE_SHIP_DEPARTURE_AUDIO.cueId, departureId, now, TRADE_SHIP_DEPARTURE_AUDIO.maxAgeMs);
        return;
      }
      if (!arriving || !voyageId || !motion || consumed.has(voyageId)) return;
      const same = before?.id === voyageId && before.phase === "arriving";
      // Joining/reloading in the middle establishes a baseline. It is not a new horn.
      if (!same || motion.elapsed < before.elapsed) {
        if (motion.elapsed >= TRADE_SHIP_ARRIVAL_AUDIO.contactAt) { consume(voyageId); claim(input); }
        return;
      }
      if (before.elapsed >= TRADE_SHIP_ARRIVAL_AUDIO.contactAt || motion.elapsed < TRADE_SHIP_ARRIVAL_AUDIO.contactAt) return;
      consume(voyageId);
      // The intro checkpoint may still be just before this frame on reload.
      // Persist consumption even while muted/offscreen; it must never replay later.
      const newlyClaimed = claim(input);
      const delta = motion.elapsed - before.elapsed;
      if (!newlyClaimed || !input.active || !input.visible || !soundEnabled || !frame || frame.soundscape === false || delta <= 0 || delta > .25) return;
      playHorn(input, TRADE_SHIP_ARRIVAL_AUDIO.cueId, `${voyageId}:arrival-horn-v1`, now, TRADE_SHIP_ARRIVAL_AUDIO.maxAgeMs);
    },
    dispose() { if (disposed) return; disposed = true; stopPreparation(); previous = null; consumed.clear(); },
  };
}
