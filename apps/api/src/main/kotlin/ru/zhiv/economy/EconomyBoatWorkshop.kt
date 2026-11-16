package ru.zhiv.economy

import java.time.Duration
import java.time.Instant

internal object EconomyBoatWorkshop {
    private val config get() = checkNotNull(EconomyRules.catalog.boat)

    fun modules(boat: EconomyBoatState): EconomyBoatModules {
        val saved = boat.modules ?: EconomyBoatModules()
        return saved.copy(
            hull = maxOf(saved.hull, boat.level),
            engine = maxOf(saved.engine, if ("oars" in boat.upgrades) 1 else 0),
            storage = maxOf(saved.storage, if ("crate" in boat.upgrades) 1 else 0),
        )
    }

    private fun capacity(boat: EconomyBoatState): Int = config.moduleEffects.tank[modules(boat).tank]

    /** Recharge is projected from the stored balance and the first pending deadline, without writes on read. */
    fun fuel(boat: EconomyBoatState, now: Instant): EconomyBoatFuel {
        val capacity = capacity(boat)
        val saved = boat.fuel ?: return EconomyBoatFuel(capacity)
        if (saved.cells >= capacity) return EconomyBoatFuel(capacity)
        val interval = config.fuel.regenSeconds
        val next = saved.nextAt?.let(Instant::parse) ?: now.plusSeconds(interval)
        if (now.isBefore(next)) return EconomyBoatFuel(saved.cells, next.toString())
        val gained = 1 + Duration.between(next, now).seconds / interval
        if (gained >= capacity - saved.cells) return EconomyBoatFuel(capacity)
        return EconomyBoatFuel(saved.cells + gained.toInt(), next.plusSeconds(gained * interval).toString())
    }

    fun useCell(boat: EconomyBoatState, now: Instant): EconomyBoatFuel {
        val current = fuel(boat, now)
        check(current.cells > 0)
        return EconomyBoatFuel(current.cells - 1, current.nextAt ?: now.plusSeconds(config.fuel.regenSeconds).toString())
    }

    fun buyCell(state: EconomyState, boat: EconomyBoatState, command: EconomyCommand, now: Instant): Pair<EconomyState, String> {
        if (command.targetId != "fuel_cell" || command.totalPrice != config.fuel.refillPricePearls)
            economyFailure("ECONOMY_BOAT_FUEL_PRICE", "Цена топлива изменилась. Обновите мастерскую")
        if (boat.level == 0 || boat.work != null || boat.voyage != null)
            economyFailure("ECONOMY_BOAT_FUEL", "Заправка доступна у причала, когда бак пуст и лодка готова")
        val fuel = fuel(boat, now)
        if (fuel.cells != 0) economyFailure("ECONOMY_BOAT_FUEL", "Заправка доступна у причала, когда бак пуст и лодка готова")
        if (state.wallet.pearls < config.fuel.refillPricePearls) economyFailure("ECONOMY_PEARLS", "Не хватает жемчуга для заправки")
        val nextFuel = if (capacity(boat) == 1) EconomyBoatFuel(1) else fuel.copy(cells = 1)
        return state.copy(boat = boat.copy(fuel = nextFuel),
            wallet = state.wallet.copy(pearls = state.wallet.pearls - config.fuel.refillPricePearls)) to "В бак добавлена одна ячейка топлива"
    }

    fun install(boat: EconomyBoatState, id: String, now: Instant): EconomyBoatState {
        val upgrade = config.upgrades.single { it.id == id }
        val module = upgrade.module ?: return boat.copy(artifacts = (boat.artifacts + id).distinct(), work = null)
        val levels = modules(boat).install(module, checkNotNull(upgrade.tier))
        val upgraded = boat.copy(work = null, modules = levels,
            level = if (module == "hull") 1 else boat.level,
            upgrades = if (id in setOf("crate", "oars")) (boat.upgrades + id).distinct() else boat.upgrades)
        if (module != "tank") return upgraded
        // Retain a running interval, or start the first new one if the previous tank was full.
        val oldFuel = fuel(boat, now)
        return upgraded.copy(fuel = fuel(upgraded.copy(fuel = oldFuel), now))
    }

    fun mergeFuel(first: EconomyBoatState, second: EconomyBoatState, merged: EconomyBoatState, now: Instant): EconomyBoatFuel? {
        val candidates = listOf(first, second).filter { it.level > 0 }
        if (candidates.isEmpty()) return null
        val best = candidates.map { fuel(it, now) }
            .sortedWith(compareByDescending<EconomyBoatFuel> { it.cells }.thenBy { it.nextAt?.let(Instant::parse) ?: Instant.MAX }).first()
        if (best.cells == capacity(merged)) return null
        return fuel(merged.copy(fuel = best), now)
    }
}
