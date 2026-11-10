package ru.zhiv.economy

internal fun boatDockSaleTotal(catches: List<EconomyBoatCatch>, catalog: EconomyCatalog = EconomyRules.catalog): Long? {
    val boat = catalog.boat ?: return null
    val percent = boat.dockSaleBonusPercent ?: return null
    if (catches.isEmpty()) return null
    var total = 0L
    for (fish in catches) {
        val range = boat.weights[fish.fishId] ?: return null
        val classId = EconomyFishInventory.itemId(fish.fishId, catalog)
        val price = catalog.items.find { it.id == classId }?.baseSellPrice ?: return null
        if (price <= 0L) return null
        val span = range.maxGrams - range.minGrams
        val excess = (fish.weightGrams - range.minGrams).coerceIn(0, span)
        total += price + price * percent * excess / (100L * span)
    }
    return total
}
