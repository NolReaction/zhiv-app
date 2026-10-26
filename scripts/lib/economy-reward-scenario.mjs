/** Reward receipts for command-driven simulations. Modules are injected so the
 * same scenario can compare frozen catalog versions without inventing grants.
 * The credit callback must perform the runtime wallet/storage checks atomically.
 * Social and player-market achievements require external player evidence and are omitted. A world-character purchase is not a player-market sale.
 */
export function createRewardScenario({ rewards, achievementProgress, welcome, pearlDisplayDivisor = 2 }) {
  let daily = rewards.initialDailyRewardState();
  const received = new Set(), offered = new Map();
  const catalog = rewards.progressionRewardsCatalog;
  function claims(state, now) {
    const result = [];
    const offer = (id, kind, reward, extra = {}) => {
      if (received.has(id)) return;
      const claim = { id, kind, reward: structuredClone(reward), ...extra };
      offered.set(id, claim);
      result.push(structuredClone(claim));
    };
    if (rewards.onboardingRewardEligible(state)) offer("onboarding", "onboarding", rewards.onboardingRewardForState?.(state) ?? catalog.onboarding);
    offer("welcome", "welcome", { coins: 0, pearls: welcome.WELCOME_MAIL_PEARLS * pearlDisplayDivisor, items: {} });
    const day = rewards.dailyRewardView(daily, now, state.buildings.home ?? 1);
    if (day.claimable) offer(`daily:${day.step}`, "daily", day.reward, { step: day.step });
    const progress = achievementProgress.economyAchievementProgress(state, 0);
    for (const [id, targets] of Object.entries(achievementProgress.GAME_ACHIEVEMENT_TARGETS)) {
      if (!(id in progress)) continue;
      for (const [index, target] of targets.entries()) {
        const pearls = catalog.achievementPearls[id]?.[index] ?? 0;
        if (progress[id] >= target && pearls > 0)
          offer(`achievement:${id}:${index + 1}`, "achievement", { coins: 0, pearls, items: {} }, { achievementId: id, level: index + 1 });
      }
    }
    return result;
  }
  function commitClaim(id, now) {
    const claim = offered.get(id);
    if (!claim || received.has(id)) return false;
    if (claim.kind === "daily") daily = rewards.afterDailyClaim(daily, now);
    received.add(id);
    offered.delete(id);
    return true;
  }
  return { claims, commitClaim,
    claimEligible(state, now, credit) {
      const paid = [];
      for (const claim of claims(state, now)) if (credit(claim.reward, claim) !== false) {
        commitClaim(claim.id, now);
        paid.push(claim);
      }
      return paid;
    },
    snapshot: () => ({ daily: structuredClone(daily), received: [...received] }),
  };
}
