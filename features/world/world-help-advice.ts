import { economyActorConflict } from "@/features/economy/actor-availability";
import { fishingState, fishingTripCost } from "@/features/economy/fishing";
import { recipeWithFish } from "@/features/economy/food";
import type { EconomyCost, EconomyJob, EconomyView } from "@/features/economy/model";
import { productionSlotCount } from "@/features/economy/production-slots";
import type { EconomyController } from "@/features/economy/use-economy";
import { worldBatchLimit, worldConstructionReason, worldCostShortfalls, worldDuration, worldMaterialSource, worldMissingRequirements, worldProductionReason, worldRequirements } from "@/features/economy/world-stations";
import type { ForestObservation } from "./forest-observer";
import type { WorldController } from "./use-world";
import type { WorldHelpContext, WorldHelpSuggestion, WorldHelpTarget } from "./world-help-types";

type AdviceInput = {
  economy?: EconomyController;
  world?: WorldController;
  observation?: ForestObservation | null;
  context?: WorldHelpContext;
  isOnline?: boolean;
};
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? "Материал";
const stationName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? "Постройка";
const itemCount = (items: Record<string, number>) => Object.values(items).reduce((sum, count) => sum + count, 0);
const freeCost = (cost: EconomyCost) => cost.coins === 0 && itemCount(cost.items) === 0;
const sector = (routeId: string): "forest" | "coast" | "caves" => routeId.includes("shore") || routeId.includes("coastal") ? "coast"
  : routeId.includes("cave") || routeId.includes("quarry") ? "caves" : "forest";
const jobTarget = (job: EconomyJob): WorldHelpTarget => job.kind === "construction" ? { kind: "upgrade", stationId: job.targetId }
  : job.kind === "exploration" || job.targetId === "quarry" ? { kind: "expeditions", sector: sector(job.targetId) }
    : { kind: "station", stationId: job.targetId };
const ready = (job: EconomyJob, now: number) => now >= Date.parse(job.finishesAt)
  && (!job.collection?.startedAt || Boolean(job.collection.finishesAt && now >= Date.parse(job.collection.finishesAt)));

function jobAdvice(state: EconomyView, job: EconomyJob, now: number): WorldHelpSuggestion {
  const finished = ready(job, now), target = jobTarget(job);
  if (finished && job.kind !== "construction" && itemCount(job.rewards) > state.storage.available) return {
    id: "storage:space", title: "Нужно место в кладовой", topicId: "storage", severity: "problem",
    message: `Для готового результата нужно освободить ещё ${itemCount(job.rewards) - state.storage.available} мест. Он дождётся получения.`,
    action: { label: "Открыть кладовую", target: { kind: "pantry" } },
  };
  const action = { label: job.kind === "exploration" || job.targetId === "quarry" ? "Открыть вылазку" : job.kind === "construction" ? "Открыть стройку" : "Открыть производство", target };
  if (job.kind === "construction") return {
    id: `job:${job.id}`, title: finished ? "Стройка готова" : "Строитель занят", topicId: "construction", severity: finished ? "next" : "problem", action,
    message: finished ? `${stationName(state, job.targetId)}: нажмите «Завершить», чтобы получить улучшение и освободить строителя.`
      : `${stationName(state, job.targetId)}: осталось ${worldDuration(Math.ceil((Date.parse(job.finishesAt) - now) / 1000))}. Новую стройку можно начать после завершения этой.`,
  };
  if (job.collection?.startedAt && !finished) return {
    id: `job:${job.id}`, title: "Мохлик собирает урожай", topicId: "production", severity: "problem", action,
    message: "Дождитесь окончания сбора и заберите ягоды. После этого Мохлик сможет отправиться в путь.",
  };
  if (job.collection && !job.collection.startedAt && finished) {
    const conflict = economyActorConflict(state.jobs, "collection", now);
    if (conflict && conflict.job.id !== job.id) return jobAdvice(state, conflict.job, now);
    return { id: `job:${job.id}`, title: "Ягоды созрели", topicId: "production", severity: "next", action,
      message: "Откройте ягодный куст и отправьте Мохлика собрать урожай. Ягоды попадут в кладовую после сбора." };
  }
  if (job.kind === "exploration" || job.targetId === "quarry") return {
    id: `job:${job.id}`, title: finished ? "Находки ждут получения" : "Мохлик ещё в пути", topicId: "journeys", severity: finished ? "next" : "problem", action,
    message: finished ? "Заберите результат во «В путь». Пока находки не получены, следующую вылазку начать нельзя."
      : `До возвращения ${worldDuration(Math.ceil((Date.parse(job.finishesAt) - now) / 1000))}. Отменяйте вылазку только если готовы потерять её награды и потраченные припасы.`,
  };
  return { id: `job:${job.id}`, title: finished ? "Производство готово" : "Место производства занято", topicId: "production", severity: finished ? "next" : "problem", action,
    message: finished ? `${stationName(state, job.targetId)}: заберите результат, чтобы освободить место для следующей партии.`
      : `${stationName(state, job.targetId)}: дождитесь результата и заберите его. Готовая работа продолжает занимать место.` };
}

function requirementAdvice(state: EconomyView, required: Record<string, number>, now: number): WorldHelpSuggestion | null {
  const missing = worldMissingRequirements(state, required)[0];
  if (!missing) return null;
  const work = state.jobs.find(job => job.kind === "construction" && job.targetId === missing.id);
  if (work) return jobAdvice(state, work, now);
  return { id: `requirement:${missing.id}:${missing.level}`, title: `${stationName(state, missing.id)}: нужен уровень ${missing.level}`,
    message: `Сейчас уровень ${missing.current}. Откройте улучшение: там указаны материалы и предыдущие условия.`, topicId: "construction", severity: "problem",
    action: { label: "Посмотреть улучшение", target: { kind: "upgrade", stationId: missing.id } } };
}

function costAdvice(state: EconomyView, cost: EconomyCost, now: number, quantity = 1): WorldHelpSuggestion | null {
  const missing = worldCostShortfalls(state, cost, quantity)[0];
  if (!missing) return null;
  if (missing.id === "coins") return {
    id: "missing:coins", title: "Не хватает монет", topicId: "resident-orders", severity: "problem",
    message: `Нужно ещё ${(missing.required - missing.available).toLocaleString("ru-RU")}. Монеты можно получить за заказы жителей; состав и награда видны до сдачи.`,
    action: { label: "Посмотреть заказы", target: { kind: "food", tab: "orders" } },
  };
  const incoming = state.jobs.find(job => (job.rewards[missing.id] ?? 0) > 0 && ready(job, now));
  if (incoming) return jobAdvice(state, incoming, now);
  const source = worldMaterialSource(state, missing.id);
  let target: WorldHelpTarget | undefined;
  let instruction = "Проверьте состав рецепта и доступные материалы.";
  if (source?.kind === "production") {
    target = { kind: "station", stationId: source.stationId, recipeId: source.targetId };
    instruction = `Источник: ${stationName(state, source.stationId)}. Откройте рецепт, чтобы проверить его стоимость.`;
  } else if (source?.kind === "exploration") {
    const conflict = economyActorConflict(state.jobs, "departure", now);
    if (conflict) return jobAdvice(state, conflict.job, now);
    target = { kind: "expeditions", sector: sector(source.targetId) };
    instruction = "Этот материал есть в наградах доступной вылазки. Откройте маршрут и проверьте припасы.";
  } else if (state.catalog.fishing?.fish.some(fish => fish.itemId === missing.id)) {
    const conflict = economyActorConflict(state.jobs, "departure", now);
    if (conflict) return jobAdvice(state, conflict.job, now);
    target = { kind: "expeditions", sector: "coast" };
    instruction = "Рыбу можно поймать на побережье. Особый вид выпадает с шансом: проверьте снасти перед отправлением.";
  }
  return { id: `missing:${missing.id}`, title: `Не хватает: ${itemName(state, missing.id)}`, topicId: "production", severity: "problem",
    message: `Есть ${missing.available}, нужно ${missing.required}. ${instruction}`,
    ...(target ? { action: { label: source?.kind === "production" ? "Открыть рецепт" : "Выбрать вылазку", target } } : {}),
  };
}

function contextAdvice(state: EconomyView, context: WorldHelpContext | undefined, now: number): WorldHelpSuggestion | null {
  if (!context) return null;
  if (context.intent === "expedition") {
    const conflict = economyActorConflict(state.jobs, "departure", now);
    if (conflict) return jobAdvice(state, conflict.job, now);
    const route = state.catalog.explorations.find(route => route.id === context.routeId);
    if (!route) return null;
    const requirement = requirementAdvice(state, worldRequirements(route), now);
    if (requirement) return requirement;
    const mineWork = route.requiredBuildings.quarry && state.jobs.find(job => job.kind === "construction" && job.targetId === "quarry");
    if (mineWork) return jobAdvice(state, mineWork, now);
    if (itemCount(route.rewards) > state.storage.capacity) return {
      id: "route:storage-capacity", title: "Награды больше кладовой", topicId: "storage", severity: "problem",
      message: "Для этого маршрута нужна более вместительная кладовая. Можно выбрать короткую вылазку или улучшить кладовую.",
      action: { label: "Улучшение кладовой", target: { kind: "upgrade", stationId: "warehouse" } },
    };
    const fishing = state.catalog.fishing, gear = fishingState(state);
    if (fishing?.routeIds.includes(route.id)) {
      if (!gear.ownedRods.includes(gear.equippedRodId) || !fishing.rods.some(rod => rod.id === gear.equippedRodId)
        || !gear.ownedHooks.includes(gear.equippedHookId) || !fishing.hooks.some(hook => hook.id === gear.equippedHookId)
        || gear.equippedBaitId && !fishing.baits.some(bait => bait.itemId === gear.equippedBaitId)) return {
        id: "fishing:gear", title: "Проверьте выбранные снасти", topicId: "journeys", severity: "problem",
        message: "Перед отправлением выберите имеющиеся удочку и крючок. Наживку можно отключить.",
        action: { label: "Открыть рыбалку", target: { kind: "expeditions", sector: "coast" } },
      };
      if (gear.equippedBaitId && (state.inventory[gear.equippedBaitId] ?? 0) < 1) return {
        id: "fishing:bait", title: "Выбранная наживка закончилась", topicId: "journeys", severity: "problem",
        message: "В подготовке к рыбалке выберите «Без наживки» или другой вид из запасов. Для вылазки расходуется одна наживка.",
        action: { label: "Открыть рыбалку", target: { kind: "expeditions", sector: "coast" } },
      };
      return costAdvice(state, fishingTripCost(route.cost, state), now);
    }
    return costAdvice(state, route.cost, now);
  }
  if (context.intent === "construction" && context.stationId) {
    const stationId = context.stationId;
    const next = state.catalog.buildings.find(building => building.id === stationId)?.levels.find(level => level.level === (state.buildings[stationId] ?? 0) + 1);
    if (!next || !worldConstructionReason(state, stationId, next)) return null;
    const requirement = requirementAdvice(state, worldRequirements(next), now);
    if (requirement) return requirement;
    const construction = state.jobs.find(job => job.kind === "construction");
    if (construction) return jobAdvice(state, construction, now);
    const stationWork = state.jobs.find(job => job.kind === "production" && job.targetId === stationId
      || stationId === "quarry" && job.kind === "exploration" && state.catalog.explorations.some(route => route.id === job.targetId && route.requiredBuildings.quarry));
    return stationWork ? jobAdvice(state, stationWork, now) : costAdvice(state, next.cost, now);
  }
  if (!context.recipeId || context.intent === "construction") return null;
  const [recipeId, encodedFishId, extra] = context.recipeId.split("@");
  const fishId = context.fishItemId ?? encodedFishId;
  const quantity = context.quantity ?? 1;
  const original = state.catalog.recipes.find(recipe => recipe.id === recipeId);
  if (!original || context.stationId && original.buildingId !== context.stationId || extra !== undefined
    || fishId !== undefined && !original.fishInput?.itemIds.includes(fishId)
    || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const recipe = recipeWithFish(original, fishId);
  if (!worldProductionReason(state, recipe, quantity)) return null;
  const requirement = requirementAdvice(state, worldRequirements(recipe, recipe), now);
  if (requirement) return requirement;
  const buildingWork = state.jobs.find(job => job.kind === "construction" && job.targetId === recipe.buildingId);
  if (buildingWork) return jobAdvice(state, buildingWork, now);
  const jobs = state.jobs.filter(job => job.kind === "production" && job.targetId === recipe.buildingId);
  if (jobs.length >= productionSlotCount(state, recipe.buildingId)) return jobAdvice(state, jobs.find(job => ready(job, now)) ?? jobs[0], now);
  if (quantity > worldBatchLimit(state, recipe)) return {
    id: "recipe:storage-capacity", title: "Уменьшите партию", message: `Для этого рецепта сейчас можно выбрать не больше ${worldBatchLimit(state, recipe)} партий. Лимит зависит от рецепта и вместимости кладовой.`,
    topicId: "resources", severity: "problem", action: worldBatchLimit(state, recipe) > 0
      ? { label: "Изменить партию", target: { kind: "station", stationId: recipe.buildingId, recipeId: recipe.id } }
      : { label: "Улучшение кладовой", target: { kind: "upgrade", stationId: "warehouse" } },
  };
  // A recipe's default fish is a placeholder. An owned alternative is useful,
  // but help must never select it or spend a rarer species on the player's behalf.
  const placeholder = recipe.fishInput?.itemIds.find(id => recipe.cost.items[id] > 0);
  const alternate = placeholder && (state.inventory[placeholder] ?? 0) < recipe.cost.items[placeholder] * quantity
    ? recipe.fishInput?.itemIds.find(id => id !== placeholder && (state.inventory[id] ?? 0) >= recipe.cost.items[placeholder] * quantity) : null;
  if (alternate) return { id: `recipe:fish-choice:${recipe.id}`, title: "Подойдёт другая рыба", topicId: "food", severity: "next",
    message: `У вас есть ${itemName(state, alternate)}. В рецепте можно выбрать этот вид; сначала проверьте остальные ингредиенты.`,
    action: { label: "Выбрать рыбу в рецепте", target: { kind: "station", stationId: recipe.buildingId, recipeId: recipe.id } } };
  return costAdvice(state, recipe.cost, now, quantity);
}

/** Suggestions describe confirmed state only. Reading never retries, collects,
 * spends resources, mutates a snapshot, or interprets local mood as hunger. */
export function worldHelpAdvice({ economy, world, observation, context, isOnline }: AdviceInput): readonly WorldHelpSuggestion[] {
  if (isOnline === false) return [{ id: "connection:offline", title: "Сейчас нет сети", topicId: "saving", severity: "problem",
    message: "Справка доступна. Подключитесь к интернету, чтобы обновить запасы и проверить результаты действий." }];
  if (observation?.memory.sync?.mode === "other-device") return [{ id: "connection:other-device", title: "Мир открыт на другом устройстве", topicId: "saving", severity: "problem",
    message: observation.memory.sync.canTakeOver
      ? "Откройте настроение в профиле и выберите «Продолжить здесь», если хотите передать управление этому устройству."
      : "Управление остаётся на другом устройстве. В настроении профиля можно посмотреть состояние синхронизации.",
    action: { label: "Открыть профиль", target: { kind: "profile", tab: "mood" } } }];
  for (const [kind, controller] of [["economy", economy], ["world", world]] as const) {
    if (!controller) continue;
    if (controller.uncertain) return [{ id: `connection:${kind}:uncertain`, title: "Результат действия ещё не подтверждён", topicId: "saving", severity: "problem",
      message: "Проверьте результат прежнего запроса перед новым действием. Повторная проверка не должна создавать новую покупку или работу.",
      ...(!controller.busy && (kind !== "economy" || (economy?.retryAt ?? 0) <= economy!.now)
        ? { action: { label: "Проверить результат", target: { kind: kind === "economy" ? "retry-economy" : "retry-world" } as WorldHelpTarget } } : {}) }];
    if (controller.error || kind === "economy" && (economy?.retryAt ?? 0) > economy!.now) return [{ id: `connection:${kind}:error`, title: "Нужно обновить состояние игры", topicId: "saving", severity: "problem",
      message: "Последняя попытка закончилась ошибкой. Проверьте состояние перед следующим действием; старые запасы могут быть неактуальны.",
      ...(!controller.busy && (kind !== "economy" || (economy?.retryAt ?? 0) <= economy!.now)
        ? { action: { label: "Обновить состояние", target: { kind: kind === "economy" ? "retry-economy" : "retry-world" } as WorldHelpTarget } } : {}) }];
  }
  // Do not diagnose poverty, idle actors or available recipes from an unknown or
  // changing snapshot. Pending commands may already have consumed those goods.
  if (!economy?.snapshot || economy.busy || world?.busy || !Number.isFinite(economy.now)) return [];
  const state = economy.snapshot, now = economy.now;
  const suggestions: WorldHelpSuggestion[] = [];
  const add = (suggestion: WorldHelpSuggestion | null) => {
    if (suggestion && !suggestions.some(entry => entry.id === suggestion.id)) suggestions.push(suggestion);
  };
  const readyJobs = state.jobs.filter(job => ready(job, now));
  const blockedDelivery = readyJobs.find(job => job.kind !== "construction" && itemCount(job.rewards) > state.storage.available);
  if (state.storage.available === 0 || state.storage.overflow > 0 || blockedDelivery) add({
    id: "storage:space", title: "Нужно место в кладовой", topicId: "storage", severity: "problem",
    message: blockedDelivery ? `Для готового результата нужно освободить ещё ${Math.max(0, itemCount(blockedDelivery.rewards) - state.storage.available)} мест. Он дождётся получения.`
      : "Кладовая заполнена. Используйте материалы, выполните подходящий заказ или продайте выбранный запас. Товары на обмене тоже занимают место.",
    action: { label: "Открыть кладовую", target: { kind: "pantry" } },
  });
  add(contextAdvice(state, context, now));
  for (const job of readyJobs) {
    if (job.kind !== "construction" && itemCount(job.rewards) > state.storage.available) continue;
    add(jobAdvice(state, job, now));
  }
  const noSupplies = !Object.values(state.inventory).some(count => count > 0);
  if (noSupplies && suggestions.length < 3 && state.storage.available > 0) {
    const conflict = economyActorConflict(state.jobs, "departure", now);
    if (conflict) add(jobAdvice(state, conflict.job, now));
    else {
      const route = state.catalog.explorations.find(route => sector(route.id) === "forest" && freeCost(route.cost)
        && !worldMissingRequirements(state, worldRequirements(route)).length && itemCount(route.rewards) <= state.storage.capacity);
      if (route) add({ id: "start:free-forest", title: "Припасы можно добыть бесплатно", message: `${route.name}: материалы без монет и припасов на дорогу. После возвращения заберите находки.`,
        topicId: "start", severity: "next", action: { label: "Открыть лесные вылазки", target: { kind: "expeditions", sector: "forest" } } });
    }
    const berries = state.catalog.recipes.find(recipe => recipe.buildingId === "garden" && freeCost(recipe.cost) && recipe.rewards.berries > 0 && !worldProductionReason(state, recipe));
    if (berries) add({ id: "start:free-berries", title: "Ягоды растут без затрат", message: "Запустите выращивание на кусте. Созревший урожай затем собирает свободный Мохлик.",
      topicId: "production", severity: "next", action: { label: "Открыть ягодный куст", target: { kind: "station", stationId: "garden", recipeId: berries.id } } });
  }
  return suggestions.sort((left, right) => Number(left.severity === "next") - Number(right.severity === "next")).slice(0, 3);
}
