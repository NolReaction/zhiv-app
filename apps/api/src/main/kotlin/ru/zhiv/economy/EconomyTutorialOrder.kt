package ru.zhiv.economy

import kotlinx.serialization.Serializable

@Serializable data class EconomyOnboardingCatalog(
    val startingWallet: EconomyWallet, val startingItems: Map<String, Long>, val residentOrder: EconomyResidentOrderTemplate,
)
@Serializable data class EconomyTutorialOrder(
    val ingredientsClaimed: Boolean = false, val completed: Boolean = false, val terms: EconomyResidentOrderTemplate? = null,
)

/** One independent request: persistent terms, explicit grant, ordinary spending and one reward. */
object EconomyTutorialOrders {
    const val ID = "tutorial_first_order"
    fun validateCatalog(catalog: EconomyCatalog) {
        catalog.onboarding?.let { config ->
            val known = catalog.items.map { it.id }.toSet()
            require(config.startingWallet.coins in 0L..ECONOMY_MAX_BALANCE && config.startingWallet.pearls in 0L..ECONOMY_MAX_PEARLS)
            require(config.startingItems.all { (id, amount) -> id in known && amount in 1L..ECONOMY_MAX_ITEMS })
            require(config.residentOrder.id == ID && config.residentOrder.residentId in setOf("builder", "plesk"))
            require(config.residentOrder.items.isNotEmpty() && config.residentOrder.items.all { (id, amount) -> id in known && amount in 1L..ECONOMY_MAX_ITEMS })
            require(config.residentOrder.coins in 1L..ECONOMY_MAX_BALANCE)
        }
    }
    fun claim(state: EconomyState, command: EconomyCommand, reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        if (command.targetId != ID || command.quantity != 1L || command.totalPrice != 0L) invalidEconomy()
        if (state.tutorialOrder.ingredientsClaimed || state.tutorialOrder.completed)
            economyFailure("ECONOMY_TUTORIAL_ORDER_CLAIMED", "Ингредиенты учебного заказа уже получены")
        val terms = EconomyRules.catalog.onboarding?.residentOrder
            ?: economyFailure("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ пока недоступен")
        val next = state.copy(inventory = EconomyRules.addItems(state.inventory, terms.items))
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return next.copy(tutorialOrder = EconomyTutorialOrder(ingredientsClaimed = true, terms = terms)) to
            "Ингредиенты учебного заказа получены. Теперь отдай их Шишколапу на доске заказов"
    }
    fun complete(state: EconomyState, command: EconomyCommand): Pair<EconomyState, String> {
        val progress = state.tutorialOrder
        val terms = progress.terms
        if (command.action != "complete_resident_order" || command.targetId != ID || !progress.ingredientsClaimed || progress.completed || terms == null)
            economyFailure("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ недоступен или уже выполнен")
        val board = state.residentOrders
        if (terms.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || terms.coins > ECONOMY_MAX_REVISION - board.earnedCoins || board.completed >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val spent = EconomyRules.spend(state, EconomyCost(items = terms.items))
        return spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + terms.coins),
            residentOrders = board.copy(completed = board.completed + 1, earnedCoins = board.earnedCoins + terms.coins),
            tutorialOrder = progress.copy(completed = true)) to
            "Учебный заказ выполнен. Монеты получены — обычные просьбы жителей работают так же"
    }
    /** Combining accounts never reopens a paid gift or a finished request. */
    fun merge(a: EconomyTutorialOrder, b: EconomyTutorialOrder): EconomyTutorialOrder = EconomyTutorialOrder(
        ingredientsClaimed = a.ingredientsClaimed || b.ingredientsClaimed || a.completed || b.completed,
        completed = a.completed || b.completed,
        terms = if (a.ingredientsClaimed || a.completed) a.terms ?: b.terms else b.terms ?: a.terms,
    )
}
