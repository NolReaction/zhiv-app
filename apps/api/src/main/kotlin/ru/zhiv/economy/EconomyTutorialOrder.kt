package ru.zhiv.economy

import kotlinx.serialization.Serializable

@Serializable data class EconomyOnboardingCatalog(
    val startingWallet: EconomyWallet, val startingItems: Map<String, Long>, val residentOrder: EconomyResidentOrderTemplate,
    val residentOrders: List<EconomyResidentOrderTemplate> = emptyList(),
)
@Serializable data class EconomyTutorialOrder(
    val ingredientsClaimed: Boolean = false, val completed: Boolean = false, val terms: EconomyResidentOrderTemplate? = null,
    val version: Int = 1, val step: Int = 0,
    val firstHarvestPrepared: Boolean = false,
) { init { require(version in 1..3 && step in 0..4) } }

/** A single teaching request, followed by the separate first-house course. */
object EconomyTutorialOrders {
    const val ID = "tutorial_first_order"
    val legacyStageIds = setOf("tutorial_wood_order", "tutorial_compote_order", "tutorial_planks_order")

    /** Server-owned aid, consumed by the first successful start, never by local replay. */
    fun canPrepareFirstHarvest(state: EconomyState, recipeId: String, quantity: Long): Boolean {
        val progress = normalize(state).tutorialOrder
        return recipeId == "grow_berries" && quantity == 1L && progress.version == 3 && progress.ingredientsClaimed &&
            !progress.completed && progress.step == 0 && !progress.firstHarvestPrepared &&
            progress.terms?.id == ID && progress.terms.items == mapOf("berries" to 1L) &&
            state.buildings["home"] == 1 && (state.inventory["berries"] ?: 0L) == 0L &&
            (state.progression.recipes["grow_berries"] ?: 0L) == 0L &&
            state.jobs.none { it.kind == "production" && it.targetId == "garden" }
    }

    /** Read projection only; the next successful mutation persists it without another payout. */
    fun normalize(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val previous = state.tutorialOrder
        if (previous.version != 2) return state
        if (previous.step == 0 && !previous.completed) {
            val terms = previous.terms ?: catalog.onboarding?.residentOrder
            val reduced = if (terms?.id == ID && terms.items == mapOf("berries" to 2L))
                terms.copy(description = terms.description?.replace("две малины", "одну малину"), items = mapOf("berries" to 1L)) else terms
            return state.copy(tutorialOrder = previous.copy(version = 3, terms = reduced))
        }
        val course = catalog.stageOrders.find { it.homeLevel == 1 }
        val completed = previous.completed || previous.step >= 4
        val step = if (completed) course?.orders?.size ?: 3 else maxOf(0, previous.step - 1)
        val saved = state.stageOrders.stages["1"] ?: EconomyStageOrderProgress()
        val projected = saved.copy(step = step, completed = completed,
            terms = previous.terms ?: course?.orders?.getOrNull(step),
            availableAt = if (completed) null else saved.availableAt ?: "1970-01-01T00:00:00.000Z",
            intervalSeconds = saved.intervalSeconds ?: course?.intervalSeconds ?: 0,
            completionRewards = saved.completionRewards ?: course?.completionRewards ?: emptyMap())
        val stages = if (!saved.completed && (step > saved.step || step == saved.step && saved.terms == null || completed))
            state.stageOrders.copy(stages = state.stageOrders.stages + ("1" to projected)) else state.stageOrders
        return state.copy(tutorialOrder = previous.copy(version = 3, step = 1, completed = true,
            terms = catalog.onboarding?.residentOrder), stageOrders = stages)
    }
    fun orders(config: EconomyOnboardingCatalog): List<EconomyResidentOrderTemplate> =
        config.residentOrders.ifEmpty { listOf(config.residentOrder) }
    fun isTutorialId(id: String): Boolean = id == ID ||
        EconomyRules.catalog.onboarding?.residentOrders?.any { it.id == id } == true

    fun validateCatalog(catalog: EconomyCatalog) {
        catalog.onboarding?.let { config ->
            val known = catalog.items.map { it.id }.toSet()
            require(config.startingWallet.coins in 0L..ECONOMY_MAX_BALANCE && config.startingWallet.pearls in 0L..ECONOMY_MAX_PEARLS)
            require(config.startingItems.all { (id, amount) -> id in known && amount in 1L..ECONOMY_MAX_ITEMS })
            require(config.residentOrder.id == ID)
            val requests = orders(config)
            require(requests.size == 1 && requests.first() == config.residentOrder && requests.map { it.id }.distinct().size == requests.size)
            require(requests.all { terms -> terms.id.startsWith("tutorial_") && terms.residentId in setOf("builder", "plesk") &&
                terms.items.isNotEmpty() && terms.items.all { (id, amount) -> id in known && amount in 1L..ECONOMY_MAX_ITEMS } &&
                terms.coins in 1L..ECONOMY_MAX_BALANCE })
        }
    }

    /** Compatibility command only accepts legacy terms; acquiring goods is ordinary gameplay. */
    fun claim(state: EconomyState, command: EconomyCommand, reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        if (command.targetId != ID || command.quantity != 1L || command.totalPrice != 0L) invalidEconomy()
        val progress = state.tutorialOrder
        if (progress.ingredientsClaimed || progress.completed)
            economyFailure("ECONOMY_TUTORIAL_ORDER_CLAIMED", "Учебный заказ уже принят")
        val terms = progress.terms ?: EconomyRules.catalog.onboarding?.residentOrder
            ?: economyFailure("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ пока недоступен")
        return state.copy(tutorialOrder = progress.copy(ingredientsClaimed = true, terms = terms)) to
            "Учебный заказ принят. Соберите припасы и отнесите их на доску заказов"
    }

    fun complete(state: EconomyState, command: EconomyCommand): Pair<EconomyState, String> {
        val progress = state.tutorialOrder
        val terms = progress.terms
        if (command.action != "complete_resident_order" || !progress.ingredientsClaimed || progress.completed ||
            progress.version == 3 && progress.step >= 1 || terms == null || command.targetId != terms.id)
            economyFailure("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ недоступен или уже выполнен")
        val board = state.residentOrders
        if (terms.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || terms.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val spent = EconomyRules.spend(state, EconomyCost(items = terms.items), command.fishSelection)
        val nextProgress = progress.copy(step = if (progress.version == 1) progress.step else 1, completed = true)
        return spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + terms.coins),
            residentOrders = board.copy(completed = board.completed + 1, earnedCoins = board.earnedCoins + terms.coins),
            tutorialOrder = nextProgress) to "Первый заказ выполнен. Теперь доступны просьбы для улучшения дома"
    }

    /** Merging never reopens rewarded progress, including an already accepted legacy request. */
    fun merge(a: EconomyTutorialOrder, b: EconomyTutorialOrder): EconomyTutorialOrder {
        val firstHarvestPrepared = a.firstHarvestPrepared || b.firstHarvestPrepared
        val legacy = listOf(a, b).filter { it.version == 1 && (it.ingredientsClaimed || it.completed) }
        if (legacy.isNotEmpty()) {
            val chosen = legacy.firstOrNull { it.completed } ?: legacy.first()
            return chosen.copy(ingredientsClaimed = true, completed = legacy.any { it.completed },
                firstHarvestPrepared = firstHarvestPrepared,
                terms = chosen.terms ?: legacy.firstNotNullOfOrNull { it.terms })
        }
        if (a.version >= 2 || b.version >= 2) {
            val current = listOf(a, b).filter { it.version >= 2 }
            val chosen = current.maxWith(compareBy<EconomyTutorialOrder> { it.completed }.thenBy { it.step })
            return chosen.copy(ingredientsClaimed = true, completed = current.any { it.completed }, firstHarvestPrepared = firstHarvestPrepared)
        }
        return a.copy(terms = a.terms ?: b.terms, firstHarvestPrepared = firstHarvestPrepared)
    }
}
