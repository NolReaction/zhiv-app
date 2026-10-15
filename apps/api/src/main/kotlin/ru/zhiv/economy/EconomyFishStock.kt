package ru.zhiv.economy

/** Species metadata partitions class inventory without adding items or changing rarity costs.
 * Lifetime catches only open the collection and never prove that a fish is still owned. */
object EconomyFishStock {
    data class Entry(val itemId: String, val quantity: Long)
    data class Debit(val fishing: EconomyFishing, val consumed: Map<String, Long>)

    fun normalized(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): Map<String, Long>? {
        val supplied = state.fishing.stock ?: return null
        val classes = EconomyFishInventory.items(state.inventory, catalog).toMutableMap()
        val result = linkedMapOf<String, Long>()
        catalog.fishing?.fish?.forEach { fish ->
            val classId = EconomyFishInventory.itemId(fish.itemId, catalog)
            val requested = supplied[fish.itemId] ?: 0L
            val amount = minOf(requested.takeIf { it in 1L..ECONOMY_MAX_ITEMS } ?: 0L, classes[classId] ?: 0L)
            if (amount > 0L) {
                result[fish.itemId] = amount
                classes[classId] = (classes[classId] ?: 0L) - amount
            }
        }
        return result
    }

    fun entries(state: EconomyState, classId: String, catalog: EconomyCatalog = EconomyRules.catalog): List<Entry> {
        val fishing = catalog.fishing ?: return emptyList()
        if (fishing.classes.none { it.itemId == classId }) return emptyList()
        val stock = normalized(state, catalog).orEmpty()
        val known = fishing.fish.filter { EconomyFishInventory.itemId(it.itemId, catalog) == classId }
            .mapNotNull { fish -> stock[fish.itemId]?.takeIf { it > 0L }?.let { Entry(fish.itemId, it) } }
        val unknown = (EconomyFishInventory.items(state.inventory, catalog)[classId] ?: 0L) - known.sumOf { it.quantity }
        return known + if (unknown > 0L) listOf(Entry(classId, unknown)) else emptyList()
    }

    fun autoFill(state: EconomyState, required: Map<String, Long>, catalog: EconomyCatalog = EconomyRules.catalog): Map<String, Long> {
        val result = linkedMapOf<String, Long>()
        val classes = catalog.fishing?.classes.orEmpty().map { it.itemId }.toSet()
        for ((classId, quantity) in EconomyFishInventory.items(required, catalog)) {
            if (classId !in classes || quantity <= 0L) continue
            var remaining = quantity
            // Stable sorting keeps catalog order when two species have the same stock.
            val options = entries(state, classId, catalog).sortedWith(compareBy<Entry> { if (it.itemId == classId) 0 else 1 }
                .thenByDescending { it.quantity })
            for (entry in options) {
                val amount = minOf(remaining, entry.quantity)
                if (amount > 0L) result[entry.itemId] = amount
                remaining -= amount
            }
        }
        return result
    }

    fun debit(state: EconomyState, required: Map<String, Long>, selection: Map<String, Long>? = null,
        catalog: EconomyCatalog = EconomyRules.catalog): Debit {
        val classes = catalog.fishing?.classes.orEmpty().map { it.itemId }.toSet()
        val costs = EconomyFishInventory.items(required, catalog).filter { it.key in classes && it.value > 0L }
        val chosen = selection ?: autoFill(state, costs, catalog)
        val totals = linkedMapOf<String, Long>()
        val available = costs.keys.flatMap { entries(state, it, catalog) }.associate { it.itemId to it.quantity }
        chosen.forEach { (id, quantity) ->
            val classId = EconomyFishInventory.itemId(id, catalog)
            if (classId !in costs || quantity !in 1L..ECONOMY_MAX_ITEMS || quantity > (available[id] ?: 0L)) changed()
            val old = totals[classId] ?: 0L
            if (quantity > costs.getValue(classId) - old) changed()
            totals[classId] = old + quantity
        }
        if (totals != costs) changed()
        val known = normalized(state, catalog)
        val consumed = chosen.filterKeys { it !in classes }
        val remaining = known?.mapValues { (id, amount) -> amount - (consumed[id] ?: 0L) }?.filterValues { it > 0L }
        return Debit(state.fishing.copy(stock = remaining), consumed)
    }

    /** Call after class goods are credited. Purchases/gifts of class IDs stay unidentified. */
    fun credit(state: EconomyState, species: Map<String, Long>, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val knownIds = catalog.fishing?.fish.orEmpty().map { it.itemId }.toSet()
        val additions = species.filter { it.key in knownIds && it.value in 1L..ECONOMY_MAX_ITEMS }
        if (additions.isEmpty()) return state
        val stock = normalized(state, catalog).orEmpty().toMutableMap()
        additions.forEach { (id, amount) ->
            val old = stock[id] ?: 0L
            if (amount > ECONOMY_MAX_ITEMS - old) economyFailure("ECONOMY_CAPACITY", "Запас этого предмета достиг предела. Сначала освободите место.")
            stock[id] = old + amount
        }
        val next = state.copy(fishing = state.fishing.copy(stock = stock))
        return next.copy(fishing = next.fishing.copy(stock = normalized(next, catalog)))
    }

    fun merge(first: EconomyState, second: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): Map<String, Long>? {
        val a = normalized(first, catalog)
        val b = normalized(second, catalog)
        if (a == null && b == null) return null
        return (a.orEmpty().keys + b.orEmpty().keys).associateWith { id ->
            minOf(ECONOMY_MAX_ITEMS, (a?.get(id) ?: 0L) + (b?.get(id) ?: 0L))
        }
    }

    /** Escrow metadata is bounded by the actual class lot, never by a catch book. */
    fun escrow(state: EconomyState, listingId: String, items: Map<String, Long>,
        catalog: EconomyCatalog = EconomyRules.catalog, legacyItems: Map<String, Long> = emptyMap()): Map<String, Long> {
        // An explicit empty entry is newer proof and must override an old raw item ID.
        val held = state.fishing.escrow?.get(listingId) ?: legacyItems
        return within(held, items, catalog)
    }

    fun within(species: Map<String, Long>, items: Map<String, Long>,
        catalog: EconomyCatalog = EconomyRules.catalog): Map<String, Long> {
        val remaining = EconomyFishInventory.items(items, catalog).toMutableMap()
        val result = linkedMapOf<String, Long>()
        catalog.fishing?.fish?.forEach { fish ->
            val classId = EconomyFishInventory.itemId(fish.itemId, catalog)
            val amount = minOf(species[fish.itemId]?.takeIf { it in 1L..ECONOMY_MAX_ITEMS } ?: 0L, remaining[classId] ?: 0L)
            if (amount > 0L) {
                result[fish.itemId] = amount
                remaining[classId] = (remaining[classId] ?: 0L) - amount
            }
        }
        return result
    }

    fun hold(state: EconomyState, listingId: String, consumed: Map<String, Long>): EconomyState {
        if (consumed.isEmpty()) return state
        return state.copy(fishing = state.fishing.copy(escrow = state.fishing.escrow.orEmpty() + (listingId to consumed)))
    }

    fun release(state: EconomyState, listingId: String): EconomyState {
        val escrow = state.fishing.escrow ?: return state
        return state.copy(fishing = state.fishing.copy(escrow = escrow - listingId))
    }

    private fun changed(): Nothing = economyFailure("ECONOMY_FISH_SELECTION_CHANGED", "Состав рыбы изменился. Выберите рыбу ещё раз")
}
