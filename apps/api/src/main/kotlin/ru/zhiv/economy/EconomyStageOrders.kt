package ru.zhiv.economy

import kotlinx.serialization.Serializable

@Serializable data class EconomyStageOrderCourse(val homeLevel: Int, val orders: List<EconomyResidentOrderTemplate>)
@Serializable data class EconomyStageOrderProgress(
    val step: Int = 0, val completed: Boolean = false, val terms: EconomyResidentOrderTemplate? = null,
) { init { require(step in 0..100) } }
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
            require(course.orders.all { terms -> terms.id.startsWith("stage${course.homeLevel}_") &&
                terms.residentId in setOf("builder", "plesk") && terms.items.isNotEmpty() &&
                terms.items.all { (id, amount) -> id in known && amount in 1L..ECONOMY_MAX_ITEMS } &&
                terms.coins in 1L..ECONOMY_MAX_BALANCE })
        }
    }

    fun isStageId(id: String, catalog: EconomyCatalog = EconomyRules.catalog): Boolean =
        Regex("^stage[234]_").containsMatchIn(id) || catalog.stageOrders.any { course -> course.orders.any { it.id == id } }

    private fun eligible(state: EconomyState, homeLevel: Int): Boolean =
        (state.buildings["home"] ?: 1) == homeLevel && (state.tutorialOrder.version == 1 || state.tutorialOrder.completed)

    fun progress(state: EconomyState, homeLevel: Int = state.buildings["home"] ?: 1): EconomyStageOrderProgress =
        state.stageOrders.stages[homeLevel.toString()] ?: EconomyStageOrderProgress()

    fun required(state: EconomyState, targetHomeLevel: Int, catalog: EconomyCatalog = EconomyRules.catalog): Boolean {
        val home = state.buildings["home"] ?: 1
        return state.tutorialOrder.version == 2 && targetHomeLevel == home + 1 &&
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
    fun pin(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val home = state.buildings["home"] ?: 1
        val terms = offer(state, catalog) ?: return state
        val progress = progress(state, home)
        if (progress.terms != null) return state
        return state.copy(stageOrders = state.stageOrders.copy(stages = state.stageOrders.stages +
            (home.toString() to progress.copy(terms = terms))))
    }

    fun complete(input: EconomyState, command: EconomyCommand): Pair<EconomyState, String> {
        val state = pin(input)
        val terms = offer(state)
        if (command.action != "complete_resident_order" || terms == null || command.targetId != terms.id)
            economyFailure("ECONOMY_STAGE_ORDER_UNAVAILABLE", "Заказ этапа недоступен или уже выполнен")
        val home = state.buildings["home"] ?: 1
        val course = EconomyRules.catalog.stageOrders.single { it.homeLevel == home }
        val progress = progress(state, home)
        val nextStep = progress.step + 1
        val completed = nextStep == course.orders.size
        val nextTerms = if (completed) terms else course.orders[nextStep]
        val board = state.residentOrders
        if (terms.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || terms.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val spent = EconomyRules.spend(state, EconomyCost(items = terms.items))
        return spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + terms.coins),
            residentOrders = board.copy(completed = board.completed + 1, earnedCoins = board.earnedCoins + terms.coins),
            stageOrders = state.stageOrders.copy(stages = state.stageOrders.stages +
                (home.toString() to progress.copy(step = nextStep, completed = completed, terms = nextTerms)))) to
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
                    chosen.copy(completed = a.completed || b.completed)
                }
            }
        })
}
