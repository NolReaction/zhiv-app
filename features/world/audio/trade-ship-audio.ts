import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";
import { distanceGain, stereoPan } from "@/features/audio/domain/spatial";
import type { TradeShipMotion } from "@/features/world/objects/trade-ship/trade-ship-motion";

// The opaque PNG has entered the real map by this point; the extended workshop sea is not a visibility signal.
export const TRADE_SHIP_ARRIVAL_AUDIO = { cueId: "ship.arrival", contactAt: 10.5, maxAgeMs: 350 } as const;
export type TradeShipAudioInput = {
  /** Stable per introduction; DEV replays use their own monotonically new ID. */
  voyageId: string | null;
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

/** Observe the one live arrival contact. Hidden/muted/stale contacts are consumed,
 * not queued for a later view or autoplay unlock. Rendering never invokes this. */
export function createTradeShipAudioController(runtime: Pick<AudioRuntime, "prepare" | "play" | "getSettings">) {
  let previous: { id: string; phase: TradeShipMotion["phase"]; elapsed: number } | null = null;
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
  return {
    update(input: TradeShipAudioInput) {
      if (disposed) return;
      const { voyageId, motion, frame } = input, before = previous;
      previous = voyageId && motion ? { id: voyageId, phase: motion.phase, elapsed: motion.elapsed } : null;
      const settings = runtime.getSettings();
      const soundEnabled = settings.enabled && settings.master > 0 && settings.buses.world > 0;
      const arriving = Boolean(voyageId && motion?.phase === "arriving");
      if (!arriving || !input.active || !soundEnabled || !frame || frame.soundscape === false) stopPreparation();
      else if (!preparation || preparation.id !== voyageId) {
        stopPreparation();
        const abort = new AbortController(); preparation = { id: voyageId!, abort };
        void runtime.prepare([TRADE_SHIP_ARRIVAL_AUDIO.cueId], { signal: abort.signal }).catch(() => {});
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
      const position = { x: motion.x + motion.width * .5, y: motion.y + motion.width * .35 };
      const listener = frame.listener;
      const gain = distanceGain(Math.hypot(position.x - listener.position.x, position.y - listener.position.y), 70, 480)
        * Math.max(0, Math.min(1, Number.isFinite(listener.detail) ? listener.detail : 0));
      if (gain <= .001) return;
      runtime.play({ id: `${voyageId}:arrival-horn-v1`, cueId: TRADE_SHIP_ARRIVAL_AUDIO.cueId, ownerId: frame.ownerId,
        occurredAt: Number.isFinite(input.now) ? input.now! : Date.now(), maxAgeMs: TRADE_SHIP_ARRIVAL_AUDIO.maxAgeMs,
        gain, pan: stereoPan(position, listener) * .65 });
    },
    dispose() { if (disposed) return; disposed = true; stopPreparation(); previous = null; consumed.clear(); },
  };
}
