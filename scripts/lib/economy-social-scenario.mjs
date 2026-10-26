import assert from "node:assert/strict";

const dayMs = 86_400_000;

/** A funded player policy, not a reputation fixture. The only way this helper
 * changes the world is through the caller's real command/bundle callbacks.
 * It never supplies money, ingredients, unlocked technology or experience. */
export function createSocialPolicy({ catalog, relations, food, state, mode = "balanced", continueWeekly = () => false }) {
  assert(["income", "balanced", "reputation"].includes(mode));
  const residentIds = relations.TRADE_RESIDENT_IDS;
  const maximumXp = catalog.tradeRelations?.ranks.at(-1).requiredXp ?? 0;
  const deliveries = [], acceptedWeeklies = [], expiredWeeklies = [];
  const expiredIds = new Set(), ordinaryByDay = new Map();
  let selectedOrdinaryId = null;
  const xp = id => state.tradeRelations?.reputation[id] ?? 0;
  const countToday = (id, now) => ordinaryByDay.get(`${Math.floor(now / dayMs)}:${id}`) ?? 0;
  function availableOrdinary(now) {
    return food.residentOrderBoard(state, now).offers.filter(offer => {
      const progress = relations.tradeRelationProgress(state, offer.residentId, catalog, now);
      const progressNeeded = xp(offer.residentId) < maximumXp && progress.dailyOrderXpRemaining > 0;
      const activityNeeded = (progress.activityBps ?? 10000) < 10000;
      return Date.parse(offer.availableAt) <= now && (progressNeeded || activityNeeded)
        && (mode === "reputation" || countToday(offer.residentId, now) < 1);
    });
  }
  function observeExpiry(now) {
    const saved = state.tradeRelations?.weekly;
    if (saved && Date.parse(saved.expiresAt) <= now && !expiredIds.has(saved.id)) {
      expiredIds.add(saved.id);
      expiredWeeklies.push({ id: saved.id, residentId: saved.residentId, completedStages: saved.stage,
        acceptedAt: saved.acceptedAt, expiresAt: saved.expiresAt });
    }
  }
  function effort(items, estimate) {
    return Object.entries(items).reduce((sum, [id, count]) => sum + count * estimate(id), 0);
  }
  function recordDelivery(offer, now, apply) {
    const before = { coins: state.wallet.coins, pearls: state.wallet.pearls, xp: xp(offer.residentId),
      items: Object.fromEntries(Object.keys(offer.items).map(id => [id, state.inventory[id] ?? 0])) };
    apply("complete_resident_order", offer.id);
    for (const [id, quantity] of Object.entries(offer.items))
      assert.equal(before.items[id] - (state.inventory[id] ?? 0), quantity, `${offer.id}: every delivered item was owned and spent`);
    deliveries.push({ id: offer.id, templateId: offer.templateId, residentId: offer.residentId,
      at: new Date(now).toISOString(), weekly: Boolean(offer.weekly), stage: offer.stage ?? null,
      items: { ...offer.items }, coins: state.wallet.coins - before.coins, pearls: state.wallet.pearls - before.pearls,
      xp: xp(offer.residentId) - before.xp, reputation: xp(offer.residentId) });
    if (!offer.weekly) {
      const key = `${Math.floor(now / dayMs)}:${offer.residentId}`;
      ordinaryByDay.set(key, (ordinaryByDay.get(key) ?? 0) + 1);
      selectedOrdinaryId = null;
    }
    return true;
  }
  function act({ now, held, bundle, estimatedEffort, apply, dailyActiveSeconds = Infinity }) {
    if (mode === "income" || !catalog.tradeRelations) return false;
    observeExpiry(now);
    let board = relations.weeklyOrderBoard(state, now);
    if (board.active && held(board.active.items)) return recordDelivery(board.active, now, apply);
    const ordinary = availableOrdinary(now);
    const ready = ordinary.filter(offer => held(offer.items)).sort((a, b) => xp(a.residentId) - xp(b.residentId) || a.id.localeCompare(b.id))[0];
    if (ready) return recordDelivery(ready, now, apply);
    if (board.canChoose) {
      // Public contract stages are visible before acceptance. Never inspect
      // unrevealed future ordinary orders or the random contents of a trip.
      const choices = board.offers.filter(offer => xp(offer.residentId) < maximumXp || continueWeekly())
        .map(offer => ({ offer, seconds: offer.stages.reduce((sum, stage) => sum + effort(stage.items, estimatedEffort), 0) }))
        .filter(entry => Number.isFinite(entry.seconds) && entry.seconds <= dailyActiveSeconds * 7)
        .sort((a, b) => {
          // After permanent ranks are complete, a capacity-focused player still
          // has a real reason to accept contracts: renewable pearl income.
          if (residentIds.every(id => xp(id) >= maximumXp) && continueWeekly())
            return b.offer.pearls - a.offer.pearls || a.seconds - b.seconds || a.offer.id.localeCompare(b.offer.id);
          return (mode === "reputation" ? xp(a.offer.residentId) - xp(b.offer.residentId) : 0)
            || a.seconds / Math.max(1, a.offer.reputationXp) - b.seconds / Math.max(1, b.offer.reputationXp)
            || a.offer.id.localeCompare(b.offer.id);
        });
      if (choices.length) {
        const choice = choices[0];
        apply("accept_weekly_order", choice.offer.id);
        board = relations.weeklyOrderBoard(state, now);
        assert(board.progress && board.active, "acceptance must create the real dated contract");
        acceptedWeeklies.push({ id: board.progress.id, templateId: choice.offer.templateId, residentId: choice.offer.residentId,
          acceptedAt: board.progress.acceptedAt, expiresAt: board.progress.expiresAt, estimatedWorkSeconds: choice.seconds });
        return true;
      }
    }
    if (board.active && bundle(board.active.items)) return true;
    let selected = ordinary.find(offer => offer.id === selectedOrdinaryId);
    if (!selected) {
      selected = ordinary.map(offer => ({ offer, seconds: effort(offer.items, estimatedEffort) }))
        .filter(entry => Number.isFinite(entry.seconds))
        .sort((a, b) => (mode === "reputation" ? xp(a.offer.residentId) - xp(b.offer.residentId) : 0)
          || a.seconds / Math.max(1, a.offer.reputationXp ?? 0) - b.seconds / Math.max(1, b.offer.reputationXp ?? 0)
          || a.offer.id.localeCompare(b.offer.id))[0]?.offer;
      selectedOrdinaryId = selected?.id ?? null;
    }
    return selected ? bundle(selected.items) : false;
  }
  function demand(now) {
    if (mode === "income") return {};
    const active = relations.weeklyOrderBoard(state, now).active;
    const ordinary = availableOrdinary(now).find(offer => offer.id === selectedOrdinaryId);
    const reserve = {};
    for (const items of [active?.items, ordinary?.items]) for (const [id, count] of Object.entries(items ?? {}))
      reserve[id] = Math.max(reserve[id] ?? 0, count);
    return reserve;
  }
  return { act, demand,
    complete: () => residentIds.every(id => xp(id) >= maximumXp),
    snapshot(now) {
      observeExpiry(now);
      return { mode, funded: true, ordinaryGoalPerResidentPerDay: mode === "balanced" ? 1 : null,
        maximumXp, reputation: Object.fromEntries(residentIds.map(id => [id, xp(id)])),
        bonusPercent: Object.fromEntries(residentIds.map(id => [id, relations.tradeRelationProgress(state, id, catalog, now).bonusBps / 100])),
        activityPercent: Object.fromEntries(residentIds.map(id => [id, (relations.tradeRelationProgress(state, id, catalog, now).activityBps ?? 10000) / 100])),
        rankBonusPercent: Object.fromEntries(residentIds.map(id => { const progress = relations.tradeRelationProgress(state, id, catalog, now); return [id, (progress.rankBonusBps ?? progress.bonusBps) / 100]; })),
        allMaximum: residentIds.every(id => xp(id) >= maximumXp),
        ordinaryOrdersCompleted: state.residentOrders?.completed ?? 0,
        completedWeekly: state.tradeRelations?.completedWeekly ?? 0,
        deliveryLedgerScope: "social-policy-only; total ordinary count and reputation include income orders",
        deliveries, acceptedWeeklies, expiredWeeklies };
    } };
}
