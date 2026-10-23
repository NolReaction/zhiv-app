import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { z } from "zod";
import { economyCommandSchema, economyViewSchema, recipeBuildingLevel, type EconomyCommand, type EconomyView } from "@/features/economy/domain/model";
import { productionSlotCount } from "@/features/economy/domain/production-slots";
import { fishClassForItem } from "@/features/economy/domain/fishing";
import { tradeRelationBonusBps, tradeWorkDuration } from "@/features/economy/domain/trade-relations";

export const PRODUCTION_JOURNAL_LIMIT = 12;
export type ProductionIntent = { requestId: string; targetId: string; command?: EconomyCommand };
export type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ProductionJournal = { version: 1; owner: string; snapshot: EconomyView; entries: ProductionIntent[] };
const intentSchema = z.object({ requestId: economyCommandSchema.shape.requestId, targetId: economyCommandSchema.shape.targetId,
  command: economyCommandSchema.optional() }).strict();
const journalSchema = z.object({ version: z.literal(1), owner: z.string(), snapshot: economyViewSchema,
  entries: z.array(intentSchema).max(PRODUCTION_JOURNAL_LIMIT) }).strict();
export const productionJournalKey = (owner: string) => gameplayStorageKey(`zhiv:economy:production:v1:${owner}`);

/** Cache data is an untrusted preview. Only a server receipt changes confirmed state. */
export function parseProductionJournal(raw: string | null, owner: string): ProductionJournal | null {
  if (!raw || raw.length > 2_000_000) return null;
  try {
    const parsed = journalSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.owner !== owner || parsed.data.snapshot.ownerPublicId !== owner) return null;
    const entries = parsed.data.entries;
    if (new Set(entries.map(entry => entry.requestId)).size !== entries.length || entries.some((entry, index) => entry.command
      && (index !== 0 || entry.command.ownerPublicId !== owner || entry.command.requestId !== entry.requestId
        || entry.command.targetId !== entry.targetId || entry.command.action !== "start_production" || entry.command.quantity !== 1
        || entry.command.totalPrice !== 0 || entry.command.fishSelection != null))) return null;
    if (entries.some(entry => !safeProductionRecipe(parsed.data.snapshot, entry.targetId))) return null;
    return parsed.data;
  } catch { return null; }
}

export function safeProductionRecipe(state: EconomyView, targetId: string) {
  const recipe = state.catalog.recipes.find(entry => entry.id === targetId);
  if (!recipe || recipe.buildingId === "quarry" || recipe.fishInput || targetId.includes("@")
    || Object.keys(recipe.cost.items).some(itemId => itemId === "fish" || itemId.startsWith("fish_")
      || state.catalog.fishing && fishClassForItem(itemId, state.catalog.fishing))) return null;
  return recipe;
}

/** Reserves existing ingredients and occupied slots, never credits a result or progress. */
export function reserveProduction(state: EconomyView, entry: ProductionIntent): EconomyView | null {
  const recipe = safeProductionRecipe(state, entry.targetId);
  if (!recipe || state.jobs.length >= 18 || (state.buildings.home ?? 1) < recipe.requiredHomeLevel
    || (state.buildings[recipe.buildingId] ?? 0) < recipeBuildingLevel(recipe)
    || Object.entries(recipe.requiredBuildings).some(([id, level]) => (state.buildings[id] ?? 0) < level)
    || Object.entries(recipe.requiredRecipes).some(([id, count]) => (state.progression.recipes[id] ?? 0) < count)
    || state.jobs.some(job => job.targetId === recipe.buildingId && job.kind === "construction")
    || state.jobs.filter(job => job.targetId === recipe.buildingId && job.kind === "production").length >= productionSlotCount(state, recipe.buildingId)
    || Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0) > state.storage.capacity
    || state.wallet.coins < recipe.cost.coins
    || Object.entries(recipe.cost.items).some(([id, count]) => (state.inventory[id] ?? 0) < count)) return null;
  const tradeSpeedBps = recipe.buildingId === "woodlot" ? tradeRelationBonusBps(state, "lopukh", state.catalog) : 0;
  const seconds = recipe.buildingId === "woodlot" ? tradeWorkDuration(state, recipe.seconds, "lopukh", 0, state.catalog) : recipe.seconds;
  const finishTime = Date.parse(state.serverTime) + seconds * 1000;
  if (!Number.isFinite(finishTime) || Math.abs(finishTime) > 8_640_000_000_000_000) return null;
  const inventory = { ...state.inventory };
  for (const [id, count] of Object.entries(recipe.cost.items)) {
    inventory[id] -= count;
    if (!inventory[id]) delete inventory[id];
  }
  const used = Object.values(inventory).reduce((sum, count) => sum + count, 0);
  return { ...state, wallet: { ...state.wallet, coins: state.wallet.coins - recipe.cost.coins }, inventory,
    storage: { ...state.storage, used, available: Math.max(0, state.storage.capacity - used - state.storage.reserved),
      overflow: Math.max(0, used + state.storage.reserved - state.storage.capacity) },
    jobs: [...state.jobs, { id: entry.requestId, kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
      startedAt: state.serverTime, finishesAt: new Date(finishTime).toISOString(), tradeSpeedBps,
      rewards: { ...recipe.rewards }, cost: { coins: recipe.cost.coins, items: { ...recipe.cost.items } }, catalogVersion: state.catalog.version,
      ...(recipe.collection ? { collection: { ...recipe.collection, startedAt: null, finishesAt: null } } : {}) }] };
}

export function productionProjection(snapshot: EconomyView | null, entries: readonly ProductionIntent[]): EconomyView | null {
  if (!snapshot) return null;
  return entries.reduce((state, entry) => reserveProduction(state, entry) ?? state, snapshot);
}

export type JournalCoordinator = (owner: string, signal: AbortSignal) => Promise<(() => void) | null>;
/** The lock is held for the session lifetime; storage events alone are not a mutex. */
export const browserJournalCoordinator: JournalCoordinator = (owner, signal) => {
  if (signal.aborted || typeof navigator === "undefined" || !navigator.locks) return Promise.resolve(null);
  return new Promise(resolve => {
    let answered = false;
    const answer = (value: (() => void) | null) => { if (!answered) { answered = true; resolve(value); } };
    void navigator.locks.request(gameplayStorageKey(`zhiv:economy:production:${owner}`), { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock || signal.aborted) { answer(null); return; }
      await new Promise<void>(release => { answer(release); signal.addEventListener("abort", () => release(), { once: true }); });
    }).catch(() => answer(null));
  });
};
