import type { ConstructionCompletion } from "@/features/economy/domain/construction-completion";
import type { InventoryGain } from "@/features/economy/domain/inventory-gain";

/** Only accepted local receipts are rewards. Polling inventory or reading a notice
 * cannot establish that the player just performed an action. */
export type EconomyAudioFeedbackView = {
  snapshot: { ownerPublicId: string; revision: number } | null;
  busy: boolean;
  uncertain: boolean;
  notice: string;
  error: string | null;
  inventoryGains?: readonly InventoryGain[];
  completedConstructions: readonly ConstructionCompletion[];
};

export type EconomyAudioFeedbackEvent = {
  id: string;
  cueId: "ui.reward" | "ui.confirm" | "ui.error";
  occurredAt: number;
};

type PendingFeedback = { startRevision: number; id: string; suppressed: boolean; rewardId: string | null };
export const ECONOMY_AUDIO_RECEIPT_LIMIT = 128;
let trackerSequence = 0;

/** Lives once beside the app economy controller, independent of panels and map.
 * A command publishes its new snapshot, receipt, and busy=false separately. Keep
 * the command's starting revision until the last publish so one reward cannot
 * become both a confirmation and a reward. Unobserved busy transitions may still
 * use an explicit fresh receipt, but never infer success from a stale notice. */
export function createEconomyAudioFeedbackTracker() {
  const trackerId = ++trackerSequence;
  const seen = new Set<string>();
  let owner: string | null = null;
  let highestRevision = -1;
  let previousBusy = false;
  let suppressUntilIdle = false;
  let pending: PendingFeedback | null = null;
  let commandSequence = 0;

  function remember(id: string) {
    seen.add(id);
    if (seen.size > ECONOMY_AUDIO_RECEIPT_LIMIT) seen.delete(seen.values().next().value!);
  }

  function seed(view: EconomyAudioFeedbackView) {
    for (const receipt of view.inventoryGains ?? []) remember(`gain:${receipt.id}`);
    for (const receipt of view.completedConstructions) remember(`construction:${receipt.id}`);
  }

  function reset() {
    owner = null; highestRevision = -1; previousBusy = false;
    suppressUntilIdle = false; pending = null; seen.clear();
  }

  return {
    reset,
    update(view: EconomyAudioFeedbackView, enabled = true, occurredAt = Date.now()): EconomyAudioFeedbackEvent[] {
      const snapshot = view.snapshot;
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) { reset(); return []; }
      // Mounting, hydration and changing accounts establish a silent baseline.
      if (snapshot.ownerPublicId !== owner) {
        reset(); owner = snapshot.ownerPublicId; highestRevision = snapshot.revision;
        previousBusy = view.busy; suppressUntilIdle = view.uncertain || view.busy;
        seed(view); return [];
      }
      if (!enabled) {
        highestRevision = Math.max(highestRevision, snapshot.revision);
        previousBusy = view.busy; suppressUntilIdle = view.uncertain || view.busy;
        pending = null; seed(view); return [];
      }

      if (view.busy && !previousBusy) {
        pending = {
          startRevision: highestRevision,
          id: `economy:${owner}:${trackerId}:command:${++commandSequence}`,
          suppressed: suppressUntilIdle || view.uncertain,
          rewardId: null,
        };
      }
      if (view.uncertain) {
        suppressUntilIdle = true;
        if (pending) pending.suppressed = true;
      }

      const events: EconomyAudioFeedbackEvent[] = [];
      const revisionFloor = pending?.startRevision ?? highestRevision;
      const allowReward = !view.uncertain && !suppressUntilIdle && !pending?.suppressed;
      const rewards: string[] = [];
      for (const receipt of view.inventoryGains ?? []) {
        const key = `gain:${receipt.id}`;
        if (!seen.has(key) && receipt.ownerPublicId === owner && Number.isSafeInteger(receipt.revision)
          && receipt.revision > revisionFloor && receipt.revision <= snapshot.revision && allowReward) rewards.push(key);
        remember(key);
      }
      for (const receipt of view.completedConstructions) {
        const key = `construction:${receipt.id}`;
        if (!seen.has(key) && snapshot.revision > revisionFloor && allowReward) rewards.push(key);
        remember(key);
      }

      if (pending) {
        // One command can carry several changed objects; it earns one sound.
        pending.rewardId ??= rewards[0] ?? null;
        if (!view.busy) {
          if (!pending.suppressed && !view.uncertain && !suppressUntilIdle) {
            const cueId = view.error ? "ui.error" : pending.rewardId ? "ui.reward"
              : view.notice && snapshot.revision > pending.startRevision ? "ui.confirm" : null;
            if (cueId) events.push({ id: pending.rewardId && cueId === "ui.reward"
              ? `economy:${owner}:${pending.rewardId}` : pending.id, cueId, occurredAt });
          }
          pending = null;
        }
      } else if (!view.busy) {
        // React may coalesce a fast request's busy edge. The session's explicit
        // receipt still proves acceptance; a revision/notice alone does not.
        for (const key of rewards) events.push({ id: `economy:${owner}:${key}`, cueId: "ui.reward", occurredAt });
      }

      highestRevision = Math.max(highestRevision, snapshot.revision);
      previousBusy = view.busy;
      if (!view.busy && !view.uncertain) suppressUntilIdle = false;
      return events;
    },
  };
}
