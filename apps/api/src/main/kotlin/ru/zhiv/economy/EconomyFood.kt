package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
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
@Serializable data class EconomyResidentOrderSlot(val sequence: Long = 0, val readyAt: String, val templateId: String? = null)
@Serializable data class EconomyResidentOrders(
    val cycle: Long = -1, val slots: List<EconomyResidentOrderSlot> = emptyList(),
    val completed: Long = 0, val earnedCoins: Long = 0,
    val version: Int = 1, val recentTemplateIds: List<String> = emptyList(),
    val replacementCycle: Long = -1, val freeReplacementsUsed: Int = 0,
)
@Serializable data class EconomyResidentOrderTemplate(
    val id: String, val residentId: String, val name: String, val requiredHomeLevel: Int = 1,
    val requiredBuildings: Map<String, Int> = emptyMap(), val items: Map<String, Long>, val coins: Long,
    val description: String? = null,
)
@Serializable data class EconomyResidentOrdersConfig(
    val slots: Int = 3, val refreshSeconds: Long = 21600, val replacementSeconds: Long = 1800,
    val completionSeconds: Long = 3600, val templates: List<EconomyResidentOrderTemplate>,
    val freeReplacements: Int = 3, val replacementWindowSeconds: Long = 43200,
    val replacementPricePearls: Long = 10, val recentLimit: Int = 6,
)
@Serializable data class EconomyFoodCatalog(val meals: List<EconomyMealSpec>, val orders: EconomyResidentOrdersConfig)
data class EconomyResidentOrderOffer(
    val id: String, val slot: Int, val templateId: String, val residentId: String, val name: String,
    val items: Map<String, Long>, val coins: Long, val availableAt: String, val description: String? = null,
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
            require(orders.slots == 3 && orders.refreshSeconds in 3600L..86400L)
            require(orders.replacementSeconds in 0L..86400L && orders.completionSeconds in 0L..86400L)
            require(orders.freeReplacements in 0..100 && orders.replacementWindowSeconds in 3600L..86400L
                && orders.replacementPricePearls in 0L..ECONOMY_MAX_BALANCE && orders.recentLimit in 0..100)
            require(orders.templates.isNotEmpty() && orders.templates.map { it.id }.distinct().size == orders.templates.size)
            require(orders.templates.map(::composition).distinct().size == orders.templates.size)
            require(orders.templates.all { template ->
                template.id.matches(Regex("[a-z0-9_]{1,40}")) && template.residentId in setOf("plesk", "builder") &&
                    template.requiredHomeLevel in 1..5 && template.items.isNotEmpty() &&
                    template.items.all { (id, quantity) -> id in itemIds && quantity in 1L..100L } &&
                    template.coins in 1L..ECONOMY_MAX_BALANCE && template.requiredBuildings.all { (id, level) ->
                        catalog.buildings.any { it.id == id && it.levels.any { spec -> spec.level == level } }
                    }
            })
            require(orders.templates.any { it.requiredHomeLevel == 1 && it.requiredBuildings.isEmpty() })
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

    fun pendingMeal(state: EconomyState, consumer: String): EconomyJobMeal? {
        val id = if (consumer == "hero") state.food.heroMeal else state.food.builderMeal
        val spec = EconomyRules.catalog.food?.meals?.find { it.itemId == id } ?: return null
        return EconomyJobMeal(spec.itemId, consumer, if (consumer == "hero") spec.heroSpeedBps else spec.builderSpeedBps)
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
            if (state.jobs.any { it.kind == "exploration" })
                economyFailure("ECONOMY_EXPLORER_BUSY", "Сначала дождитесь Мохлика и заберите результат работы")
            if (state.jobs.any { it.kind == "production" && it.targetId == "quarry" })
                economyFailure("ECONOMY_QUARRY_BUSY", "Сначала дождитесь Мохлика и заберите добычу из каменоломни")
        }
        val spent = spendItems(state, mapOf(itemId to 1L))
        if (builder && construction != null) {
            val remaining = Duration.between(now, Instant.parse(construction.finishesAt)).toMillis()
            val finish = now.plusMillis(mealDuration(remaining, spec.builderSpeedBps))
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
    private fun fingerprint(template: EconomyResidentOrderTemplate): String = hash(JsonArray(listOf(
        JsonPrimitive(template.id), JsonPrimitive(template.residentId), itemPairs(template), JsonPrimitive(template.coins),
    )).toString()).toString()

    private fun resident(slot: Int): String? = when (slot) { 0 -> "plesk"; 1 -> "builder"; else -> null }
    private fun eligible(state: EconomyState, catalog: EconomyCatalog): List<EconomyResidentOrderTemplate> =
        catalog.food?.orders?.templates?.filter { template -> (state.buildings["home"] ?: 1) >= template.requiredHomeLevel &&
            template.requiredBuildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level } }?.sortedBy { it.id } ?: emptyList()
    private fun history(values: List<String>, limit: Int): List<String> =
        values.asReversed().distinct().asReversed().takeLast(limit)
    private fun retire(values: List<String>, id: String, limit: Int): List<String> = history(values + id, limit)

    /** Every slot is chosen independently; relaxing history never removes the persisted memory. */
    private fun chooseTemplate(slot: Int, sequence: Long, cycle: Long, eligible: List<EconomyResidentOrderTemplate>,
        occupied: List<EconomyResidentOrderTemplate>, recent: List<String>, outgoing: String? = null): EconomyResidentOrderTemplate? {
        val ids = occupied.map { it.id }.toSet()
        val compositions = occupied.map(::composition).toSet()
        var pool = eligible.filter { (resident(slot) == null || it.residentId == resident(slot)) && it.id !in ids && composition(it) !in compositions }
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
        val previous = state.residentOrders
        val config = catalog.food?.orders ?: return EconomyResidentOrders(completed = previous.completed, earnedCoins = previous.earnedCoins)
        val cycle = Math.floorDiv(now.epochSecond, config.refreshSeconds)
        val replacementCycle = Math.floorDiv(now.epochSecond, config.replacementWindowSeconds)
        val start = Instant.ofEpochSecond(cycle * config.refreshSeconds).toString()
        val eligible = eligible(state, catalog)
        val byId = eligible.associateBy { it.id }
        var recent = history(previous.recentTemplateIds, config.recentLimit)
        val keepingSlots = previous.version == 2 && previous.cycle == cycle
        if (previous.version == 2 && previous.cycle != cycle) previous.slots.forEach { slot ->
            slot.templateId?.let { recent = retire(recent, it, config.recentLimit) }
        }
        val occupied = mutableListOf<EconomyResidentOrderTemplate>()
        val slots = MutableList(config.slots) { index ->
            val old = previous.slots.getOrNull(index)?.takeIf { keepingSlots }
            val template = old?.templateId?.let(byId::get)
            val keep = template != null && (resident(index) == null || template.residentId == resident(index)) &&
                occupied.none { it.id == template.id || composition(it) == composition(template) }
            if (keep) occupied += checkNotNull(template)
            else old?.templateId?.let { recent = retire(recent, it, config.recentLimit) }
            EconomyResidentOrderSlot(old?.sequence ?: 0, start, template?.id?.takeIf { keep })
        }
        slots.indices.forEach { index ->
            if (slots[index].templateId != null) return@forEach
            val template = chooseTemplate(index, slots[index].sequence, cycle, eligible, occupied, recent)
            slots[index] = slots[index].copy(templateId = template?.id)
            if (template != null) occupied += template
        }
        return previous.copy(version = 2, cycle = cycle, slots = slots, recentTemplateIds = recent,
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

    private fun hash(value: String): Long {
        var result = 2166136261L
        value.forEach { result = ((result xor it.code.toLong()) * 16777619L) and 0xffffffffL }
        return result
    }

    fun residentOrderBoard(state: EconomyState, now: Instant, catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrderBoard {
        val orders = normalizedOrders(state, now, catalog)
        val config = catalog.food?.orders ?: return EconomyResidentOrderBoard(now.toString(), emptyList(), orders.completed, orders.earnedCoins)
        val templates = eligible(state, catalog).associateBy { it.id }
        val offers = orders.slots.mapIndexedNotNull { index, slot ->
            val template = slot.templateId?.let(templates::get) ?: return@mapIndexedNotNull null
            EconomyResidentOrderOffer("order2_${orders.cycle}_${index}_${slot.sequence}_${fingerprint(template)}", index, template.id,
                template.residentId, template.name, template.items, template.coins, slot.readyAt, template.description)
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
        val eligible = eligible(state, catalog)
        val occupied = board.slots.filterIndexed { index, _ -> index != slot }.mapNotNull { current -> eligible.find { it.id == current.templateId } }
        val sequence = outgoing.sequence + 1
        val next = chooseTemplate(slot, sequence, board.cycle, eligible, occupied, recent, outgoing.templateId)
        return board.copy(recentTemplateIds = recent, slots = board.slots.mapIndexed { index, current ->
            if (index == slot) current.copy(sequence = sequence, templateId = next?.id) else current
        })
    }

    fun order(state: EconomyState, targetId: String, replace: Boolean, now: Instant, quotedPrice: Long = 0,
        catalog: EconomyCatalog = EconomyRules.catalog): Pair<EconomyState, String> {
        val config = catalog.food?.orders ?: economyFailure("ECONOMY_ORDER_CHANGED", "Заказы пока недоступны")
        val current = residentOrderBoard(state, now, catalog)
        val offer = current.offers.find { it.id == targetId }
            ?: economyFailure("ECONOMY_ORDER_CHANGED", "Просьбы жителей обновились. Выберите актуальный заказ")
        val board = normalizedOrders(state, now, catalog)
        if (board.slots[offer.slot].sequence >= ECONOMY_MAX_REVISION) economyFailure("ECONOMY_CAPACITY", "Дождитесь обновления заказов")
        if (!replace && (offer.coins > ECONOMY_MAX_BALANCE - state.wallet.coins ||
            offer.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION))
            economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
        val price = if (replace) current.replacementPricePearls else 0
        if (price > quotedPrice) economyFailure("ECONOMY_ORDER_PRICE_CHANGED", "Цена замены изменилась. Проверьте стоимость и подтвердите снова")
        if (replace && state.wallet.pearls < price) economyFailure("ECONOMY_PEARLS", "Не хватает жемчужин для замены заказа")
        val nextBoard = advanceResidentOrder(state, offer.slot, now, catalog)
        if (replace) {
            val nextId = nextBoard.slots.getOrNull(offer.slot)?.templateId
            val replacement = config.templates.find { it.id == nextId }
            if (replacement == null || replacement.id == offer.templateId || replacement.items == offer.items)
                economyFailure("ECONOMY_ORDER_NO_ALTERNATIVE", "Других подходящих заказов пока нет. Замена не потрачена")
        }
        val spent = if (replace) state else spendItems(state, offer.items)
        return spent.copy(wallet = if (replace) spent.wallet.copy(pearls = spent.wallet.pearls - price)
            else spent.wallet.copy(coins = spent.wallet.coins + offer.coins), residentOrders = nextBoard.copy(
                freeReplacementsUsed = if (replace && current.freeReplacementsRemaining > 0)
                    minOf(config.freeReplacements, board.freeReplacementsUsed + 1) else board.freeReplacementsUsed,
                completed = if (replace) board.completed else board.completed + 1,
                earnedCoins = if (replace) board.earnedCoins else board.earnedCoins + offer.coins)) to
            if (replace) "Заказ заменён. Новая просьба уже доступна" else "Заказ выполнен. Монеты получены"
    }

    private fun spendItems(state: EconomyState, items: Map<String, Long>): EconomyState {
        if (items.any { (id, quantity) -> (state.inventory[id] ?: 0L) < quantity })
            economyFailure("ECONOMY_RESOURCES", "Не хватает припасов в кладовой")
        return state.copy(inventory = state.inventory.mapValues { (id, quantity) -> quantity - (items[id] ?: 0L) }.filterValues { it > 0 })
    }
}
