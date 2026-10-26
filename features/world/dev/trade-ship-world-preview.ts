import { advanceTradeShipMotion, createTradeShipMotion, departTradeShip } from "@/features/world/objects/trade-ship/trade-ship-motion";

export type WorldTradeShipCommand = "arrive" | "depart" | "dock";

/** Shared only by DEV scene mounts. Nothing enters the saved forest session. */
export function createTradeShipWorldPreview() {
  let shown = false, motion = createTradeShipMotion(), previousFrame: number | null = null;
  const listeners = new Set<() => void>();
  function replace(next: typeof motion) {
    const phaseChanged = next.phase !== motion.phase;
    motion = next;
    // Phase feedback must not reconfigure the world's running frame loop.
    if (phaseChanged) for (const listener of [...listeners]) listener();
  }
  return {
    getMotion: () => motion,
    getPhase: () => motion.phase,
    getServerPhase: () => "docked" as const,
    subscribePhase(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setEnabled(next: boolean) {
      if (shown === next) return;
      shown = next; previousFrame = null; replace(createTradeShipMotion());
    },
    command(command: WorldTradeShipCommand) {
      if (!shown) return;
      if (command === "dock") replace(createTradeShipMotion());
      else if (command === "depart") replace(departTradeShip(motion));
      else if (command === "arrive" && (motion.phase === "docked" || motion.phase === "departed")) replace(createTradeShipMotion("arriving"));
    },
    /** Only the active owning scene calls this, after its image has loaded. */
    advance(seconds: number, frame: number, imageReady: boolean) {
      if (!shown || !imageReady || !Number.isFinite(frame) || frame === previousFrame
        || !Number.isFinite(seconds) || seconds <= 0) return;
      previousFrame = frame;
      replace(advanceTradeShipMotion(motion, seconds));
    },
  };
}
