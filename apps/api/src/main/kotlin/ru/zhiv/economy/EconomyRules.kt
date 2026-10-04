package ru.zhiv.economy

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import java.time.Instant
import java.time.Duration
import java.util.UUID
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
        require(catalog.version == 2 && catalog.maxBatch in 1..10)
        require(catalog.constructionSpeedup.secondsPerPearl in 1L..86_400L)
        require(catalog.market.maxListings in 1..10 && catalog.market.maxLotQuantity in 1L..99L &&
            catalog.market.maxPriceMultiplier in 1L..5L && catalog.market.feeBps == 0)
        require(catalog.items.map { it.id }.distinct().size == catalog.items.size)
        require(catalog.buildings.map { it.id }.distinct().size == catalog.buildings.size)
        require(catalog.recipes.map { it.id }.distinct().size == catalog.recipes.size)
        catalog.fishing?.let { fishing ->
            require(fishing.routeIds.isNotEmpty() && fishing.routeIds.all { id -> catalog.explorations.any { it.id == id && (it.rewards["fish"] ?: 0) > 0 } })
            require(fishing.fish.isNotEmpty() && fishing.fish.map { it.itemId }.distinct().size == fishing.fish.size)
            require(fishing.fish.all { fish -> fish.weight in 1..1000 && fish.affinity in 0..10 && fish.rarity in setOf("common", "uncommon", "rare") &&
                catalog.items.any { it.id == fish.itemId && it.baseSellPrice < fish.buyPrice } })
            require(fishing.rods.map { it.id }.distinct().size == fishing.rods.size && fishing.rods.any { it.id == "reed_rod" && it.price == 0L })
            require(fishing.rods.all { it.price in 0..ECONOMY_MAX_BALANCE && it.rareBonus in 0..100 })
            require(fishing.baits.map { it.itemId }.distinct().size == fishing.baits.size && fishing.baits.all { bait ->
                bait.price in 1..ECONOMY_MAX_BALANCE && bait.rareBonus in 0..100 && catalog.items.any { it.id == bait.itemId && it.baseSellPrice < bait.price } })
        }
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
                "workshop" to workshopLevel.coerceIn(0, 3), "dryer" to 0, "warehouse" to 1, "kiln" to 0), migration = grant)
    }

    /** Escrow keeps its space until sold, so putting goods on the market cannot expand the warehouse. */
    fun storage(state: EconomyState, reservedItems: Map<String, Long> = emptyMap()): EconomyStorage {
        val warehouseLevel = state.buildings["warehouse"] ?: 1
        val capacity = checkNotNull(catalog.buildings.single { it.id == "warehouse" }.levels
            .single { it.level == warehouseLevel }.warehouseCapacity)
        val used = state.inventory.values.sum()
        val reserved = reservedItems.values.sum()
        val total = used + reserved
        return EconomyStorage(capacity, used, reserved, maxOf(0L, capacity - total), maxOf(0L, total - capacity))
    }

    /** Imported overfull stocks are preserved. Spending or returning an existing escrow is always possible. */
    fun assertStorageTransition(
        before: EconomyState, next: EconomyState,
        reservedBefore: Map<String, Long> = emptyMap(), reservedAfter: Map<String, Long> = reservedBefore,
    ) {
        val previous = storage(before, reservedBefore)
        val result = storage(next, reservedAfter)
        if (result.overflow > 0 && result.used + result.reserved > previous.used + previous.reserved)
            economyFailure("ECONOMY_STORAGE_FULL", "На складе недостаточно места. Продайте припасы или расширьте склад; готовая работа дождётся вас.")
    }

    private fun requireRewardCapacity(state: EconomyState, rewards: Map<String, Long>) {
        if (rewards.values.sum() > storage(state).capacity)
            economyFailure("ECONOMY_STORAGE_FULL", "Вся партия не поместится на складе. Уменьшите её или сначала расширьте склад.")
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

    private fun requireBuildings(state: EconomyState, requiredBuildings: Map<String, Int>) {
        val unmet = requiredBuildings.filter { (id, level) -> (state.buildings[id] ?: 0) < level }
        if (unmet.isNotEmpty()) {
            val description = unmet.entries.joinToString(", ") { (id, level) ->
                "${catalog.buildings.single { it.id == id }.name}: уровень $level"
            }
            economyFailure("ECONOMY_BUILDING_REQUIRED", "Сначала завершите улучшения: $description")
        }
    }

    /** Started billing intervals, including a fractional final second, cost one pearl each. */
    fun constructionSpeedupPrice(job: EconomyJob, now: Instant): Long {
        if (job.kind != "construction") return 0
        val remaining = Duration.between(now, Instant.parse(job.finishesAt))
        if (remaining.isNegative || remaining.isZero) return 0
        val interval = catalog.constructionSpeedup.secondsPerPearl
        return remaining.seconds / interval + if (remaining.seconds % interval != 0L || remaining.nano > 0) 1 else 0
    }

    /** FNV-1a on a server UUID; integer weights are shared with the browser's odds display. */
    fun selectFishingCatch(serverJobId: String, rodId: String, baitId: String?): String {
        val spec = checkNotNull(catalog.fishing)
        val bonus = (spec.rods.find { it.id == rodId }?.rareBonus ?: 0) + (spec.baits.find { it.itemId == baitId }?.rareBonus ?: 0)
        val weights = spec.fish.map { it to (it.weight + it.affinity * bonus) }
        var hash = 2166136261L
        for (character in serverJobId) hash = ((hash xor character.code.toLong()) * 16777619L) and 0xffffffffL
        // Keep the quantile stable when tackle changes; modulo would create free equipment rerolls.
        var roll = (hash * weights.sumOf { it.second } / 4294967296L).toInt()
        for ((fish, weight) in weights) { if (roll < weight) return fish.itemId; roll -= weight }
        return weights.last().first.itemId
    }

    fun apply(state: EconomyState, command: EconomyCommand, now: Instant, reservedItems: Map<String, Long> = emptyMap()): Pair<EconomyState, String> {
        validateEconomyCommand(command)
        if (command.action !in setOf("speedup_construction", "buy_fishing_item") && command.totalPrice != 0L) invalidEconomy()
        if (command.action !in setOf("start_production", "sell", "sell_fish", "buy_fishing_item") && command.quantity != 1L) invalidEconomy()
        return when (command.action) {
            "start_production" -> {
                if (command.quantity > catalog.maxBatch) invalidEconomy()
                val recipe = catalog.recipes.find { it.id == command.targetId } ?: economyFailure("ECONOMY_RECIPE", "Рецепт не найден")
                if ((state.buildings[recipe.buildingId] ?: 0) < recipe.buildingLevel)
                    economyFailure("ECONOMY_BUILDING_REQUIRED", "Сначала постройте или улучшите нужное здание")
                requireHome(state, recipe.requiredHomeLevel)
                requireBuildings(state, recipe.requiredBuildings)
                if (state.jobs.any { it.targetId == recipe.buildingId && it.kind in setOf("production", "construction") })
                    economyFailure("ECONOMY_BUILDING_BUSY", "Здание занято. Получите готовый результат или дождитесь окончания работ.")
                val cost = EconomyCost(recipe.cost.coins * command.quantity, recipe.cost.items.mapValues { it.value * command.quantity })
                val job = EconomyJob(command.requestId, "production", recipe.buildingId, recipe.id,
                    startedAt = now.toString(), finishesAt = now.plusSeconds(recipe.seconds * command.quantity).toString(),
                    rewards = recipe.rewards.mapValues { it.value * command.quantity }, cost = cost, catalogVersion = catalog.version,
                    collection = recipe.collection?.let { EconomyCollection(it.kind, it.seconds, null, null) })
                requireRewardCapacity(state, job.rewards)
                spend(state, cost).copy(jobs = state.jobs + job) to "Производство началось. Результат дождётся вас."
            }
            "start_collection" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                val spec = job.collection?.let { EconomyCollectionSpec(it.kind, it.seconds) }
                    ?: catalog.recipes.find { it.id == job.recipeId }?.collection
                if (job.kind != "production" || job.targetId != "garden" || (job.rewards["berries"] ?: 0L) <= 0L || spec == null)
                    economyFailure("ECONOMY_COLLECTION_KIND", "Для этой работы сбор Мохликом не требуется")
                if (job.collection?.startedAt != null) economyFailure("ECONOMY_COLLECTION_STARTED", "Мохлик уже собирает этот урожай")
                if (now.isBefore(Instant.parse(job.finishesAt))) economyFailure("ECONOMY_JOB_NOT_READY", "Урожай ещё не созрел")
                if (state.jobs.any { it.kind == "exploration" && now.isBefore(Instant.parse(it.finishesAt)) })
                    economyFailure("ECONOMY_EXPLORER_BUSY", "Мохлик ещё в вылазке. Дождитесь его возвращения")
                if (state.jobs.any { it.collection?.startedAt != null })
                    economyFailure("ECONOMY_COLLECTOR_BUSY", "Сначала завершите текущий сбор припасов")
                // Check the eventual delivery, including escrow, before sending the hero.
                // This reserves no goods and credits nothing; claim checks capacity again.
                val projected = state.copy(inventory = addItems(state.inventory, job.rewards))
                addItems(projected.inventory, reservedItems)
                assertStorageTransition(state, projected, reservedItems)
                val collecting = job.copy(collection = EconomyCollection(spec.kind, spec.seconds,
                    now.toString(), now.plusSeconds(spec.seconds).toString()))
                state.copy(jobs = state.jobs.map { if (it.id == job.id) collecting else it }) to "Мохлик отправился собирать урожай"
            }
            "start_exploration", "start_fishing" -> {
                val exploration = catalog.explorations.find { it.id == command.targetId } ?: economyFailure("ECONOMY_EXPLORATION", "Место исследования не найдено")
                requireHome(state, exploration.requiredHomeLevel)
                requireBuildings(state, exploration.requiredBuildings)
                if (state.jobs.any { it.collection?.startedAt != null })
                    economyFailure("ECONOMY_COLLECTOR_BUSY", "Сначала завершите сбор припасов")
                if (state.jobs.any { it.kind == "exploration" }) economyFailure("ECONOMY_EXPLORER_BUSY", "Мохлик уже исследует мир. Сначала получите результат вылазки.")
                val special = command.action == "start_fishing"
                val tackle = state.fishing
                val spec = catalog.fishing
                if (special) {
                    if (spec == null || exploration.id !in spec.routeIds || (exploration.rewards["fish"] ?: 0) <= 0)
                        economyFailure("ECONOMY_FISHING_ROUTE", "Здесь нельзя рыбачить со снастями Плёски")
                    if (tackle.equippedRodId !in tackle.ownedRods || spec.rods.none { it.id == tackle.equippedRodId })
                        economyFailure("ECONOMY_FISHING_ROD", "Сначала выберите свою удочку")
                    if (tackle.equippedBaitId != null && spec.baits.none { it.itemId == tackle.equippedBaitId })
                        economyFailure("ECONOMY_FISHING_BAIT", "Наживка не найдена")
                }
                // Fishing randomness is server-owned, unlike the client idempotency request ID.
                val id = if (special) UUID.randomUUID().toString() else command.requestId
                val seed = if (special) state.fishingCastSeed ?: UUID.randomUUID().toString() else state.fishingCastSeed
                val fishingCatch = if (special) EconomyFishingCatch(tackle.equippedRodId, tackle.equippedBaitId,
                    selectFishingCatch(checkNotNull(seed), tackle.equippedRodId, tackle.equippedBaitId)) else null
                val rewards = exploration.rewards.toMutableMap()
                fishingCatch?.let {
                    rewards["fish"] = rewards.getValue("fish") - 1
                    rewards[it.fishId] = (rewards[it.fishId] ?: 0) + 1
                }
                val cost = if (special && tackle.equippedBaitId != null) exploration.cost.copy(items = exploration.cost.items +
                    (tackle.equippedBaitId to ((exploration.cost.items[tackle.equippedBaitId] ?: 0) + 1))) else exploration.cost
                val job = EconomyJob(id, "exploration", exploration.id, startedAt = now.toString(),
                    finishesAt = now.plusSeconds(exploration.seconds).toString(), rewards = rewards.filterValues { it > 0 }, cost = cost,
                    catalogVersion = catalog.version, fishing = fishingCatch)
                requireRewardCapacity(state, job.rewards)
                spend(state, cost).copy(jobs = state.jobs + job, fishingCastSeed = seed) to if (special) "Мохлик отправился рыбачить. Снасти и наживка подготовлены" else "Мохлик отправился на исследование"
            }
            "cancel_exploration" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (job.kind != "exploration") economyFailure("ECONOMY_CANCEL_KIND", "Можно отменить только вылазку Мохлика")
                // Unclaimed rewards and already spent provisions are forfeited,
                // including after the timer ends. This is not a completed trip.
                state.copy(jobs = state.jobs.filterNot { it.id == job.id }) to
                    "Вылазка отменена. Добыча потеряна, потраченные припасы не возвращаются"
            }
            "start_construction" -> {
                val building = catalog.buildings.find { it.id == command.targetId } ?: economyFailure("ECONOMY_BUILDING", "Здание не найдено")
                val next = (state.buildings[building.id] ?: 0) + 1
                val upgrade = building.levels.find { it.level == next } ?: economyFailure("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены")
                requireHome(state, upgrade.requiredHomeLevel)
                requireBuildings(state, upgrade.requiredBuildings)
                if (state.jobs.any { it.kind == "construction" }) economyFailure("ECONOMY_CONSTRUCTION_BUSY", "Сначала завершите текущую стройку")
                if (state.jobs.any { it.kind == "production" && it.targetId == building.id }) economyFailure("ECONOMY_BUILDING_BUSY", "Получите результат производства перед улучшением")
                val job = EconomyJob(command.requestId, "construction", building.id, targetLevel = next,
                    startedAt = now.toString(), finishesAt = now.plusSeconds(upgrade.seconds).toString(), cost = upgrade.cost, catalogVersion = catalog.version)
                spend(state, upgrade.cost).copy(jobs = state.jobs + job) to "Материалы внесены, строительство началось"
            }
            "speedup_construction" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (job.kind != "construction") economyFailure("ECONOMY_SPEEDUP_KIND", "За жемчуг можно завершить только строительство")
                val price = constructionSpeedupPrice(job, now)
                // The client accepts a maximum; only the server clock determines the charge.
                if (price > command.totalPrice) economyFailure("ECONOMY_SPEEDUP_PRICE_CHANGED", "Стоимость ускорения изменилась. Проверьте цену и подтвердите снова")
                if (state.wallet.pearls < price) economyFailure("ECONOMY_PEARLS", "Не хватает жемчужин для ускорения")
                state.copy(wallet = state.wallet.copy(pearls = state.wallet.pearls - price),
                    buildings = state.buildings + (job.targetId to checkNotNull(job.targetLevel)),
                    jobs = state.jobs.filterNot { it.id == job.id }) to
                    if (price > 0) "Строительство завершено за жемчуг" else "Постройка готова"
            }
            "claim_job" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (now.isBefore(Instant.parse(job.finishesAt))) economyFailure("ECONOMY_JOB_NOT_READY", "Работа ещё не завершена")
                job.collection?.let { collection ->
                    if (collection.startedAt == null || collection.finishesAt == null)
                        economyFailure("ECONOMY_COLLECTION_REQUIRED", "Сначала отправьте Мохлика собрать урожай")
                    if (now.isBefore(Instant.parse(collection.finishesAt)))
                        economyFailure("ECONOMY_COLLECTION_NOT_READY", "Мохлик ещё собирает урожай")
                }
                val buildings = if (job.kind == "construction") state.buildings + (job.targetId to checkNotNull(job.targetLevel)) else state.buildings
                val next = state.copy(inventory = addItems(state.inventory, job.rewards), buildings = buildings, jobs = state.jobs.filterNot { it.id == job.id },
                    completedExplorations = if (job.kind == "exploration") minOf(ECONOMY_MAX_BALANCE, state.completedExplorations + 1) else state.completedExplorations,
                    fishing = if (job.kind == "exploration" && catalog.fishing?.routeIds?.contains(job.targetId) == true) {
                        val catches = state.fishing.catches.toMutableMap()
                        catalog.fishing.fish.forEach { fish -> if ((job.rewards[fish.itemId] ?: 0) > 0)
                            catches[fish.itemId] = minOf(ECONOMY_MAX_BALANCE, (catches[fish.itemId] ?: 0) + job.rewards.getValue(fish.itemId)) }
                        state.fishing.copy(catches = catches)
                    } else state.fishing,
                    fishingCastSeed = if (job.kind == "exploration" && catalog.fishing?.routeIds?.contains(job.targetId) == true) null else state.fishingCastSeed)
                addItems(next.inventory, reservedItems)
                assertStorageTransition(state, next, reservedItems)
                next to
                    if (job.kind == "construction") "Строительство завершено" else "Припасы доставлены на склад"
            }
            "buy_fishing_item" -> {
                val spec = catalog.fishing ?: economyFailure("ECONOMY_FISHING_ITEM", "Лавка Плёски пока недоступна")
                val rod = spec.rods.find { it.id == command.targetId }
                val fish = spec.fish.find { it.itemId == command.targetId }
                val bait = spec.baits.find { it.itemId == command.targetId }
                if (rod == null && fish == null && bait == null) economyFailure("ECONOMY_FISHING_ITEM", "Плёска не продаёт этот предмет")
                if (command.quantity > catalog.maxBatch || rod != null && command.quantity != 1L) invalidEconomy()
                if (rod != null && rod.id in state.fishing.ownedRods) economyFailure("ECONOMY_FISHING_OWNED", "Эта удочка уже есть в коллекции")
                val price = (rod?.price ?: fish?.buyPrice ?: checkNotNull(bait).price) * command.quantity
                if (price > command.totalPrice) economyFailure("ECONOMY_FISHING_PRICE_CHANGED", "Цена изменилась. Проверьте предложение Плёски")
                val spent = spend(state, EconomyCost(coins = price))
                val next = if (rod != null) spent.copy(fishing = state.fishing.copy(ownedRods = state.fishing.ownedRods + rod.id))
                    else spent.copy(inventory = addItems(spent.inventory, mapOf(command.targetId to command.quantity)))
                addItems(next.inventory, reservedItems)
                assertStorageTransition(state, next, reservedItems)
                next to if (rod != null) "Удочка добавлена в коллекцию" else "Покупка у Плёски отправлена на склад"
            }
            "equip_fishing_rod" -> {
                if (catalog.fishing?.rods?.none { it.id == command.targetId } != false || command.targetId !in state.fishing.ownedRods)
                    economyFailure("ECONOMY_FISHING_ROD", "Сначала приобретите эту удочку")
                state.copy(fishing = state.fishing.copy(equippedRodId = command.targetId)) to "Удочка выбрана для следующих вылазок"
            }
            "equip_fishing_bait" -> {
                val baitId = command.targetId.takeUnless { it == "none" }
                if (baitId != null && catalog.fishing?.baits?.none { it.itemId == baitId } != false)
                    economyFailure("ECONOMY_FISHING_BAIT", "Наживка не найдена")
                if (baitId != null && (state.inventory[baitId] ?: 0) <= 0) economyFailure("ECONOMY_RESOURCES", "Сначала приобретите эту наживку")
                state.copy(fishing = state.fishing.copy(equippedBaitId = baitId)) to
                    if (baitId == null) "Выбрана рыбалка без наживки" else "Наживка выбрана: одна порция на следующую вылазку"
            }
            "sell", "sell_fish" -> {
                if (command.action == "sell_fish" && catalog.fishing?.fish?.none { it.itemId == command.targetId } != false)
                    economyFailure("ECONOMY_FISHING_ITEM", "Плёска принимает здесь только рыбу")
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
