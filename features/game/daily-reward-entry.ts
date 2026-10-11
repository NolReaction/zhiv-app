import type { GameRewardsController } from "./use-game-rewards";

type EntryRewardState = Pick<GameRewardsController, "data" | "readVersion" | "loading" | "busy" | "pending" | "uncertain">;

/** One prompt per world visit, after a fresh owner-confirmed read. Closing it never spends a gift. */
export function createDailyRewardEntryPrompt(ownerPublicId: string, initialReadVersion: number) {
  let dismissed = false;
  return {
    dismiss() { dismissed = true; },
    shouldOpen(state: EntryRewardState, isOnline: boolean, autoPromptAllowed = true) {
      // Waiting for a tutorial/quiet moment must not consume this visit's prompt.
      if (!autoPromptAllowed || dismissed || !isOnline || state.loading || state.busy || state.readVersion <= initialReadVersion
        || state.data?.ownerPublicId !== ownerPublicId) return false;
      const pendingDaily = state.uncertain && state.pending?.kind === "daily";
      if (!pendingDaily && (!state.data.daily.claimable || state.pending !== null)) return false;
      dismissed = true;
      return true;
    },
  };
}
