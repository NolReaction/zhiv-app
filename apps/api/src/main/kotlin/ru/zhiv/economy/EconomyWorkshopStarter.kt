package ru.zhiv.economy

/** The first workshop's materials are issued once, independently of browser guide progress. */
object EconomyWorkshopStarter {
    fun cost(catalog: EconomyCatalog = EconomyRules.catalog): EconomyCost =
        catalog.buildings.single { it.id == "workshop" }.levels.single { it.level == 1 }.cost

    fun canClaim(state: EconomyState): Boolean = !state.workshopStarterClaimed &&
        (state.buildings["workshop"] ?: 0) == 0 &&
        state.jobs.none { it.kind == "construction" && it.targetId == "workshop" }

    fun claim(state: EconomyState, command: EconomyCommand,
        reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        if (command.targetId != "workshop" || command.quantity != 1L || command.totalPrice != 0L) invalidEconomy()
        if (state.workshopStarterClaimed)
            economyFailure("ECONOMY_WORKSHOP_STARTER_CLAIMED", "Подарок для первой мастерской уже получен")
        if (!canClaim(state))
            economyFailure("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", "Первая мастерская уже построена или строится")
        val reward = cost()
        if (state.wallet.coins !in 0L..ECONOMY_MAX_BALANCE || reward.coins > ECONOMY_MAX_BALANCE - state.wallet.coins)
            economyFailure("ECONOMY_CAPACITY", "Запас монет достиг предела. Сначала потратьте часть монет.")
        val next = state.copy(wallet = state.wallet.copy(coins = state.wallet.coins + reward.coins),
            inventory = EconomyRules.addItems(state.inventory, reward.items))
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return next.copy(workshopStarterClaimed = true) to "Подарок получен: монеты и материалы для первой мастерской в кладовой"
    }
}
