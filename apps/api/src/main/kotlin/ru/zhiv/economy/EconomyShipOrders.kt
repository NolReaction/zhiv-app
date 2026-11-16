package ru.zhiv.economy

import kotlinx.serialization.Serializable
import ru.zhiv.http.parseCanonicalUuidV4
import java.time.Instant
import java.util.UUID

private val shipGroups = listOf("supplies", "provisions", "craft")
private val shipDifficulties = listOf("easy", "medium", "hard")
// The wallet stores half-pearl units; 20 units are 10 displayed pearls.
private const val shipCompletionPearls = 20L

@Serializable data class EconomyShipOrderTemplate(
    val id: String, val group: String, val title: String, val requiredHomeLevel: Int,
    val requiredBuildings: Map<String, Int> = emptyMap(), val items: Map<String, Long>,
    val difficulty: String = "medium", val rewardItems: Map<String, Long> = emptyMap(),
)

@Serializable data class EconomyShipCatalog(
    val version: Int, val intervalSeconds: Long, val rewardPearls: Long, val payoutBps: Int,
    val rewardValueCoins: Long, val maxRewardPearls: Long,
    val templates: List<EconomyShipOrderTemplate>,
    val staySeconds: Long = 86400, val resetPricePearls: Long = 20, val freeReplacements: Int = 3,
) {
    init {
        require(staySeconds in 3600L..172800L && resetPricePearls in 1L..1000L && freeReplacements == 3)
        require(version == 1 && intervalSeconds in 3600L..86400L && rewardPearls in 1L..40L)
        require(payoutBps in 10000..11000 && templates.size in 3..100)
        require(rewardValueCoins in 1L..ECONOMY_MAX_BALANCE && maxRewardPearls in rewardPearls..40L)
        require(rewardPearls % 2L == 0L && maxRewardPearls % 2L == 0L)
        require(templates.map { it.id }.distinct().size == templates.size)
        require(templates.map { it.group }.toSet() == shipGroups.toSet())
        require(templates.map { it.difficulty }.toSet() == shipDifficulties.toSet())
        require(templates.all { it.rewardItems.size <= 8 && it.rewardItems.keys.all { id -> id.length in 1..80 } && it.rewardItems.values.all { count -> count in 1L..ECONOMY_MAX_ITEMS } })
        require(templates.all { it.id.length in 1..60 && it.title.length in 1..120 &&
            it.requiredHomeLevel in 1..5 && it.requiredBuildings.values.all { level -> level in 1..5 } &&
            it.items.size in 1..8 && it.items.keys.all { id -> id.length in 1..80 } && it.items.values.all { count -> count in 1L..ECONOMY_MAX_ITEMS } })
    }
}

@Serializable data class EconomyShipOrder(
    val id: String, val templateId: String, val title: String, val items: Map<String, Long>,
    val rewardCoins: Long, val deliveredAt: String? = null,
    val loadedItems: Map<String, Long> = if (deliveredAt != null) items else emptyMap(), val difficulty: String = "medium",
    val rewardItems: Map<String, Long> = emptyMap(), val revision: Int = 0,
) {
    init {
        require(revision in 0..3)
        require(id.length in 1..80 && templateId.length in 1..80 && title.length in 1..120)
        require(items.size in 1..8 && items.keys.all { it.length in 1..80 } && items.values.all { it in 1L..ECONOMY_MAX_ITEMS })
        require(rewardCoins in 1L..ECONOMY_MAX_BALANCE)
        require(difficulty in shipDifficulties)
        require(loadedItems.all { (id, count) -> id in items && count in 1L..items.getValue(id) })
        require(rewardItems.size <= 8 && rewardItems.keys.all { it.length in 1..80 } && rewardItems.values.all { it in 1L..ECONOMY_MAX_ITEMS })
        deliveredAt?.let(Instant::parse)
    }
}

@Serializable data class EconomyShipVoyage(
    val id: String, val number: Long, val openedAt: String, val orders: List<EconomyShipOrder>,
    val rewardPearls: Long, val replacementsUsed: Int = 0,
) {
    init {
        require(parseCanonicalUuidV4(id) != null && number in 1L..ECONOMY_MAX_REVISION)
        require(replacementsUsed in 0..3)
        require(orders.size == 3 && orders.withIndex().all { (index, order) -> order.id == "$id:$index" + (if (order.revision > 0) ":r${order.revision}" else "") })
        require(orders.map { it.templateId }.distinct().size == 3)
        require(rewardPearls in 0L..ECONOMY_MAX_PEARLS)
        Instant.parse(openedAt)
    }
}

@Serializable data class EconomyShipState(
    val voyage: EconomyShipVoyage? = null, val completedVoyages: Long = 0, val nextAvailableAt: String? = null,
    val resetAvailableAt: String? = null, val departureCargo: List<Double>? = null,
    val nextVoyage: EconomyShipVoyage? = null,
) {
    init {
        require(completedVoyages in 0L..ECONOMY_MAX_REVISION)
        nextAvailableAt?.let(Instant::parse)
        resetAvailableAt?.let(Instant::parse)
        require(departureCargo == null || departureCargo.size == 3 && departureCargo.all { it.isFinite() && it in 0.0..1.0 })
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
            require(template.rewardItems.keys.all { id -> byId[id]?.let { it.tradable && it.category != "special" && id !in fish } == true })
            rewardCoins(template, catalog, ship)
        }
    }

    fun eligibleTemplates(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog,
        ship: EconomyShipCatalog = config): List<EconomyShipOrderTemplate> {
        val obtainable = EconomyFood.obtainableOrderItems(state, catalog)
        return ship.templates.filter { template -> (state.buildings["home"] ?: 1) >= template.requiredHomeLevel &&
            template.requiredBuildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level } &&
            template.items.keys.all { it in obtainable } && template.rewardItems.keys.all { it in obtainable } }
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

    fun departureAt(voyage: EconomyShipVoyage): Instant = Instant.parse(voyage.openedAt).plusSeconds(config.staySeconds)

    fun cargoFractions(voyage: EconomyShipVoyage): List<Double> = voyage.orders.map { order ->
        val total = order.items.values.sum()
        if (total == 0L) 0.0 else order.items.entries.sumOf { (id, count) ->
            if (order.deliveredAt != null) count else minOf(count, order.loadedItems[id] ?: 0L)
        }.toDouble() / total
    }

    /** Server reads and commands use the same deadline, even after an offline week. */
    fun project(ship: EconomyShipState, now: Instant): EconomyShipState {
        val voyage = ship.voyage ?: return ship
        if (now.isBefore(departureAt(voyage)) || voyage.orders.all { it.deliveredAt != null }) return ship
        return ship.copy(voyage = null, departureCargo = cargoFractions(voyage),
            nextAvailableAt = departureAt(voyage).plusSeconds(config.intervalSeconds).toString())
    }

    private fun replacement(state: EconomyState, voyage: EconomyShipVoyage, order: EconomyShipOrder): EconomyShipOrder? {
        val revision = voyage.replacementsUsed + 1
        val pool = eligibleTemplates(state).filter { it.difficulty == order.difficulty && voyage.orders.none { other -> other.templateId == it.id } }
        if (pool.isEmpty()) return null
        val template = pool[(drawHash("${voyage.id}:${order.id}:replacement:$revision") % pool.size).toInt()]
        val index = voyage.orders.indexOfFirst { it.id == order.id }
        return EconomyShipOrder("${voyage.id}:$index:r$revision", template.id, template.title, template.items.toMap(),
            rewardCoins(template, EconomyRules.catalog, config), difficulty = template.difficulty,
            rewardItems = template.rewardItems.toMap(), revision = revision)
    }

    fun open(input: EconomyState, now: Instant, voyageId: String = UUID.randomUUID().toString(),
        catalog: EconomyCatalog = EconomyRules.catalog, ship: EconomyShipCatalog = config): EconomyState {
        val state = input.copy(ship = project(input.ship, now))
        if ((state.buildings["lighthouse"] ?: 0) < 1) economyFailure("ECONOMY_SHIP_LOCKED", "Сначала восстановите и получите маяк")
        if (state.ship.voyage != null) economyFailure("ECONOMY_SHIP_ACTIVE", "Сначала загрузите текущую поставку")
        if (state.ship.nextAvailableAt?.let { now.isBefore(Instant.parse(it)) } == true)
            economyFailure("ECONOMY_SHIP_WAIT", "Следующие заказы ещё готовятся")
        if (state.ship.completedVoyages >= ECONOMY_MAX_REVISION) economyFailure("ECONOMY_CAPACITY", "Достигнут предел выполненных поставок")
        state.ship.nextVoyage?.let { forecast ->
            return state.copy(ship = state.ship.copy(voyage = forecast.copy(openedAt = now.toString(),
                number = state.ship.completedVoyages + 1), nextVoyage = null, nextAvailableAt = null, departureCargo = null))
        }
        val eligible = eligibleTemplates(state, catalog, ship)
        val orders = shipDifficulties.mapIndexed { index, difficulty ->
            val pool = eligible.filter { it.difficulty == difficulty }
            if (pool.isEmpty()) economyFailure("ECONOMY_SHIP_UNAVAILABLE", "Для морских заказов нужно открыть больше производств")
            val template = pool[(drawHash("$voyageId:$difficulty") % pool.size).toInt()]
            EconomyShipOrder("$voyageId:$index", template.id, template.title, template.items.toMap(), rewardCoins(template, catalog, ship),
                difficulty = template.difficulty, rewardItems = template.rewardItems.toMap())
        }
        val voyage = EconomyShipVoyage(voyageId, state.ship.completedVoyages + 1, now.toString(), orders, shipCompletionPearls)
        return state.copy(ship = state.ship.copy(voyage = voyage, nextAvailableAt = null, departureCargo = null))
    }

    /** The crafted telescope pins the next manifest; later reads cannot reroll it. */
    fun inspect(input: EconomyState, command: EconomyCommand, now: Instant): Pair<EconomyState, String> {
        if (command.targetId != "port" || command.quantity != 1L || command.totalPrice != 0L || command.fishSelection != null)
            invalidEconomy()
        if ("telescope" !in input.boat?.artifacts.orEmpty())
            economyFailure("ECONOMY_TELESCOPE_LOCKED", "Сначала соберите подзорную трубу по чертежу")
        if ((input.buildings["lighthouse"] ?: 0) < 1)
            economyFailure("ECONOMY_SHIP_LOCKED", "Сначала восстановите и получите маяк")
        val ship = project(input.ship, now)
        if (ship.nextVoyage != null) return input.copy(ship = ship) to "Будущий груз уже записан"
        val prepared = open(input.copy(ship = ship.copy(voyage = null, nextAvailableAt = null)), now).ship.voyage!!
        return input.copy(ship = ship.copy(nextVoyage = prepared)) to "Будущий груз записан. Можно готовить товары заранее"
    }

    private fun finishVoyage(state: EconomyState, now: Instant): EconomyState {
        if (shipCompletionPearls > ECONOMY_MAX_PEARLS - state.wallet.pearls || state.ship.completedVoyages >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
        return state.copy(wallet = state.wallet.copy(pearls = state.wallet.pearls + shipCompletionPearls),
            ship = state.ship.copy(voyage = null, completedVoyages = state.ship.completedVoyages + 1,
                nextAvailableAt = now.plusSeconds(config.intervalSeconds).toString(), departureCargo = listOf(1.0, 1.0, 1.0)))
    }

    fun command(input: EconomyState, command: EconomyCommand, now: Instant,
        reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        val state = input.copy(ship = project(input.ship, now))
        if (command.action != "skip_ship_voyage" && command.totalPrice != 0L || command.fishSelection != null ||
            command.action != "load_ship_cargo" && command.quantity != 1L) invalidEconomy()
        if ((state.buildings["lighthouse"] ?: 0) < 1) economyFailure("ECONOMY_SHIP_LOCKED", "Сначала восстановите и получите маяк")
        if (command.action == "expire_ship_voyage") {
            if (input.ship.voyage?.id != command.targetId || state.ship.voyage != null)
                economyFailure("ECONOMY_SHIP_CHANGED", "Срок этой поставки ещё не истёк или корабль уже отправился")
            return state to "Корабль отправился. Следующий рейс через 6 часов после отхода"
        }
        if (command.action == "open_ship_voyage") {
            if (command.targetId != "port") invalidEconomy()
            return open(state, now) to "Корабль прибыл с тремя заказами"
        }
        val voyage = state.ship.voyage ?: economyFailure("ECONOMY_SHIP_CHANGED", "Корабль уже отправился. Обновите заказы")
        if (now.isBefore(Instant.parse(voyage.openedAt))) economyFailure("ECONOMY_SHIP_WAIT", "Дождитесь прибытия корабля")
        if (command.action == "skip_ship_voyage") {
            if (command.targetId != voyage.id) economyFailure("ECONOMY_SHIP_CHANGED", "Корабль уже отправился")
            if (state.ship.resetAvailableAt?.let { now.isBefore(Instant.parse(it)) } == true)
                economyFailure("ECONOMY_SHIP_WAIT", "Досрочная отправка ещё недоступна")
            if (voyage.orders.all { it.deliveredAt != null }) economyFailure("ECONOMY_SHIP_CHANGED", "Все грузы уже приняты. Дождитесь награды")
            if (command.totalPrice != config.resetPricePearls) economyFailure("ECONOMY_SHIP_PRICE_CHANGED", "Цена отправки изменилась. Подтвердите её снова")
            if (state.wallet.pearls < config.resetPricePearls) economyFailure("ECONOMY_PEARLS", "Не хватает жемчуга для отправки")
            val nextAt = now.plusSeconds(config.intervalSeconds).toString()
            return state.copy(wallet = state.wallet.copy(pearls = state.wallet.pearls - config.resetPricePearls),
                ship = state.ship.copy(voyage = null, nextAvailableAt = nextAt, resetAvailableAt = nextAt,
                    departureCargo = cargoFractions(voyage))) to "Корабль отправлен. Новый рейс прибудет через 6 часов"
        }
        if (command.action == "replace_ship_order") {
            val order = voyage.orders.find { it.id == command.targetId && it.deliveredAt == null }
                ?: economyFailure("ECONOMY_SHIP_CHANGED", "Этот груз уже принят или корабль отправился")
            if (order.loadedItems.values.any { it > 0 }) economyFailure("ECONOMY_SHIP_CARGO_STARTED", "Можно заменить только груз, который ещё не начали загружать")
            if (voyage.replacementsUsed >= config.freeReplacements) economyFailure("ECONOMY_SHIP_REPLACEMENTS", "Бесплатные замены в этом рейсе закончились")
            val updated = replacement(state, voyage, order) ?: economyFailure("ECONOMY_SHIP_UNAVAILABLE", "Других доступных грузов этой сложности пока нет")
            return state.copy(ship = state.ship.copy(voyage = voyage.copy(replacementsUsed = voyage.replacementsUsed + 1,
                orders = voyage.orders.map { if (it.id == order.id) updated else it }))) to "Заказ заменён. Срок стоянки корабля сохранён"
        }
        if (command.action == "load_ship_cargo" || command.action == "complete_ship_order") {
            if (command.action == "load_ship_cargo" && command.voyageId != voyage.id)
                economyFailure("ECONOMY_SHIP_CHANGED", "Эта поставка уже закрыта")
            val order = voyage.orders.find { it.id == command.targetId && it.deliveredAt == null }
                ?: economyFailure("ECONOMY_SHIP_CHANGED", "Этот груз уже принят или заказ изменился")
            val remaining = order.items.mapValues { (id, count) -> count - (order.loadedItems[id] ?: 0L) }.filterValues { it > 0L }
            val cargo = if (command.action == "load_ship_cargo") {
                val id = command.itemId ?: invalidEconomy()
                if (id !in order.items || command.quantity !in 1L..(remaining[id] ?: 0L)) invalidEconomy()
                mapOf(id to command.quantity)
            } else remaining
            if (cargo.isEmpty()) economyFailure("ECONOMY_SHIP_CHANGED", "Этот груз уже загружен")
            val spent = EconomyRules.spend(state, EconomyCost(items = cargo))
            val loaded = order.loadedItems.toMutableMap().also { target -> cargo.forEach { (id, count) -> target[id] = (target[id] ?: 0L) + count } }
            val complete = order.items.all { (id, count) -> (loaded[id] ?: 0L) == count }
            val updated = order.copy(loadedItems = loaded, deliveredAt = if (complete) now.toString() else null)
            var next = spent.copy(ship = spent.ship.copy(nextAvailableAt = null, voyage = voyage.copy(rewardPearls = shipCompletionPearls,
                orders = voyage.orders.map { if (it.id == order.id) updated else it })))
            if (complete) {
                if (order.rewardCoins > ECONOMY_MAX_BALANCE - next.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
                next = EconomyItemUnlocks.delivered(next.copy(wallet = next.wallet.copy(coins = next.wallet.coins + order.rewardCoins),
                    inventory = EconomyRules.addItems(next.inventory, order.rewardItems)), order.rewardItems)
                EconomyRules.assertStorageTransition(state, next, reservedItems)
                if (next.ship.voyage!!.orders.all { it.deliveredAt != null })
                    return finishVoyage(next, now) to "Все грузы загружены. Получено 10 жемчужин. Корабль отправляется"
            }
            return next to if (complete) "Груз загружен. Награда получена" else "Товар загружен на корабль"
        }
        if (command.targetId != voyage.id) economyFailure("ECONOMY_SHIP_CHANGED", "Эта поставка уже закрыта")
        if (command.action != "claim_ship_voyage") invalidEconomy()
        // Compatibility for manifests fully loaded before automatic departure was introduced.
        if (voyage.orders.any { it.deliveredAt == null }) economyFailure("ECONOMY_SHIP_INCOMPLETE", "Сначала загрузите все три заказа")
        return finishVoyage(state, now) to "Все грузы загружены. Получено 10 жемчужин. Корабль отправляется"
    }

    /** Never discard a second paid manifest or copy its reward into a new one. */
    fun merge(a: EconomyShipState, b: EconomyShipState): EconomyShipState {
        if (a.voyage != null && b.voyage != null) economyFailure("ACCOUNT_MERGE_CONFLICT", "Завершите корабельные заказы в одном из профилей перед объединением")
        val nextAvailableAt = listOfNotNull(a.nextAvailableAt, b.nextAvailableAt).maxByOrNull { Instant.parse(it) }
        val resetAt = listOfNotNull(a.resetAvailableAt, b.resetAvailableAt).maxByOrNull { Instant.parse(it) }
        val cargo = if (nextAvailableAt == a.nextAvailableAt) a.departureCargo else b.departureCargo
        if (a.nextVoyage != null && b.nextVoyage != null)
            economyFailure("ACCOUNT_MERGE_CONFLICT", "Дождитесь одного из записанных корабельных грузов перед объединением")
        return EconomyShipState(a.voyage ?: b.voyage, maxOf(a.completedVoyages, b.completedVoyages), nextAvailableAt, resetAt, cargo,
            a.nextVoyage ?: b.nextVoyage)
    }
}
