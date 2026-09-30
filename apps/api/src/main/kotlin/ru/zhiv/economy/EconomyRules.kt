package ru.zhiv.economy

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import java.time.Instant
import kotlin.math.floor
import kotlin.math.sqrt

internal fun economyFailure(code: String, message: String): Nothing = throw AuthFailure(code, message, 409)
internal fun invalidEconomy(): Nothing = throw AuthFailure("INVALID_ECONOMY_COMMAND", "Некорректный запрос хозяйства", 400)

fun validateEconomyCommand(command: EconomyCommand) {
    if (parseCanonicalUuidV4(command.requestId) == null || parsePublicId(command.ownerPublicId) != command.ownerPublicId ||
        command.expectedRevision !in 0L until ECONOMY_MAX_REVISION || command.targetId.length !in 1..80 ||
        command.action.length !in 1..40 || command.quantity !in 1L..10_000L || command.totalPrice !in 0L..ECONOMY_MAX_BALANCE) invalidEconomy()
}

fun decodeEconomyCommand(element: JsonElement): EconomyCommand {
    val value = element as? JsonObject ?: invalidEconomy()
    val fields = setOf("requestId", "ownerPublicId", "expectedRevision", "action", "targetId", "quantity", "totalPrice")
    if (value.keys.any { it !in fields }) invalidEconomy()
    for (field in listOf("requestId", "ownerPublicId", "action", "targetId"))
        if ((value[field] as? JsonPrimitive)?.isString != true) invalidEconomy()
    for (field in listOf("expectedRevision", "quantity", "totalPrice")) {
        val number = value[field] ?: if (field == "expectedRevision") invalidEconomy() else continue
        val primitive = number as? JsonPrimitive ?: invalidEconomy()
        if (primitive.isString || primitive.longOrNull == null) invalidEconomy()
    }
    return try { economyJson.decodeFromJsonElement<EconomyCommand>(value).also(::validateEconomyCommand) }
    catch (_: SerializationException) { invalidEconomy() }
}

object EconomyRules {
    val catalog: EconomyCatalog = economyJson.decodeFromString(
        checkNotNull(EconomyRules::class.java.getResourceAsStream("/world/economy-catalog.json")).bufferedReader().use { it.readText() })

    init {
        require(catalog.version == 1 && catalog.maxBatch in 1..10)
        require(catalog.market.maxListings in 1..10 && catalog.market.maxLotQuantity in 1L..99L &&
            catalog.market.maxPriceMultiplier in 1L..5L && catalog.market.feeBps == 0)
        require(catalog.items.map { it.id }.distinct().size == catalog.items.size)
        require(catalog.buildings.map { it.id }.distinct().size == catalog.buildings.size)
        require(catalog.recipes.map { it.id }.distinct().size == catalog.recipes.size)
    }

    /** Square-root conversion preserves a modest head start without importing beta-scale balances. */
    fun legacyConversion(sparks: Long, wood: Long, stone: Long): EconomyMigration {
        require(listOf(sparks, wood, stone).all { it in 0L..ECONOMY_MAX_REVISION })
        return EconomyMigration(coinsGranted = minOf(500L, floor(2 * sqrt(sparks.toDouble()) + sqrt(wood.toDouble()) + sqrt(stone.toDouble())).toLong()),
            woodGranted = minOf(30L, floor(sqrt(wood.toDouble())).toLong()), stoneGranted = minOf(30L, floor(sqrt(stone.toDouble())).toLong()))
    }

    fun initial(sparks: Long = 0, wood: Long = 0, stone: Long = 0, homeLevel: Int = 1, workshopLevel: Int = 0): EconomyState {
        val grant = legacyConversion(sparks, wood, stone)
        return EconomyState(wallet = EconomyWallet(grant.coinsGranted), inventory = mapOf("wood" to grant.woodGranted, "stone" to grant.stoneGranted).filterValues { it > 0 },
            buildings = mapOf("home" to homeLevel.coerceIn(1, 5), "garden" to 1, "woodlot" to 0, "quarry" to 0,
                "workshop" to workshopLevel.coerceIn(0, 3), "dryer" to 0), migration = grant)
    }

    fun addItems(inventory: Map<String, Long>, amounts: Map<String, Long>): Map<String, Long> {
        val result = inventory.toMutableMap()
        for ((id, quantity) in amounts) {
            val current = result[id] ?: 0
            if (quantity < 0 || current !in 0L..ECONOMY_MAX_BALANCE || quantity > ECONOMY_MAX_BALANCE - current)
                economyFailure("ECONOMY_CAPACITY", "Запас этого предмета достиг предела. Сначала освободите место.")
            result[id] = current + quantity
        }
        return result.filterValues { it > 0 }
    }

    private fun spend(state: EconomyState, cost: EconomyCost): EconomyState {
        if (state.wallet.coins < cost.coins || cost.items.any { (id, quantity) -> (state.inventory[id] ?: 0) < quantity })
            economyFailure("ECONOMY_RESOURCES", "Не хватает монет или материалов. Можно собрать их, произвести или купить на рынке.")
        return state.copy(wallet = state.wallet.copy(coins = state.wallet.coins - cost.coins),
            inventory = state.inventory.mapValues { (id, quantity) -> quantity - (cost.items[id] ?: 0) }.filterValues { it > 0 })
    }

    private fun requireHome(state: EconomyState, level: Int) {
        if ((state.buildings["home"] ?: 1) < level) economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня $level")
    }

    fun apply(state: EconomyState, command: EconomyCommand, now: Instant): Pair<EconomyState, String> {
        validateEconomyCommand(command)
        if (command.totalPrice != 0L) invalidEconomy()
        if (command.action !in setOf("start_production", "sell") && command.quantity != 1L) invalidEconomy()
        return when (command.action) {
            "start_production" -> {
                if (command.quantity > catalog.maxBatch) invalidEconomy()
                val recipe = catalog.recipes.find { it.id == command.targetId } ?: economyFailure("ECONOMY_RECIPE", "Рецепт не найден")
                if ((state.buildings[recipe.buildingId] ?: 0) < recipe.buildingLevel)
                    economyFailure("ECONOMY_BUILDING_REQUIRED", "Сначала постройте или улучшите нужное здание")
                requireHome(state, recipe.requiredHomeLevel)
                if (state.jobs.any { it.targetId == recipe.buildingId && it.kind in setOf("production", "construction") })
                    economyFailure("ECONOMY_BUILDING_BUSY", "Здание занято. Получите готовый результат или дождитесь окончания работ.")
                val cost = EconomyCost(recipe.cost.coins * command.quantity, recipe.cost.items.mapValues { it.value * command.quantity })
                val job = EconomyJob(command.requestId, "production", recipe.buildingId, recipe.id,
                    startedAt = now.toString(), finishesAt = now.plusSeconds(recipe.seconds * command.quantity).toString(),
                    rewards = recipe.rewards.mapValues { it.value * command.quantity }, cost = cost, catalogVersion = catalog.version)
                spend(state, cost).copy(jobs = state.jobs + job) to "Производство началось. Результат дождётся вас."
            }
            "start_exploration" -> {
                val exploration = catalog.explorations.find { it.id == command.targetId } ?: economyFailure("ECONOMY_EXPLORATION", "Место исследования не найдено")
                requireHome(state, exploration.requiredHomeLevel)
                if (state.jobs.any { it.kind == "exploration" }) economyFailure("ECONOMY_EXPLORER_BUSY", "Мохлик уже исследует мир. Сначала получите результат вылазки.")
                val job = EconomyJob(command.requestId, "exploration", exploration.id, startedAt = now.toString(),
                    finishesAt = now.plusSeconds(exploration.seconds).toString(), rewards = exploration.rewards, cost = exploration.cost, catalogVersion = catalog.version)
                spend(state, exploration.cost).copy(jobs = state.jobs + job) to "Мохлик отправился на исследование"
            }
            "start_construction" -> {
                val building = catalog.buildings.find { it.id == command.targetId } ?: economyFailure("ECONOMY_BUILDING", "Здание не найдено")
                val next = (state.buildings[building.id] ?: 0) + 1
                val upgrade = building.levels.find { it.level == next } ?: economyFailure("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены")
                requireHome(state, upgrade.requiredHomeLevel)
                if (state.jobs.any { it.kind == "construction" }) economyFailure("ECONOMY_CONSTRUCTION_BUSY", "Сначала завершите текущую стройку")
                if (state.jobs.any { it.kind == "production" && it.targetId == building.id }) economyFailure("ECONOMY_BUILDING_BUSY", "Получите результат производства перед улучшением")
                val job = EconomyJob(command.requestId, "construction", building.id, targetLevel = next,
                    startedAt = now.toString(), finishesAt = now.plusSeconds(upgrade.seconds).toString(), cost = upgrade.cost, catalogVersion = catalog.version)
                spend(state, upgrade.cost).copy(jobs = state.jobs + job) to "Материалы внесены, строительство началось"
            }
            "claim_job" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (now.isBefore(Instant.parse(job.finishesAt))) economyFailure("ECONOMY_JOB_NOT_READY", "Работа ещё не завершена")
                val buildings = if (job.kind == "construction") state.buildings + (job.targetId to checkNotNull(job.targetLevel)) else state.buildings
                state.copy(inventory = addItems(state.inventory, job.rewards), buildings = buildings, jobs = state.jobs.filterNot { it.id == job.id },
                    completedExplorations = if (job.kind == "exploration") minOf(ECONOMY_MAX_BALANCE, state.completedExplorations + 1) else state.completedExplorations) to
                    if (job.kind == "construction") "Строительство завершено" else "Припасы доставлены на склад"
            }
            "sell" -> {
                val item = catalog.items.find { it.id == command.targetId && it.tradable } ?: economyFailure("ECONOMY_ITEM", "Этот предмет нельзя продать")
                val amount = item.baseSellPrice * command.quantity
                if (amount > ECONOMY_MAX_BALANCE - state.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
                val spent = spend(state, EconomyCost(items = mapOf(item.id to command.quantity)))
                spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + amount)) to "Товары проданы за $amount монет"
            }
            else -> invalidEconomy()
        }
    }
}
