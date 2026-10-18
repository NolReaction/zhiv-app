package ru.zhiv.admin

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.mail.PlayerMailMessage
import java.time.Instant

/** Both currencies are visible whole units. A visible pearl stores two units. */
@Serializable data class AdminEconomyGrantRequest(
    val requestId: String, val confirmationPublicId: String, val reason: String,
    val coins: Long = 0, val pearls: Long = 0, val items: Map<String, Long> = emptyMap(),
    val buildings: Map<String, Int> = emptyMap(), val productionSlots: Map<String, Int> = emptyMap(),
    val rods: List<String> = emptyList(), val hooks: List<String> = emptyList(),
    val delivery: String = "silent", val playerMessage: PlayerMailMessage? = null,
)
@Serializable data class AdminEconomyGrantReceipt(
    val requestId: String, val publicId: String, val changed: Boolean, val acceptedRevision: Long, val createdAt: String,
)

object AdminEconomyGrants {
    private fun invalid(): Nothing = throw AuthFailure("INVALID_ADMIN_GRANT", "Проверьте состав выдачи: нужны положительные количества и существующие предметы или улучшения.", 400)
    private fun conflict(code: String, message: String): Nothing = throw AuthFailure(code, message, 409)

    fun validate(request: AdminEconomyGrantRequest) {
        validateAdminDelivery(request.delivery, request.playerMessage)
        if (!validAdminReason(request.reason) || request.coins !in 0L..1_000_000_000L || request.pearls !in 0L..1_000_000_000L ||
            request.items.size > 100 || request.items.values.any { it !in 1L..10_000L } || request.items.values.sum() > 10_000L ||
            request.buildings.size > 20 || request.buildings.values.any { it !in 1..10 } ||
            request.productionSlots.size > 20 || request.productionSlots.values.any { it !in 2..3 } ||
            request.rods.size > 30 || request.hooks.size > 30 ||
            request.rods.distinct().size != request.rods.size || request.hooks.distinct().size != request.hooks.size ||
            (request.items.keys + request.buildings.keys + request.productionSlots.keys + request.rods + request.hooks)
                .any { !Regex("^[a-z][a-z0-9_]{0,79}$").matches(it) } ||
            request.coins == 0L && request.pearls == 0L && request.items.isEmpty() && request.buildings.isEmpty() &&
                request.productionSlots.isEmpty() && request.rods.isEmpty() && request.hooks.isEmpty()) invalid()
    }

    /** Never complete, cancel, re-roll or overwrite an in-flight player job. */
    fun apply(state: EconomyState, request: AdminEconomyGrantRequest, now: Instant, reserved: Map<String, Long> = emptyMap()): EconomyState {
        validate(request)
        val catalog = EconomyRules.catalog
        if (request.items.keys.any { id -> catalog.items.none { it.id == id } } ||
            request.rods.any { id -> catalog.fishing?.rods?.none { it.id == id } != false } ||
            request.hooks.any { id -> catalog.fishing?.hooks?.none { it.id == id } != false }) invalid()
        val buildings = state.buildings.toMutableMap()
        for ((id, target) in request.buildings) {
            val definition = catalog.buildings.find { it.id == id } ?: invalid()
            if (definition.levels.none { it.level == target }) invalid()
            val current = buildings[id] ?: 0
            if (target < current) conflict("ADMIN_UPGRADE_DOWNGRADE", "${definition.name}: уровень уже выше выбранного. Обновите карточку игрока.")
            if (target > current) {
                if (state.jobs.any { it.targetId == id && it.kind in setOf("construction", "production") } ||
                    id == "quarry" && state.jobs.any { job -> job.kind == "exploration" && catalog.explorations.any { it.id == job.targetId && "quarry" in it.requiredBuildings } })
                    conflict("ADMIN_UPGRADE_BUSY", "${definition.name}: сначала игрок должен получить результат текущей работы или строительства.")
                buildings[id] = target
            }
        }
        // Validate every skipped level against the complete package, allowing home
        // and its dependent buildings to be awarded together in either map order.
        val home = buildings["home"] ?: 1
        for (id in request.rods.filterNot { it in state.fishing.ownedRods }) {
            val rod = checkNotNull(catalog.fishing).rods.single { it.id == id }
            if (home < rod.requiredHomeLevel)
                conflict("ADMIN_UPGRADE_REQUIREMENTS", "${rod.name}: нужен дом уровня ${rod.requiredHomeLevel}.")
        }
        for (id in request.hooks.filterNot { it in state.fishing.ownedHooks }) {
            val hook = checkNotNull(catalog.fishing).hooks.single { it.id == id }
            if (home < hook.requiredHomeLevel)
                conflict("ADMIN_UPGRADE_REQUIREMENTS", "${hook.name}: нужен дом уровня ${hook.requiredHomeLevel}.")
        }
        for ((id, target) in request.buildings) {
            val definition = catalog.buildings.single { it.id == id }
            for (level in definition.levels.filter { it.level > (state.buildings[id] ?: 0) && it.level <= target }) {
                if (home < level.requiredHomeLevel || level.requiredBuildings.any { (required, value) -> (buildings[required] ?: 0) < value })
                    conflict("ADMIN_UPGRADE_REQUIREMENTS", "${definition.name}: добавьте в пакет необходимые уровни дома и построек.")
            }
        }
        val slots = state.productionSlots.toMutableMap()
        for ((id, target) in request.productionSlots) {
            if (!EconomyRules.productionStationSupported(id)) invalid()
            val offer = catalog.productionSlots.upgrades.find { it.slots == target } ?: invalid()
            val current = EconomyRules.productionSlotCount(state, id)
            if (target < current) conflict("ADMIN_UPGRADE_DOWNGRADE", "У игрока уже больше мест производства. Обновите карточку игрока.")
            if (target > current) {
                if ((buildings[id] ?: 0) < 1 || home < offer.requiredHomeLevel)
                    conflict("ADMIN_UPGRADE_REQUIREMENTS", "Для мест производства нужны построенное здание и дом уровня ${offer.requiredHomeLevel}.")
                if (state.jobs.any { it.kind == "construction" && it.targetId == id })
                    conflict("ADMIN_UPGRADE_BUSY", "Сначала игрок должен получить результат улучшения этой постройки.")
                slots[id] = target
            }
        }
        val pearlUnits = request.pearls * 2L
        if (request.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || pearlUnits > ECONOMY_MAX_PEARLS - state.wallet.pearls)
            conflict("ECONOMY_CAPACITY", "Выдача превышает предельный баланс кошелька. Уменьшите количество валюты.")
        val next = EconomyFishStock.credit(state.copy(
            wallet = state.wallet.copy(coins = state.wallet.coins + request.coins, pearls = state.wallet.pearls + pearlUnits),
            inventory = EconomyRules.addItems(state.inventory, request.items), buildings = buildings, productionSlots = slots,
            fishing = state.fishing.copy(ownedRods = (state.fishing.ownedRods + request.rods).distinct(),
                ownedHooks = (state.fishing.ownedHooks + request.hooks).distinct()),
        ), request.items)
        EconomyRules.assertStorageTransition(state, next, reserved)
        return if (next == state) state else next.copy(residentOrders = EconomyFood.normalizedOrders(state, now))
    }
}
