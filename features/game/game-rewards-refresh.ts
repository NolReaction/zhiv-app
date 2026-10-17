import type { createGameRewardsSession } from "./game-rewards-session";

type RewardsSession = Pick<ReturnType<typeof createGameRewardsSession>, "activate" | "refresh" | "getSnapshot">;

/** All mounted controls for one account share a single reader and browser lifecycle. */
export function createGameRewardsRefresh(session: RewardsSession) {
  let consumers = 0, stop: (() => void) | undefined;
  return () => {
    if (consumers++ === 0) {
      const deactivate = session.activate();
      let scheduled: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        if (document.hidden || scheduled !== undefined) return;
        const version = session.getSnapshot().readVersion;
        scheduled = setTimeout(() => {
          scheduled = undefined;
          // A manual entry/claim may already have confirmed a fresher snapshot
          // while this browser event was queued.
          if (!document.hidden && session.getSnapshot().readVersion === version) void session.refresh();
        }, 0);
      };
      refresh();
      const poll = setInterval(refresh, 45_000);
      window.addEventListener("focus", refresh);
      window.addEventListener("online", refresh);
      document.addEventListener("visibilitychange", refresh);
      stop = () => {
        if (scheduled !== undefined) clearTimeout(scheduled);
        clearInterval(poll);
        window.removeEventListener("focus", refresh);
        window.removeEventListener("online", refresh);
        document.removeEventListener("visibilitychange", refresh);
        deactivate();
      };
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (--consumers === 0) { stop?.(); stop = undefined; }
    };
  };
}
