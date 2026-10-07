package ru.zhiv.economy

import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant

@Serializable data class EconomyFoodState(val heroMeal: String? = null, val builderMeal: String? = null)
@Serializable data class EconomyJobMeal(val itemId: String, val consumer: String, val speedBps: Int) {
    init { require(consumer in setOf("hero", "builder") && speedBps in 0..2500 && (consumer != "builder" || speedBps == 1000)) }
}
@Serializable data class EconomyMealSpec(val itemId: String, val heroSpeedBps: Int, val builderSpeedBps: Int = 1000) {
    init { require(heroSpeedBps in 0..2500 && builderSpeedBps == 1000) }
}
@Serializable data class EconomyRecipeFishInput(val itemIds: List<String>)
@Serializable data class EconomyResidentOrderSlot(val sequence: Long = 0, val readyAt: String)
@Serializable data class EconomyResidentOrders(
    val cycle: Long = -1, val slots: List<EconomyResidentOrderSlot> = emptyList(),
    val completed: Long = 0, val earnedCoins: Long = 0,
)
@Serializable data class EconomyResidentOrderTemplate(
    val id: String, val residentId: String, val name: String, val requiredHomeLevel: Int = 1,
    val requiredBuildings: Map<String, Int> = emptyMap(), val items: Map<String, Long>, val coins: Long,
)
@Serializable data class EconomyResidentOrdersConfig(
    val slots: Int = 3, val refreshSeconds: Long = 21600, val replacementSeconds: Long = 1800,
    val completionSeconds: Long = 3600, val templates: List<EconomyResidentOrderTemplate>,
)
@Serializable data class EconomyFoodCatalog(val meals: List<EconomyMealSpec>, val orders: EconomyResidentOrdersConfig)
data class EconomyResidentOrderOffer(
    val id: String, val slot: Int, val templateId: String, val residentId: String, val name: String,
    val items: Map<String, Long>, val coins: Long, val availableAt: String,
)
data class EconomyResidentOrderBoard(
    val refreshAt: String, val offers: List<EconomyResidentOrderOffer>, val completed: Long, val earnedCoins: Long,
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
            require(orders.replacementSeconds in 1..orders.refreshSeconds && orders.completionSeconds in 1..orders.refreshSeconds)
            require(orders.templates.isNotEmpty() && orders.templates.map { it.id }.distinct().size == orders.templates.size)
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
        require(duration >= 0 && speedBps in 0..2500)
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
                meal = EconomyJobMeal(itemId, "builder", spec.builderSpeedBps)) else it }) to "Шишколап поел и строит на 10% быстрее"
        }
        return spent.copy(food = if (builder) state.food.copy(builderMeal = itemId) else state.food.copy(heroMeal = itemId)) to
            if (builder) "Шишколап сыт: следующая стройка пойдёт на 10% быстрее" else "Мохлик сыт: следующая вылазка пройдёт быстрее"
    }

    fun normalizedOrders(state: EconomyState, now: Instant, catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrders {
        val config = catalog.food?.orders ?: return state.residentOrders
        val cycle = Math.floorDiv(now.epochSecond, config.refreshSeconds)
        val board = state.residentOrders
        val start = Instant.ofEpochSecond(cycle * config.refreshSeconds).toString()
        return board.copy(cycle = cycle, slots = List(config.slots) { index ->
            board.slots.getOrNull(index)?.takeIf { board.cycle == cycle } ?: EconomyResidentOrderSlot(readyAt = start)
        })
    }

    /** Account consolidation cannot reset a paid order's cooldown or discard lifetime totals. */
    fun mergeOrders(a: EconomyResidentOrders, b: EconomyResidentOrders): EconomyResidentOrders {
        val latest = if (b.cycle > a.cycle) b else a
        val slots = if (a.cycle != b.cycle) latest.slots else (0 until maxOf(a.slots.size, b.slots.size)).map { index ->
            val first = a.slots.getOrNull(index)
            val second = b.slots.getOrNull(index)
            if (first == null) checkNotNull(second) else if (second == null) first else EconomyResidentOrderSlot(
                maxOf(first.sequence, second.sequence),
                if (Instant.parse(first.readyAt).isAfter(Instant.parse(second.readyAt))) first.readyAt else second.readyAt)
        }
        return latest.copy(slots = slots, completed = minOf(ECONOMY_MAX_REVISION, a.completed + b.completed),
            earnedCoins = minOf(ECONOMY_MAX_REVISION, a.earnedCoins + b.earnedCoins))
    }

    private fun hash(value: String): Long {
        var result = 2166136261L
        value.forEach { result = ((result xor it.code.toLong()) * 16777619L) and 0xffffffffL }
        return result
    }

    fun residentOrderBoard(state: EconomyState, now: Instant, catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrderBoard {
        val orders = normalizedOrders(state, now, catalog)
        val config = catalog.food?.orders ?: return EconomyResidentOrderBoard(now.toString(), emptyList(), orders.completed, orders.earnedCoins)
        val eligible = config.templates.filter { template -> (state.buildings["home"] ?: 1) >= template.requiredHomeLevel &&
            template.requiredBuildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level } }.sortedBy { it.id }
        val offers = if (eligible.isEmpty()) emptyList() else orders.slots.mapIndexed { index, slot ->
            val template = eligible[((hash("${orders.cycle}:$index") % eligible.size + slot.sequence % eligible.size) % eligible.size).toInt()]
            EconomyResidentOrderOffer("order_${orders.cycle}_${index}_${slot.sequence}_${template.id}", index, template.id,
                template.residentId, template.name, template.items, template.coins, slot.readyAt)
        }
        return EconomyResidentOrderBoard(Instant.ofEpochSecond((orders.cycle + 1) * config.refreshSeconds).toString(), offers, orders.completed, orders.earnedCoins)
    }

    fun order(state: EconomyState, targetId: String, replace: Boolean, now: Instant): Pair<EconomyState, String> {
        val config = EconomyRules.catalog.food?.orders ?: economyFailure("ECONOMY_ORDER_CHANGED", "Заказы пока недоступны")
        val offer = residentOrderBoard(state, now).offers.find { it.id == targetId }
            ?: economyFailure("ECONOMY_ORDER_CHANGED", "Просьбы жителей обновились. Выберите актуальный заказ")
        if (now.isBefore(Instant.parse(offer.availableAt))) economyFailure("ECONOMY_ORDER_WAIT", "Житель ещё готовит новый заказ")
        val board = normalizedOrders(state, now)
        if (board.slots[offer.slot].sequence >= ECONOMY_MAX_REVISION) economyFailure("ECONOMY_CAPACITY", "Дождитесь обновления заказов")
        if (!replace && (offer.coins > ECONOMY_MAX_BALANCE - state.wallet.coins ||
            offer.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION))
            economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
        val spent = if (replace) state else spendItems(state, offer.items)
        val cooldown = if (replace) config.replacementSeconds else config.completionSeconds
        return spent.copy(wallet = if (replace) spent.wallet else spent.wallet.copy(coins = spent.wallet.coins + offer.coins),
            residentOrders = board.copy(slots = board.slots.mapIndexed { index, slot -> if (index == offer.slot)
                EconomyResidentOrderSlot(slot.sequence + 1, now.plusSeconds(cooldown).toString()) else slot },
                completed = if (replace) board.completed else board.completed + 1,
                earnedCoins = if (replace) board.earnedCoins else board.earnedCoins + offer.coins)) to
            if (replace) "Заказ заменён. Новая просьба скоро станет доступна" else "Заказ выполнен. Монеты получены"
    }

    private fun spendItems(state: EconomyState, items: Map<String, Long>): EconomyState {
        if (items.any { (id, quantity) -> (state.inventory[id] ?: 0L) < quantity })
            economyFailure("ECONOMY_RESOURCES", "Не хватает припасов в кладовой")
        return state.copy(inventory = state.inventory.mapValues { (id, quantity) -> quantity - (items[id] ?: 0L) }.filterValues { it > 0 })
    }
}
