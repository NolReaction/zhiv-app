package ru.zhiv.economy

import kotlinx.serialization.Serializable

@Serializable data class EconomyOnboardingCatalog(
    val startingWallet: EconomyWallet, val startingItems: Map<String, Long>, val residentOrder: EconomyResidentOrderTemplate,
    val residentOrders: List<EconomyResidentOrderTemplate> = emptyList(),
)
@Serializable data class EconomyTutorialOrder(
    val ingredientsClaimed: Boolean = false, val completed: Boolean = false, val terms: EconomyResidentOrderTemplate? = null,
    val version: Int = 1, val step: Int = 0,
) { init { require(version in 1..2 && step in 0..4) } }

/** Saved v1 requests keep their terms; fresh v2 profiles complete four sequential requests. */
object EconomyTutorialOrders {
    const val ID = "tutorial_first_order"
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
            require(requests.size == 4 && requests.first() == config.residentOrder && requests.map { it.id }.distinct().size == requests.size)
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
            progress.version == 2 && progress.step >= 4 || terms == null || command.targetId != terms.id)
            economyFailure("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ недоступен или уже выполнен")
        val board = state.residentOrders
        if (terms.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || terms.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val spent = EconomyRules.spend(state, EconomyCost(items = terms.items))
        val nextProgress = if (progress.version == 1) progress.copy(completed = true) else {
            val requests = EconomyRules.catalog.onboarding?.let(::orders)
                ?: economyFailure("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебные заказы пока недоступны")
            val nextStep = progress.step + 1
            if (nextStep >= requests.size) progress.copy(step = requests.size, completed = true)
            else progress.copy(step = nextStep, terms = requests[nextStep])
        }
        return spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + terms.coins),
            residentOrders = board.copy(completed = board.completed + 1, earnedCoins = board.earnedCoins + terms.coins),
            tutorialOrder = nextProgress) to if (nextProgress.completed)
            "Учебные заказы выполнены. Можно улучшить дом" else "Учебный заказ выполнен. На доске появилась следующая просьба"
    }

    /** Merging never reopens rewarded progress, including an already accepted legacy request. */
    fun merge(a: EconomyTutorialOrder, b: EconomyTutorialOrder): EconomyTutorialOrder {
        val legacy = listOf(a, b).filter { it.version == 1 && (it.ingredientsClaimed || it.completed) }
        if (legacy.isNotEmpty()) {
            val chosen = legacy.firstOrNull { it.completed } ?: legacy.first()
            return chosen.copy(ingredientsClaimed = true, completed = legacy.any { it.completed },
                terms = chosen.terms ?: legacy.firstNotNullOfOrNull { it.terms })
        }
        if (a.version == 2 || b.version == 2) {
            val current = listOf(a, b).filter { it.version == 2 }
            val chosen = current.maxWith(compareBy<EconomyTutorialOrder> { it.completed }.thenBy { it.step })
            return chosen.copy(ingredientsClaimed = true, completed = current.any { it.completed })
        }
        return a.copy(terms = a.terms ?: b.terms)
    }
}
