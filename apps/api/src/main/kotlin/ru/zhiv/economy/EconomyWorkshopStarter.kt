package ru.zhiv.economy

/** The legacy loose gift stays retired; the tutorial pays the first build directly. */
object EconomyWorkshopStarter {
    fun cost(catalog: EconomyCatalog = EconomyRules.catalog): EconomyCost =
        catalog.buildings.single { it.id == "workshop" }.levels.single { it.level == 1 }.cost

    fun canClaim(state: EconomyState): Boolean = false

    fun canStartTutorialWorkshop(state: EconomyState): Boolean = !state.workshopStarterClaimed &&
        (state.buildings["workshop"] ?: 0) == 0 &&
        state.jobs.none { it.kind == "construction" && it.targetId == "workshop" }

    fun claim(state: EconomyState, command: EconomyCommand,
        reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        if (command.targetId != "workshop" || command.quantity != 1L || command.totalPrice != 0L) invalidEconomy()
        economyFailure("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", "Материалы первой мастерской нужно собрать самостоятельно")
    }
}
