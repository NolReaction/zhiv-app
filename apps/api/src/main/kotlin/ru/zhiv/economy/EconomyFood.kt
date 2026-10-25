package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigInteger
import java.time.Duration
import java.time.Instant

@Serializable data class EconomyFoodState(val heroMeal: String? = null, val builderMeal: String? = null)
@Serializable data class EconomyJobMeal(val itemId: String, val consumer: String, val speedBps: Int) {
    init { require(consumer in setOf("hero", "builder") && speedBps in 0..10000) }
}
@Serializable data class EconomyMealSpec(val itemId: String, val heroSpeedBps: Int, val builderSpeedBps: Int = 1000) {
    init { require(heroSpeedBps in 0..10000 && builderSpeedBps in 0..10000) }
}
@Serializable data class EconomyRecipeFishInput(val itemIds: List<String>)
@Serializable data class EconomyResidentOrderSlot(val sequence: Long = 0, val readyAt: String, val templateId: String? = null,
    val terms: EconomyResidentOrderTemplate? = null, val residentId: String? = null, val retired: Boolean = false)
@Serializable data class EconomyResidentOrders(
    val cycle: Long = -1, val slots: List<EconomyResidentOrderSlot> = emptyList(),
    val completed: Long = 0, val earnedCoins: Long = 0,
    val version: Int = 1, val recentTemplateIds: List<String> = emptyList(),
    val replacementCycle: Long = -1, val freeReplacementsUsed: Int = 0,
)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyResidentOrderTemplate(
    val id: String, val residentId: String, val name: String, val requiredHomeLevel: Int = 1,
    val requiredBuildings: Map<String, Int> = emptyMap(), val items: Map<String, Long>, val coins: Long,
    val description: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val requiredExplorations: Map<String, Long> = emptyMap(),
    @EncodeDefault(EncodeDefault.Mode.NEVER) val reputationXp: Int? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val effortSeconds: Long? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val manufacturingSeconds: Long? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val fishingUncertain: Boolean? = null,
)
@Serializable data class EconomyResidentOrderProgression(
    val rawBpsByHome: List<Int>, val fishBpsByHome: List<Int>, val craftedBpsByHome: List<Int>,
)
@Serializable data class EconomyResidentOrdersConfig(
    val slots: Int = 3, val refreshSeconds: Long = 21600, val replacementSeconds: Long = 1800,
    val completionSeconds: Long = 3600, val templates: List<EconomyResidentOrderTemplate>,
    val freeReplacements: Int = 3, val replacementWindowSeconds: Long = 43200,
    val replacementPricePearls: Long = 10, val recentLimit: Int = 6,
    val progression: EconomyResidentOrderProgression? = null,
)
@Serializable data class EconomyFoodCatalog(val meals: List<EconomyMealSpec>, val orders: EconomyResidentOrdersConfig)
data class EconomyResidentOrderOffer(
    val id: String, val slot: Int, val templateId: String, val residentId: String, val name: String,
    val items: Map<String, Long>, val coins: Long, val availableAt: String, val description: String? = null,
    val reputationXp: Int? = null, val effortSeconds: Long? = null, val manufacturingSeconds: Long? = null,
    val fishingUncertain: Boolean? = null, val weekly: Boolean = false, val stage: Int? = null,
    val stages: Int? = null, val expiresAt: String? = null,
    val requiredBuildings: Map<String, Int> = emptyMap(),
)
data class EconomyResidentOrderBoard(
    val refreshAt: String, val offers: List<EconomyResidentOrderOffer>, val completed: Long, val earnedCoins: Long,
    val freeReplacementsRemaining: Int = 0, val replacementPricePearls: Long = 0, val replacementsResetAt: String = refreshAt,
)

/** Derived boards never write a profile or advance its revision merely because time passed. */
object EconomyFood {
    fun validateCatalog(catalog: EconomyCatalog) {
        val itemIds = catalog.items.map { it.id }.toSet()
        val fishIds = catalog.fishing?.fish?.map { it.itemId }?.toSet() ?: emptySet()
        catalog.recipes.forEach { recipe -> recipe.fishInput?.let { input ->
            require(input.itemIds.isNotEmpty() && input.itemIds.distinct().size == input.itemIds.size)
            require(input.itemIds.all { it in fishIds })
            require(recipe.cost.items.keys.count { it in fishIds } == 1)
            require(recipe.cost.items.filterKeys { it in fishIds }.all { it.key in input.itemIds && it.value > 0 })
        } }
        catalog.food?.let { food ->
            require(food.meals.isNotEmpty() && food.meals.map { it.itemId }.distinct().size == food.meals.size)
            require(food.meals.all { it.itemId in itemIds })
            val orders = food.orders
            require(orders.slots in setOf(3, 5) && orders.refreshSeconds in 3600L..86400L)
            require(orders.replacementSeconds in 0L..86400L && orders.completionSeconds in 0L..86400L)
            require(orders.freeReplacements in 0..100 && orders.replacementWindowSeconds in 3600L..86400L
                && orders.replacementPricePearls in 0L..ECONOMY_MAX_BALANCE && orders.recentLimit in 0..100)
            orders.progression?.let { progression ->
                require(progression.rawBpsByHome.size == 5 && progression.rawBpsByHome.all { it in 10000..100000 })
                require(progression.fishBpsByHome.size == 5 && progression.fishBpsByHome.all { it in 10000..20000 })
                require(progression.craftedBpsByHome.size == 5 && progression.craftedBpsByHome.all { it in 10000..20000 })
            }
            require(orders.templates.isNotEmpty() && orders.templates.map { it.id }.distinct().size == orders.templates.size)
            require(orders.templates.map(::composition).distinct().size == orders.templates.size)
            require(orders.templates.all { template ->
                template.id.matches(Regex("[a-z0-9_]{1,40}")) && template.residentId in tradeResidentIds &&
                    template.requiredHomeLevel in 1..5 && template.items.isNotEmpty() &&
                    template.items.all { (id, quantity) -> id in itemIds && quantity in 1L..100L } &&
                    template.coins in 1L..ECONOMY_MAX_BALANCE && template.requiredBuildings.all { (id, level) ->
                        catalog.buildings.any { it.id == id && it.levels.any { spec -> spec.level == level } }
                    } && template.requiredExplorations.all { (id, count) ->
                        count in 1L..ECONOMY_MAX_ITEMS && catalog.explorations.any { it.id == id }
                    }
            })
            require(orders.templates.any { it.requiredHomeLevel == 1 && it.requiredBuildings.isEmpty() })
            require(orders.templates.all { template ->
                (template.reputationXp == null || template.reputationXp in 0..18) &&
                (template.effortSeconds == null || template.effortSeconds in 0L..31_536_000L) &&
                (template.manufacturingSeconds == null || template.manufacturingSeconds in 0L..(template.effortSeconds ?: 31_536_000L))
            })
        }
    }

    fun recipeWithFish(recipe: EconomyRecipe, fishItemId: String?, catalog: EconomyCatalog = EconomyRules.catalog): EconomyRecipe {
        if (fishItemId == null) return recipe
        val input = recipe.fishInput ?: economyFailure("ECONOMY_RECIPE_FISH", "В этом рецепте нельзя заменить рыбу")
        if (fishItemId !in input.itemIds) economyFailure("ECONOMY_RECIPE_FISH", "Эта рыба не подходит для выбранного блюда")
        val fishIds = catalog.fishing?.fish?.map { it.itemId }?.toSet() ?: emptySet()
        val placeholder = recipe.cost.items.keys.singleOrNull { it in fishIds }
            ?: economyFailure("ECONOMY_RECIPE_FISH", "Не удалось определить ингредиент блюда")
        return recipe.copy(cost = recipe.cost.copy(items = (recipe.cost.items - placeholder) +
            (fishItemId to recipe.cost.items.getValue(placeholder))))
    }

    /** Speed +10% means duration /1.1; integer ceiling never promises an earlier finish. */
    fun mealDuration(duration: Long, speedBps: Int): Long {
        require(duration >= 0 && speedBps in 0..10000)
        val divisor = 10000L + speedBps
        return duration / divisor * 10000 + (duration % divisor * 10000 + divisor - 1) / divisor
    }

    /** Food and the one role-specific friendship bonus add before the single ceiling. */
    fun workDuration(duration: Long, foodBps: Int, tradeSpeedBps: Int): Long {
        require(duration >= 0 && foodBps in 0..10000 && tradeSpeedBps in 0..1000)
        val divisor = 10000L + foodBps + tradeSpeedBps
        return duration / divisor * 10000L + (duration % divisor * 10000L + divisor - 1) / divisor
    }

    fun fedConstructionDuration(duration: Long, foodBps: Int, tradeSpeedBps: Int): Long {
        require(duration >= 0 && foodBps in 0..10000 && tradeSpeedBps in 0..1000)
        val numerator = 10000L + tradeSpeedBps
        val divisor = numerator + foodBps
        return duration / divisor * numerator + (duration % divisor * numerator + divisor - 1) / divisor
    }

    fun pendingMeal(state: EconomyState, consumer: String): EconomyJobMeal? {
        val id = if (consumer == "hero") state.food.heroMeal else state.food.builderMeal
        val spec = EconomyRules.catalog.food?.meals?.find { it.itemId == id } ?: return null
        return EconomyJobMeal(spec.itemId, consumer, if (consumer == "hero") spec.heroSpeedBps else spec.builderSpeedBps)
    }

    /** Pending portions still belong to the player; job meals have been consumed. */
    fun pendingPortions(state: EconomyState): Int = listOfNotNull(state.food.heroMeal, state.food.builderMeal).size

    fun cancelMeal(state: EconomyState, consumer: String, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        if (consumer !in setOf("hero", "builder")) invalidEconomy()
        val itemId = (if (consumer == "hero") state.food.heroMeal else state.food.builderMeal)
            ?: economyFailure("ECONOMY_MEAL_UNAVAILABLE", "Нет блюда для возврата: оно уже использовано или не выбрано")
        if (EconomyRules.catalog.food?.meals?.none { it.itemId == itemId } != false)
            economyFailure("ECONOMY_FOOD", "Не удалось определить сохранённое блюдо")
        val inventory = EconomyRules.addItems(state.inventory, mapOf(itemId to 1L))
        EconomyRules.addItems(inventory, reservedItems)
        val next = state.copy(inventory = inventory,
            food = if (consumer == "hero") state.food.copy(heroMeal = null) else state.food.copy(builderMeal = null))
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return next to "Неиспользованное блюдо возвращено в кладовую"
    }

    fun eat(state: EconomyState, itemId: String, builder: Boolean, now: Instant): Pair<EconomyState, String> {
        val spec = EconomyRules.catalog.food?.meals?.find { it.itemId == itemId }
            ?: economyFailure("ECONOMY_FOOD", "Выберите готовое блюдо")
        val construction = state.jobs.firstOrNull { it.kind == "construction" }
        if (builder) {
            if (state.food.builderMeal != null)
                economyFailure("ECONOMY_ALREADY_FED", "Шишколап уже сыт. Бонусы еды не складываются")
            if (construction != null && !now.isBefore(Instant.parse(construction.finishesAt)))
                economyFailure("ECONOMY_JOB_READY", "Сначала завершите готовую стройку")
            if (construction?.meal != null) economyFailure("ECONOMY_ALREADY_FED", "Шишколап уже поел для этой стройки")
        } else {
            if (state.food.heroMeal != null) economyFailure("ECONOMY_ALREADY_FED", "Мохлик уже сыт. Блюдо сохранено в кладовой")
            if (state.jobs.any { it.collection?.startedAt != null })
                economyFailure("ECONOMY_COLLECTOR_BUSY", "Сначала завершите сбор припасов")
            if (state.jobs.any { it.kind == "exploration" && !EconomyRules.isMinerJob(it) })
                economyFailure("ECONOMY_EXPLORER_BUSY", "Сначала дождитесь Мохлика и заберите результат работы")
            if (state.jobs.any { it.kind == "production" && it.targetId == "quarry" })
                economyFailure("ECONOMY_QUARRY_BUSY", "Сначала дождитесь Мохлика и заберите добычу из каменоломни")
        }
        val spent = spendItems(state, mapOf(itemId to 1L))
        if (builder && construction != null) {
            val remaining = Duration.between(now, Instant.parse(construction.finishesAt)).toMillis()
            val finish = now.plusMillis(fedConstructionDuration(remaining, spec.builderSpeedBps, construction.tradeSpeedBps))
            return spent.copy(jobs = state.jobs.map { if (it.id == construction.id) it.copy(finishesAt = finish.toString(),
                meal = EconomyJobMeal(itemId, "builder", spec.builderSpeedBps)) else it }) to "Шишколап поел и строит на ${spec.builderSpeedBps / 100}% быстрее"
        }
        return spent.copy(food = if (builder) state.food.copy(builderMeal = itemId) else state.food.copy(heroMeal = itemId)) to
            if (builder) "Шишколап сыт: следующая стройка пойдёт на ${spec.builderSpeedBps / 100}% быстрее" else "Мохлик сыт: следующая вылазка пройдёт быстрее"
    }

    private fun itemPairs(template: EconomyResidentOrderTemplate) = JsonArray(template.items.toSortedMap().map { (id, quantity) ->
        JsonArray(listOf(JsonPrimitive(id), JsonPrimitive(quantity)))
    })
    private fun composition(template: EconomyResidentOrderTemplate): String = itemPairs(template).toString()
    internal fun fingerprint(template: EconomyResidentOrderTemplate): String {
        val fields = mutableListOf<kotlinx.serialization.json.JsonElement>(JsonPrimitive(template.id), JsonPrimitive(template.residentId), itemPairs(template), JsonPrimitive(template.coins))
        if (template.reputationXp != null || template.effortSeconds != null || template.manufacturingSeconds != null || template.fishingUncertain != null)
            fields += listOf(JsonPrimitive(template.reputationXp ?: 0), JsonPrimitive(template.effortSeconds ?: 0L),
                JsonPrimitive(template.manufacturingSeconds ?: 0L), JsonPrimitive(template.fishingUncertain ?: false))
        return hash(JsonArray(fields).toString()).toString()
    }

    private fun resident(slot: Int): String? = when (slot) { 0 -> "plesk"; 1 -> "builder"; else -> null }
    /** Resolve full input chains, not just the final station. Held inventory and
     * unfinished construction do not make a resource sustainably obtainable. */
    fun obtainableOrderItems(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): Set<String> {
        val reachable = mutableSetOf<String>()
        val fishing = catalog.fishing
        val catchable = fishing?.let { spec ->
            spec.rods.filter { it.id in state.fishing.ownedRods }.flatMap { rod ->
                spec.hooks.filter { it.id in state.fishing.ownedHooks }.flatMap { hook ->
                    EconomyRules.fishingClassWeights(rod.id, null, hook.id, spec)
                        .filter { it.second > 0 }.map { it.first.itemId }
                }
            }.toSet()
        } ?: emptySet()
        fun unlocked(home: Int, buildings: Map<String, Int>) = (state.buildings["home"] ?: 1) >= home &&
            buildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level }
        do {
            val before = reachable.size
            catalog.explorations.filterNot { it.retired }.forEach { route ->
                if (unlocked(route.requiredHomeLevel, route.requiredBuildings) && route.cost.items.keys.all { it in reachable }) {
                    reachable += if (route.id in (fishing?.routeIds ?: emptyList())) route.rewards.filter { (id, count) -> id != "fish" && count > 0 }.keys
                        else EconomyFishInventory.items(route.rewards, catalog).filterValues { it > 0 }.keys
                    if (route.id in (fishing?.routeIds ?: emptyList())) reachable += catchable
                }
            }
            catalog.recipes.filterNot { it.retired }.forEach { recipe ->
                val options = recipe.fishInput?.itemIds
                if (unlocked(recipe.requiredHomeLevel, recipe.requiredBuildings) && (state.buildings[recipe.buildingId] ?: 0) >= recipe.effectiveBuildingLevel &&
                    recipe.requiredRecipes.all { (id, amount) -> (state.progression.recipes[id] ?: 0L) >= amount } &&
                    recipe.cost.items.keys.all { it in reachable || it in (options ?: emptyList()) } &&
                    (options == null || options.any { it in reachable })) reachable += recipe.rewards.filterValues { it > 0 }.keys
            }
        } while (reachable.size > before)
        return reachable
    }

    fun progressedTemplate(template: EconomyResidentOrderTemplate, homeLevel: Int,
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrderTemplate {
        val progression = catalog.food?.orders?.progression ?: return template
        val level = (homeLevel - 1).coerceIn(0, 4)
        val byId = catalog.items.associateBy { it.id }
        val fishIds = catalog.fishing?.classes?.map { it.itemId }?.toSet() ?: emptySet()
        val items = template.items.mapValues { (id, quantity) ->
            val bps = when {
                id in fishIds -> progression.fishBpsByHome[level]
                byId[id]?.category in setOf("crafted", "provisions") -> progression.craftedBpsByHome[level]
                else -> progression.rawBpsByHome[level]
            }
            maxOf(quantity, quantity * bps / 10000)
        }
        fun value(goods: Map<String, Long>) = goods.entries.fold(BigInteger.ZERO) { sum, (id, count) ->
            sum + count.toBigInteger() * (byId[id]?.baseSellPrice ?: 0L).toBigInteger()
        }
        val originalValue = value(template.items)
        // New quotes are rounded once to a coin; old catalog policies used tens.
        // Frozen slot terms never pass through this scaling calculation again.
        val quantum = if (catalog.version >= 13) BigInteger.ONE else BigInteger.TEN
        val divisor = originalValue * quantum
        val payment = if (originalValue == BigInteger.ZERO) template.coins.toBigInteger()
            else (template.coins.toBigInteger() * value(items) + divisor - BigInteger.ONE) / divisor * quantum
        require(payment <= ECONOMY_MAX_BALANCE.toBigInteger()) { "Order payout exceeds wallet capacity" }
        val coins = payment.longValueExact()
        return template.copy(items = items, coins = coins)
    }

    fun eligibleOrderTemplates(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): List<EconomyResidentOrderTemplate> {
        val reachable = obtainableOrderItems(state, catalog)
        return catalog.food?.orders?.templates?.filter { template -> (catalog.tradeRelations == null || EconomyTradeRelations.available(state, template.residentId, catalog)) &&
            (state.buildings["home"] ?: 1) >= template.requiredHomeLevel &&
            template.requiredBuildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level } && template.items.keys.all { it in reachable } }
            ?.map { progressedTemplate(it, state.buildings["home"] ?: 1, catalog) }?.sortedBy { it.id } ?: emptyList()
    }
    private fun history(values: List<String>, limit: Int): List<String> =
        values.asReversed().distinct().asReversed().takeLast(limit)
    private fun retire(values: List<String>, id: String, limit: Int): List<String> = history(values + id, limit)

    /** Every slot is chosen independently; relaxing history never removes the persisted memory. */
    private fun chooseTemplate(slot: Int, sequence: Long, cycle: Long, eligible: List<EconomyResidentOrderTemplate>,
        occupied: List<EconomyResidentOrderTemplate>, recent: List<String>, outgoing: String? = null,
        residentId: String? = resident(slot)): EconomyResidentOrderTemplate? {
        val ids = occupied.map { it.id }.toSet()
        val compositions = occupied.map(::composition).toSet()
        var pool = eligible.filter { (residentId == null || it.residentId == residentId) && it.id !in ids && composition(it) !in compositions }
        if (outgoing != null && pool.any { it.id != outgoing }) pool = pool.filter { it.id != outgoing }
        var blocked = recent
        var candidates = pool.filter { it.id !in blocked }
        while (candidates.isEmpty() && blocked.isNotEmpty()) {
            blocked = blocked.drop(1)
            candidates = pool.filter { it.id !in blocked }
        }
        return candidates.takeIf { it.isNotEmpty() }?.let { it[(hash("order2:$cycle:$slot:$sequence") % it.size).toInt()] }
    }

    fun normalizedOrders(state: EconomyState, now: Instant, catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrders {
        val previous = EconomyFishInventory.state(state, catalog).residentOrders
        val config = catalog.food?.orders ?: return EconomyResidentOrders(completed = previous.completed, earnedCoins = previous.earnedCoins)
        val relations = catalog.tradeRelations != null && config.slots == 5
        val cycle = Math.floorDiv(now.epochSecond, config.refreshSeconds)
        val replacementCycle = Math.floorDiv(now.epochSecond, config.replacementWindowSeconds)
        val start = Instant.ofEpochSecond(cycle * config.refreshSeconds).toString()
        val eligible = eligibleOrderTemplates(state, catalog)
        val reachable = obtainableOrderItems(state, catalog)
        val knownItems = catalog.items.map { it.id }.toSet()
        val byId = config.templates.associateBy { it.id }
        var recent = history(previous.recentTemplateIds, config.recentLimit)
        val keepingSlots = previous.version >= 2 && previous.cycle == cycle
        if (previous.version >= 2 && !keepingSlots) previous.slots.forEach { slot ->
            slot.templateId?.let { recent = retire(recent, it, config.recentLimit) }
        }
        val occupied = mutableListOf<EconomyResidentOrderTemplate>()
        val length = if (keepingSlots && previous.slots.isNotEmpty()) previous.slots.size else config.slots
        val slots = MutableList(length) { index ->
            val old = previous.slots.getOrNull(index)?.takeIf { keepingSlots }
            var template = old?.terms ?: old?.templateId?.let(byId::get)
            if (template != null && old != null && previous.version == 2 && old.terms == null)
                template = template.copy(reputationXp = null, effortSeconds = null, manufacturingSeconds = null, fishingUncertain = null)
            val residentId = if (relations) old?.residentId ?: template?.residentId ?: tradeResidentIds.getOrNull(index) else null
            val requiredResident = residentId ?: resident(index)
            val keep = old?.retired != true && template != null && template.id == old?.templateId &&
                (requiredResident == null || template.residentId == requiredResident) &&
                template.items.keys.all { it in knownItems } &&
                (old?.terms != null || ((!relations || EconomyTradeRelations.available(state, template.residentId, catalog)) &&
                    template.items.keys.all { it in reachable })) &&
                occupied.none { it.id == template.id || composition(it) == composition(template) }
            if (keep) occupied += checkNotNull(template)
            else old?.templateId?.let { recent = retire(recent, it, config.recentLimit) }
            EconomyResidentOrderSlot(old?.sequence ?: 0, if (keep) old.readyAt else start,
                template?.id?.takeIf { keep }, template?.takeIf { keep }, residentId, old?.retired ?: false)
        }
        if (relations) tradeResidentIds.forEach { residentId ->
            if (EconomyTradeRelations.available(state, residentId, catalog) && slots.none { !it.retired && it.residentId == residentId })
                slots += EconomyResidentOrderSlot(0, start, residentId = residentId)
        }
        require(slots.size <= 7)
        slots.indices.forEach { index ->
            val slot = slots[index]
            if (slot.templateId != null || slot.retired || relations && (slot.residentId == null || !EconomyTradeRelations.available(state, slot.residentId, catalog))) return@forEach
            val template = chooseTemplate(index, slot.sequence, cycle, eligible, occupied, recent, residentId = slot.residentId ?: resident(index))
            slots[index] = slot.copy(templateId = template?.id, terms = template)
            if (template != null) occupied += template
        }
        return previous.copy(version = if (relations) 3 else 2, cycle = cycle, slots = slots, recentTemplateIds = recent,
            replacementCycle = replacementCycle, freeReplacementsUsed = if (previous.replacementCycle == replacementCycle)
                previous.freeReplacementsUsed.coerceIn(0, config.freeReplacements) else 0)
    }

    /** Merge never refunds consumed free replacements or changes the target's current cards. */
    fun mergeOrders(target: EconomyState, source: EconomyState, now: Instant,
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrders {
        val a = normalizedOrders(target, now, catalog)
        val b = normalizedOrders(source, now, catalog)
        val config = catalog.food?.orders
        return a.copy(recentTemplateIds = history(b.recentTemplateIds + b.slots.mapNotNull { it.templateId } + a.recentTemplateIds,
            config?.recentLimit ?: 6), completed = minOf(ECONOMY_MAX_REVISION, a.completed + b.completed),
            earnedCoins = minOf(ECONOMY_MAX_REVISION, a.earnedCoins + b.earnedCoins),
            freeReplacementsUsed = minOf(config?.freeReplacements ?: 3, a.freeReplacementsUsed + b.freeReplacementsUsed))
    }

    internal fun hash(value: String): Long {
        var result = 2166136261L
        value.forEach { result = ((result xor it.code.toLong()) * 16777619L) and 0xffffffffL }
        return result
    }

    fun residentOrderBoard(state: EconomyState, now: Instant, catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrderBoard {
        val orders = normalizedOrders(state, now, catalog)
        val config = catalog.food?.orders ?: return EconomyResidentOrderBoard(now.toString(), emptyList(), orders.completed, orders.earnedCoins)
        val offers = orders.slots.mapIndexedNotNull { index, slot ->
            val template = slot.terms ?: return@mapIndexedNotNull null
            EconomyResidentOrderOffer("order2_${orders.cycle}_${index}_${slot.sequence}_${fingerprint(template)}", index, template.id,
                template.residentId, template.name, template.items, template.coins, slot.readyAt, template.description,
                template.reputationXp, template.effortSeconds, template.manufacturingSeconds, template.fishingUncertain)
        }
        val remaining = maxOf(0, config.freeReplacements - orders.freeReplacementsUsed)
        return EconomyResidentOrderBoard(Instant.ofEpochSecond((orders.cycle + 1) * config.refreshSeconds).toString(),
            offers, orders.completed, orders.earnedCoins, remaining, if (remaining > 0) 0 else config.replacementPricePearls,
            Instant.ofEpochSecond((orders.replacementCycle + 1) * config.replacementWindowSeconds).toString())
    }

    /** Resource/counter changes stay with command validation; only this one card retires here. */
    fun advanceResidentOrder(state: EconomyState, slot: Int, now: Instant,
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrders {
        val config = catalog.food?.orders ?: return state.residentOrders
        val board = normalizedOrders(state, now, catalog)
        val outgoing = board.slots.getOrNull(slot)?.takeIf { it.templateId != null }
            ?: economyFailure("ECONOMY_ORDER_CHANGED", "Заказ больше недоступен")
        if (outgoing.sequence >= ECONOMY_MAX_REVISION) economyFailure("ECONOMY_CAPACITY", "Дождитесь обновления заказов")
        val recent = outgoing.templateId?.let { retire(board.recentTemplateIds, it, config.recentLimit) } ?: board.recentTemplateIds
        val eligible = eligibleOrderTemplates(state, catalog)
        val occupied = board.slots.filterIndexed { index, _ -> index != slot }.mapNotNull { current -> current.terms }
        val sequence = outgoing.sequence + 1
        if (board.version == 3 && outgoing.residentId != null && board.slots.filterIndexed { index, _ -> index != slot }
                .any { !it.retired && it.residentId == outgoing.residentId && it.templateId != null })
            return board.copy(recentTemplateIds = recent, slots = board.slots.mapIndexed { index, current ->
                if (index == slot) current.copy(sequence = sequence, templateId = null, terms = null, retired = true) else current
            })
        val next = chooseTemplate(slot, sequence, board.cycle, eligible, occupied, recent, outgoing.templateId, outgoing.residentId ?: resident(slot))
        return board.copy(recentTemplateIds = recent, slots = board.slots.mapIndexed { index, current ->
            if (index == slot) current.copy(sequence = sequence, templateId = next?.id, terms = next) else current
        })
    }

    fun order(state: EconomyState, targetId: String, replace: Boolean, now: Instant, quotedPrice: Long = 0,
        catalog: EconomyCatalog = EconomyRules.catalog, fishSelection: Map<String, Long>? = null): Pair<EconomyState, String> {
        val config = catalog.food?.orders ?: economyFailure("ECONOMY_ORDER_CHANGED", "Заказы пока недоступны")
        val current = residentOrderBoard(state, now, catalog)
        val offer = current.offers.find { it.id == targetId }
            ?: economyFailure("ECONOMY_ORDER_CHANGED", "Просьбы жителей обновились. Выберите актуальный заказ")
        val board = normalizedOrders(state, now, catalog)
        if (board.slots[offer.slot].sequence >= ECONOMY_MAX_REVISION) economyFailure("ECONOMY_CAPACITY", "Дождитесь обновления заказов")
        if (!replace && (offer.coins > ECONOMY_MAX_BALANCE - state.wallet.coins ||
            offer.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION))
            economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
        val retiresDuplicate = replace && board.version == 3 && board.slots[offer.slot].residentId != null &&
            board.slots.filterIndexed { index, _ -> index != offer.slot }.any {
                !it.retired && it.residentId == board.slots[offer.slot].residentId && it.templateId != null }
        val price = if (replace && !retiresDuplicate) current.replacementPricePearls else 0
        if (price > quotedPrice) economyFailure("ECONOMY_ORDER_PRICE_CHANGED", "Цена замены изменилась. Проверьте стоимость и подтвердите снова")
        if (replace && state.wallet.pearls < price) economyFailure("ECONOMY_PEARLS", "Не хватает жемчужин для замены заказа")
        val nextBoard = advanceResidentOrder(state, offer.slot, now, catalog)
        if (replace && !retiresDuplicate) {
            val replacement = nextBoard.slots.getOrNull(offer.slot)?.terms
            if (replacement == null || replacement.id == offer.templateId || replacement.items == offer.items)
                economyFailure("ECONOMY_ORDER_NO_ALTERNATIVE", "Других подходящих заказов пока нет. Замена не потрачена")
        }
        val spent = if (replace) state else EconomyRules.spend(state, EconomyCost(items = offer.items), fishSelection)
        val next = spent.copy(wallet = if (replace) spent.wallet.copy(pearls = spent.wallet.pearls - price)
            else spent.wallet.copy(coins = spent.wallet.coins + offer.coins), residentOrders = nextBoard.copy(
                freeReplacementsUsed = if (replace && !retiresDuplicate && current.freeReplacementsRemaining > 0)
                    minOf(config.freeReplacements, board.freeReplacementsUsed + 1) else board.freeReplacementsUsed,
                completed = if (replace) board.completed else board.completed + 1,
                earnedCoins = if (replace) board.earnedCoins else board.earnedCoins + offer.coins))
        return (if (replace) next else EconomyTradeRelations.awardOrder(next, offer.residentId, offer.reputationXp ?: 0, now, catalog = catalog)) to
            if (replace) "Заказ заменён. Новая просьба уже доступна" else "Заказ выполнен. Монеты получены"
    }

    private fun spendItems(state: EconomyState, items: Map<String, Long>): EconomyState {
        if (items.any { (id, quantity) -> (state.inventory[id] ?: 0L) < quantity })
            economyFailure("ECONOMY_RESOURCES", "Не хватает припасов в кладовой")
        return EconomyRules.spend(state, EconomyCost(items = items))
    }
}
