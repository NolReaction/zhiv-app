package ru.zhiv.economy

import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable data class EconomyStageOrderCourse(val homeLevel: Int, val orders: List<EconomyResidentOrderTemplate>,
    val intervalSeconds: Long = 0, val completionRewards: Map<String, Long> = emptyMap())
@Serializable data class EconomyStageOrderProgress(
    val step: Int = 0, val completed: Boolean = false, val terms: EconomyResidentOrderTemplate? = null,
    val availableAt: String? = null, val intervalSeconds: Long? = null, val completionRewards: Map<String, Long>? = null,
) { init {
    require(step in 0..100 && (intervalSeconds == null || intervalSeconds in 0L..31_536_000L))
    availableAt?.let(Instant::parse)
    require(completionRewards == null || completionRewards.values.all { it in 1L..ECONOMY_MAX_ITEMS })
} }
@Serializable data class EconomyStageOrderState(
    val version: Int = 1, val stages: Map<String, EconomyStageOrderProgress> = emptyMap(),
) { init { require(version == 1 && stages.keys.all { it in setOf("2", "3", "4") }) } }

/** A once-per-stage sequence with saved terms and no free ingredients. */
object EconomyStageOrders {
    fun validateCatalog(catalog: EconomyCatalog) {
        require(catalog.stageOrders.map { it.homeLevel }.distinct().size == catalog.stageOrders.size)
        val ids = catalog.stageOrders.flatMap { course -> course.orders.map { it.id } }
        require(ids.distinct().size == ids.size)
        val known = catalog.items.map { it.id }.toSet()
        catalog.stageOrders.forEach { course ->
            require(course.homeLevel in 2..4 && course.orders.size in 1..100)
            require(course.intervalSeconds in 0L..31_536_000L && course.completionRewards.all { (id, amount) ->
                id in known && amount in 1L..ECONOMY_MAX_ITEMS })
            require(course.orders.all { terms -> terms.id.startsWith("stage${course.homeLevel}_") &&
                terms.residentId in setOf("builder", "plesk") && terms.items.isNotEmpty() &&
                terms.items.all { (id, amount) -> id in known && amount in 1L..ECONOMY_MAX_ITEMS } &&
                terms.requiredBuildings.all { (id, level) -> catalog.buildings.any { building ->
                    building.id == id && building.levels.any { it.level == level }
                } } &&
                terms.requiredExplorations.all { (id, count) -> count in 1L..ECONOMY_MAX_ITEMS &&
                    catalog.explorations.any { it.id == id }
                } &&
                terms.coins in 1L..ECONOMY_MAX_BALANCE })
        }
    }

    fun isStageId(id: String, catalog: EconomyCatalog = EconomyRules.catalog): Boolean =
        Regex("^stage[234]_").containsMatchIn(id) || catalog.stageOrders.any { course -> course.orders.any { it.id == id } }

    private fun eligible(state: EconomyState, homeLevel: Int): Boolean =
        (state.buildings["home"] ?: 1) == homeLevel &&
            (homeLevel >= 3 || state.tutorialOrder.version == 1 || state.tutorialOrder.completed)

    fun progress(state: EconomyState, homeLevel: Int = state.buildings["home"] ?: 1): EconomyStageOrderProgress =
        state.stageOrders.stages[homeLevel.toString()] ?: EconomyStageOrderProgress()

    fun required(state: EconomyState, targetHomeLevel: Int, catalog: EconomyCatalog = EconomyRules.catalog): Boolean {
        val home = state.buildings["home"] ?: 1
        return (home >= 3 || state.tutorialOrder.version == 2) && targetHomeLevel == home + 1 &&
            catalog.stageOrders.any { it.homeLevel == home } && !progress(state, home).completed
    }

    fun offer(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): EconomyResidentOrderTemplate? {
        val home = state.buildings["home"] ?: 1
        val course = catalog.stageOrders.find { it.homeLevel == home } ?: return null
        if (!eligible(state, home)) return null
        val progress = progress(state, home)
        if (progress.completed || progress.step >= course.orders.size) return null
        return progress.terms ?: course.orders[progress.step]
    }

    /** Pin as part of a successful command, including the claim which unlocks a new house stage. */
    fun pin(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog, now: Instant? = null): EconomyState {
        val home = state.buildings["home"] ?: 1
        val terms = offer(state, catalog) ?: return state
        val progress = progress(state, home)
        if (progress.terms != null && progress.availableAt != null && progress.intervalSeconds != null && progress.completionRewards != null) return state
        val course = catalog.stageOrders.single { it.homeLevel == home }
        return state.copy(stageOrders = state.stageOrders.copy(stages = state.stageOrders.stages +
            (home.toString() to progress.copy(terms = terms, availableAt = progress.availableAt ?: now?.toString(),
                intervalSeconds = progress.intervalSeconds ?: course.intervalSeconds,
                completionRewards = progress.completionRewards ?: course.completionRewards))))
    }

    fun complete(input: EconomyState, command: EconomyCommand, now: Instant,
        reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        val state = pin(input, now = now)
        val terms = offer(state)
        if (command.action != "complete_resident_order" || terms == null || command.targetId != terms.id)
            economyFailure("ECONOMY_STAGE_ORDER_UNAVAILABLE", "Заказ этапа недоступен или уже выполнен")
        val home = state.buildings["home"] ?: 1
        val course = EconomyRules.catalog.stageOrders.single { it.homeLevel == home }
        val progress = progress(state, home)
        if (progress.availableAt != null && now.isBefore(Instant.parse(progress.availableAt)))
            economyFailure("ECONOMY_STAGE_WAIT", "Следующий заказ появится в назначенное время")
        EconomyRules.requireBuildings(state, terms.requiredBuildings)
        if (terms.requiredExplorations.any { (id, count) -> (state.progression.routes[id] ?: 0L) < count })
            economyFailure("ECONOMY_EXPLORATION_REQUIRED", "Сначала завершите нужные исследования и заберите находки")
        val nextStep = progress.step + 1
        val completed = nextStep == course.orders.size
        val nextTerms = if (completed) terms else course.orders[nextStep]
        val board = state.residentOrders
        if (terms.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || terms.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val spent = EconomyRules.spend(state, EconomyCost(items = terms.items), command.fishSelection)
        val rewards = if (completed) progress.completionRewards ?: emptyMap() else emptyMap()
        val next = spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + terms.coins),
            inventory = EconomyRules.addItems(spent.inventory, rewards),
            residentOrders = board.copy(completed = board.completed + 1, earnedCoins = board.earnedCoins + terms.coins),
            stageOrders = state.stageOrders.copy(stages = state.stageOrders.stages +
                (home.toString() to progress.copy(step = nextStep, completed = completed, terms = nextTerms,
                    availableAt = if (completed) null else now.plusSeconds(progress.intervalSeconds ?: 0).toString()))))
        EconomyRules.addItems(next.inventory, reservedItems)
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return EconomyItemUnlocks.delivered(next, rewards) to
            if (completed) "Заказы этапа выполнены. Можно улучшить дом" else "Заказ выполнен. На доске появилась следующая просьба"
    }

    /** Take furthest progress in each course without paying or reopening completed requests. */
    fun merge(first: EconomyStageOrderState, second: EconomyStageOrderState): EconomyStageOrderState =
        EconomyStageOrderState(stages = (first.stages.keys + second.stages.keys).associateWith { home ->
            val a = first.stages[home]; val b = second.stages[home]
            when {
                a == null -> checkNotNull(b)
                b == null -> a
                else -> {
                    val chosen = if (a.step != b.step) { if (a.step > b.step) a else b }
                        else if (a.completed != b.completed) { if (a.completed) a else b }
                        else if (a.terms != null || b.terms == null) a else b
                    val deadline = if (a.step == b.step) listOfNotNull(a.availableAt, b.availableAt)
                        .maxByOrNull { Instant.parse(it) } else chosen.availableAt
                    chosen.copy(completed = a.completed || b.completed, availableAt = deadline)
                }
            }
        })
}
