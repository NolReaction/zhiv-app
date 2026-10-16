import type { ConstructionCompletion } from "@/features/economy/domain/construction-completion";
import type { InventoryGain } from "@/features/economy/domain/inventory-gain";
import type { ProductionStart } from "@/features/economy/domain/production-start";

/** Only accepted local receipts are rewards. Polling inventory or reading a notice
 * cannot establish that the player just performed an action. */
export type EconomyAudioFeedbackView = {
  snapshot: { ownerPublicId: string; revision: number } | null;
  busy: boolean;
  uncertain: boolean;
  notice: string;
  error: string | null;
  inventoryGains?: readonly InventoryGain[];
  productionStarts?: readonly ProductionStart[];
  completedConstructions: readonly ConstructionCompletion[];
};

export type EconomyAudioFeedbackEvent = {
  id: string;
  cueId: "ui.reward" | "ui.construction-complete" | "ui.confirm" | "ui.error" | "ui.click";
  occurredAt: number;
  maxAgeMs?: number;
};

type RewardFeedback = Pick<EconomyAudioFeedbackEvent, "id"> & { cueId: "ui.reward" | "ui.construction-complete" };
type PendingFeedback = { startRevision: number; id: string; suppressed: boolean; reward: RewardFeedback | null; productionStart: boolean };
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
    for (const receipt of view.productionStarts ?? []) remember(`production-start:${receipt.id}`);
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
          reward: null,
          productionStart: false,
        };
      }
      if (view.uncertain) {
        suppressUntilIdle = true;
        if (pending) pending.suppressed = true;
      }

      const events: EconomyAudioFeedbackEvent[] = [];
      // This quiet input cue confirms only that a new intent was accepted on
      // this device. The queue has no busy edge, and an ACK is not a new click.
      for (const receipt of view.productionStarts ?? []) {
        const key = `production-start:${receipt.id}`;
        if (!seen.has(key) && receipt.ownerPublicId === owner) {
          if (pending) pending.productionStart = true;
          if (!view.uncertain && !suppressUntilIdle && !pending?.suppressed) events.push({
            id: `economy:${owner}:${key}`, cueId: "ui.click", occurredAt: receipt.occurredAt, maxAgeMs: 180,
          });
        }
        remember(key);
      }
      const revisionFloor = pending?.startRevision ?? highestRevision;
      const allowReward = !view.uncertain && !suppressUntilIdle && !pending?.suppressed;
      const rewards: RewardFeedback[] = [];
      for (const receipt of view.inventoryGains ?? []) {
        const key = `gain:${receipt.id}`;
        if (!seen.has(key) && receipt.ownerPublicId === owner && Number.isSafeInteger(receipt.revision)
          && receipt.revision > revisionFloor && receipt.revision <= snapshot.revision && allowReward) rewards.push({ id: key, cueId: "ui.reward" });
        remember(key);
      }
      for (const receipt of view.completedConstructions) {
        const key = `construction:${receipt.id}`;
        if (!seen.has(key) && snapshot.revision > revisionFloor && allowReward) rewards.push({ id: key, cueId: "ui.construction-complete" });
        remember(key);
      }

      if (pending) {
        // One command can carry several changed objects; it earns one sound.
        // Completing a building has its own signature, even if the same result
        // also carries resources. Do not replace it with a generic reward.
        pending.reward = rewards.find(reward => reward.cueId === "ui.construction-complete") ?? pending.reward ?? rewards[0] ?? null;
        if (!view.busy) {
          if (!pending.suppressed && !view.uncertain && !suppressUntilIdle) {
            const cueId = view.error ? "ui.error" : pending.reward ? pending.reward.cueId
              : !pending.productionStart && view.notice && snapshot.revision > pending.startRevision ? "ui.confirm" : null;
            if (cueId) events.push({ id: pending.reward && cueId !== "ui.error"
              ? `economy:${owner}:${pending.reward.id}` : pending.id, cueId, occurredAt });
          }
          pending = null;
        }
      } else if (!view.busy) {
        // React may coalesce a fast request's busy edge. The session's explicit
        // receipt still proves acceptance; a revision/notice alone does not.
        const construction = rewards.find(reward => reward.cueId === "ui.construction-complete");
        for (const reward of construction ? [construction] : rewards) {
          events.push({ id: `economy:${owner}:${reward.id}`, cueId: reward.cueId, occurredAt });
        }
      }

      highestRevision = Math.max(highestRevision, snapshot.revision);
      previousBusy = view.busy;
      if (!view.busy && !view.uncertain) suppressUntilIdle = false;
      return events;
    },
  };
}
