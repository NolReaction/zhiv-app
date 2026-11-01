package ru.zhiv.economy

import kotlinx.serialization.Serializable
import ru.zhiv.http.parseCanonicalUuidV4
import java.time.Instant
import java.util.UUID

private val shipGroups = listOf("supplies", "provisions", "craft")

@Serializable data class EconomyShipOrderTemplate(
    val id: String, val group: String, val title: String, val requiredHomeLevel: Int,
    val requiredBuildings: Map<String, Int> = emptyMap(), val items: Map<String, Long>,
)

@Serializable data class EconomyShipCatalog(
    val version: Int, val intervalSeconds: Long, val rewardPearls: Long, val payoutBps: Int,
    val rewardValueCoins: Long, val maxRewardPearls: Long,
    val templates: List<EconomyShipOrderTemplate>,
) {
    init {
        require(version == 1 && intervalSeconds in 3600L..86400L && rewardPearls in 1L..40L)
        require(payoutBps in 10000..11000 && templates.size in 3..100)
        require(rewardValueCoins in 1L..ECONOMY_MAX_BALANCE && maxRewardPearls in rewardPearls..40L)
        require(rewardPearls % 2L == 0L && maxRewardPearls % 2L == 0L)
        require(templates.map { it.id }.distinct().size == templates.size)
        require(templates.map { it.group }.toSet() == shipGroups.toSet())
        require(templates.all { it.id.length in 1..60 && it.title.length in 1..120 &&
            it.requiredHomeLevel in 1..5 && it.requiredBuildings.values.all { level -> level in 1..5 } &&
            it.items.size in 1..8 && it.items.keys.all { id -> id.length in 1..80 } && it.items.values.all { count -> count in 1L..ECONOMY_MAX_ITEMS } })
    }
}

@Serializable data class EconomyShipOrder(
    val id: String, val templateId: String, val title: String, val items: Map<String, Long>,
    val rewardCoins: Long, val deliveredAt: String? = null,
) {
    init {
        require(id.length in 1..80 && templateId.length in 1..80 && title.length in 1..120)
        require(items.size in 1..8 && items.keys.all { it.length in 1..80 } && items.values.all { it in 1L..ECONOMY_MAX_ITEMS })
        require(rewardCoins in 1L..ECONOMY_MAX_BALANCE)
        deliveredAt?.let(Instant::parse)
    }
}

@Serializable data class EconomyShipVoyage(
    val id: String, val number: Long, val openedAt: String, val orders: List<EconomyShipOrder>,
    val rewardPearls: Long,
) {
    init {
        require(parseCanonicalUuidV4(id) != null && number in 1L..ECONOMY_MAX_REVISION)
        require(orders.size == 3 && orders.withIndex().all { (index, order) -> order.id == "$id:$index" })
        require(orders.map { it.templateId }.distinct().size == 3)
        require(rewardPearls in 0L..ECONOMY_MAX_PEARLS)
        Instant.parse(openedAt)
    }
}

@Serializable data class EconomyShipState(
    val voyage: EconomyShipVoyage? = null, val completedVoyages: Long = 0, val nextAvailableAt: String? = null,
) {
    init {
        require(completedVoyages in 0L..ECONOMY_MAX_REVISION)
        nextAvailableAt?.let(Instant::parse)
    }
}

/** Account-owned manifests. Every accepted load and the final reward use the ordinary
 * economy transaction/receipt, and never rely on the browser's arrival animation. */
object EconomyShipOrders {
    val config: EconomyShipCatalog by lazy {
        economyJson.decodeFromString<EconomyShipCatalog>(checkNotNull(
            EconomyShipOrders::class.java.getResourceAsStream("/world/ship-orders-catalog.json")
        ).bufferedReader().use { it.readText() })
    }

    fun validateCatalog(catalog: EconomyCatalog, ship: EconomyShipCatalog = config) {
        val byId = catalog.items.associateBy { it.id }
        val fish = catalog.fishing?.let { it.classes.map { tier -> tier.itemId } + it.fish.map { species -> species.itemId } }.orEmpty().toSet() + "fish"
        ship.templates.forEach { template ->
            require(template.requiredBuildings.all { (id, level) -> catalog.buildings.any { building ->
                building.id == id && building.levels.any { it.level == level }
            } })
            require(template.items.keys.all { id -> byId[id]?.let { it.tradable && it.category != "special" && id !in fish } == true })
            rewardCoins(template, catalog, ship)
        }
    }

    fun eligibleTemplates(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog,
        ship: EconomyShipCatalog = config): List<EconomyShipOrderTemplate> {
        val obtainable = EconomyFood.obtainableOrderItems(state, catalog)
        return ship.templates.filter { template -> (state.buildings["home"] ?: 1) >= template.requiredHomeLevel &&
            template.requiredBuildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level } &&
            template.items.keys.all { it in obtainable } }
    }

    private fun cargoValue(template: EconomyShipOrderTemplate, catalog: EconomyCatalog): Long {
        val total = template.items.entries.fold(0L) { total, (id, count) ->
            val item = requireNotNull(catalog.items.find { it.id == id })
            require(maxOf(item.baseSellPrice, catalog.localBuyer.unitPrices[id] ?: 0) <= Long.MAX_VALUE / count)
            val value = EconomyRules.localSellPrice(item.baseSellPrice, count, catalog.localBuyer, id)
            require(value in 0L..ECONOMY_MAX_BALANCE && value <= ECONOMY_MAX_BALANCE - total)
            total + value
        }
        require(total in 1L..ECONOMY_MAX_BALANCE)
        return total
    }

    private fun rewardCoins(template: EconomyShipOrderTemplate, catalog: EconomyCatalog, ship: EconomyShipCatalog): Long {
        val total = cargoValue(template, catalog)
        // Round the whole shipment once, using integers in both implementations.
        val reward = total / 10000 * ship.payoutBps + (total % 10000 * ship.payoutBps + 9999) / 10000
        require(reward in 1L..ECONOMY_MAX_BALANCE)
        return reward
    }

    private fun drawHash(value: String): Long {
        var hash = EconomyFood.hash(value)
        hash = ((hash xor (hash ushr 16)) * 0x85ebca6bL) and 0xffffffffL
        hash = ((hash xor (hash ushr 13)) * 0xc2b2ae35L) and 0xffffffffL
        return (hash xor (hash ushr 16)) and 0xffffffffL
    }

    fun open(state: EconomyState, now: Instant, voyageId: String = UUID.randomUUID().toString(),
        catalog: EconomyCatalog = EconomyRules.catalog, ship: EconomyShipCatalog = config): EconomyState {
        if ((state.buildings["lighthouse"] ?: 0) < 1) economyFailure("ECONOMY_SHIP_LOCKED", "Сначала восстановите и получите маяк")
        if (state.ship.voyage != null) economyFailure("ECONOMY_SHIP_ACTIVE", "Сначала завершите или пропустите текущую поставку")
        if (state.ship.nextAvailableAt?.let { now.isBefore(Instant.parse(it)) } == true)
            economyFailure("ECONOMY_SHIP_WAIT", "Следующие заказы ещё готовятся")
        if (state.ship.completedVoyages >= ECONOMY_MAX_REVISION) economyFailure("ECONOMY_CAPACITY", "Достигнут предел выполненных поставок")
        val eligible = eligibleTemplates(state, catalog, ship)
        var totalCargoValue = 0L
        val orders = shipGroups.mapIndexed { index, group ->
            val pool = eligible.filter { it.group == group }
            if (pool.isEmpty()) economyFailure("ECONOMY_SHIP_UNAVAILABLE", "Для морских заказов нужно открыть больше производств")
            val template = pool[(drawHash("$voyageId:$group") % pool.size).toInt()]
            totalCargoValue += cargoValue(template, catalog)
            EconomyShipOrder("$voyageId:$index", template.id, template.title, template.items.toMap(), rewardCoins(template, catalog, ship))
        }
        val rewardPearls = (((totalCargoValue + ship.rewardValueCoins - 1) / ship.rewardValueCoins) * 2)
            .coerceIn(ship.rewardPearls, ship.maxRewardPearls)
        val voyage = EconomyShipVoyage(voyageId, state.ship.completedVoyages + 1, now.toString(), orders, rewardPearls)
        return state.copy(ship = state.ship.copy(voyage = voyage, nextAvailableAt = now.plusSeconds(ship.intervalSeconds).toString()))
    }

    fun command(state: EconomyState, command: EconomyCommand, now: Instant): Pair<EconomyState, String> {
        if (command.quantity != 1L || command.totalPrice != 0L || command.fishSelection != null) invalidEconomy()
        if ((state.buildings["lighthouse"] ?: 0) < 1) economyFailure("ECONOMY_SHIP_LOCKED", "Сначала восстановите и получите маяк")
        if (command.action == "open_ship_voyage") {
            if (command.targetId != "port") invalidEconomy()
            return open(state, now) to "Капитан подготовил три личных заказа. Они дождутся вас"
        }
        val voyage = state.ship.voyage ?: economyFailure("ECONOMY_SHIP_CHANGED", "Эта поставка уже закрыта. Обновите порт")
        if (command.action == "complete_ship_order") {
            val order = voyage.orders.find { it.id == command.targetId && it.deliveredAt == null }
                ?: economyFailure("ECONOMY_SHIP_CHANGED", "Этот груз уже принят или заказ изменился")
            if (order.rewardCoins > ECONOMY_MAX_BALANCE - state.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
            val spent = EconomyRules.spend(state, EconomyCost(items = order.items))
            val next = spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + order.rewardCoins),
                ship = spent.ship.copy(voyage = voyage.copy(orders = voyage.orders.map {
                    if (it.id == order.id) it.copy(deliveredAt = now.toString()) else it
                })))
            return next to "Груз принят. Монеты получены"
        }
        if (command.targetId != voyage.id) economyFailure("ECONOMY_SHIP_CHANGED", "Эта поставка уже закрыта. Обновите порт")
        return when (command.action) {
            "claim_ship_voyage" -> {
                if (voyage.orders.any { it.deliveredAt == null }) economyFailure("ECONOMY_SHIP_INCOMPLETE", "Сначала отгрузите все три заказа")
                if (voyage.rewardPearls > ECONOMY_MAX_PEARLS - state.wallet.pearls || state.ship.completedVoyages >= ECONOMY_MAX_REVISION)
                    economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
                state.copy(wallet = state.wallet.copy(pearls = state.wallet.pearls + voyage.rewardPearls),
                    ship = state.ship.copy(voyage = null, completedVoyages = state.ship.completedVoyages + 1)) to
                    "Все грузы доставлены. Награда капитана получена"
            }
            "skip_ship_voyage" -> {
                if (voyage.orders.all { it.deliveredAt != null }) economyFailure("ECONOMY_SHIP_COMPLETE", "Все грузы уже приняты. Заберите награду капитана")
                state.copy(ship = state.ship.copy(voyage = null)) to "Поставка закрыта. Монеты за принятые грузы сохранены"
            }
            else -> invalidEconomy()
        }
    }

    /** Never discard a second paid manifest or copy its reward into a new one. */
    fun merge(a: EconomyShipState, b: EconomyShipState): EconomyShipState {
        if (a.voyage != null && b.voyage != null) economyFailure("ACCOUNT_MERGE_CONFLICT", "Завершите или пропустите корабельные заказы в одном из профилей перед объединением")
        val nextAvailableAt = listOfNotNull(a.nextAvailableAt, b.nextAvailableAt).maxByOrNull { Instant.parse(it) }
        return EconomyShipState(a.voyage ?: b.voyage, maxOf(a.completedVoyages, b.completedVoyages), nextAvailableAt)
    }
}
