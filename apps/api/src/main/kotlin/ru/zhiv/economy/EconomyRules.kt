package ru.zhiv.economy

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.world.WorldRules
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import java.time.Instant
import java.util.UUID
import kotlin.math.floor
import kotlin.math.sqrt

internal fun economyFailure(code: String, message: String): Nothing = throw AuthFailure(code, message, 409)
internal fun invalidEconomy(): Nothing = throw AuthFailure("INVALID_ECONOMY_COMMAND", "Некорректный запрос хозяйства", 400)

fun validateEconomyCommand(command: EconomyCommand) {
    if (parseCanonicalUuidV4(command.requestId) == null || parsePublicId(command.ownerPublicId) != command.ownerPublicId ||
        command.expectedRevision !in 0L until ECONOMY_MAX_REVISION || command.targetId.length !in 1..80 ||
        command.action.length !in 1..40 || command.quantity !in 1L..10_000L || command.totalPrice !in 0L..ECONOMY_MAX_BALANCE) invalidEconomy()
    command.fishSelection?.let { selection ->
        if (command.action !in setOf("start_production", "complete_resident_order", "sell", "sell_fish", "create_listing") || selection.size > 100 ||
            selection.keys.any { it.length !in 1..80 }) invalidEconomy()
    }
}

fun decodeEconomyCommand(element: JsonElement): EconomyCommand {
    val value = element as? JsonObject ?: invalidEconomy()
    val fields = setOf("requestId", "ownerPublicId", "expectedRevision", "action", "targetId", "quantity", "totalPrice", "fishSelection")
    if (value.keys.any { it !in fields }) invalidEconomy()
    for (field in listOf("requestId", "ownerPublicId", "action", "targetId"))
        if ((value[field] as? JsonPrimitive)?.isString != true) invalidEconomy()
    for (field in listOf("expectedRevision", "quantity", "totalPrice")) {
        val number = value[field] ?: if (field == "expectedRevision") invalidEconomy() else continue
        val primitive = number as? JsonPrimitive ?: invalidEconomy()
        if (primitive.isString || primitive.longOrNull == null) invalidEconomy()
    }
    value["fishSelection"]?.takeUnless { it == JsonNull }?.let { supplied ->
        val selection = supplied as? JsonObject ?: invalidEconomy()
        if (selection.size > 100) invalidEconomy()
        selection.forEach { (id, number) ->
            val primitive = number as? JsonPrimitive ?: invalidEconomy()
            if (id.length !in 1..80 || primitive.isString || primitive.longOrNull == null) invalidEconomy()
        }
    }
    return try { economyJson.decodeFromJsonElement<EconomyCommand>(value).also(::validateEconomyCommand) }
    catch (_: SerializationException) { invalidEconomy() }
}

object EconomyRules {
    val catalog: EconomyCatalog = economyJson.decodeFromString(
        checkNotNull(EconomyRules::class.java.getResourceAsStream("/world/economy-catalog.json")).bufferedReader().use { it.readText() })

    init {
        EconomyTutorialOrders.validateCatalog(catalog)
        EconomyStageOrders.validateCatalog(catalog)
        require(catalog.version == 11 && catalog.currencyScale == 10 && catalog.pearlScale == 50 && catalog.maxBatch in 1..10)
        require(catalog.localBuyer.payoutBps in 1..10_000)
        require(catalog.localBuyer.unitPrices.all { (id, amount) -> amount in 1L..ECONOMY_MAX_BALANCE && catalog.items.any { it.id == id && it.tradable } })
        require(catalog.constructionSpeedup.secondsPerPearl in 1L..86_400L)
        require(catalog.constructionSpeedup.priceStepPearls in 1L..ECONOMY_PEARL_SCALE)
        require(catalog.constructionSpeedup.pricingPoints.size >= 2 &&
            catalog.constructionSpeedup.pricingPoints.all { it.seconds in 1L..31_536_000L && it.pearls in 1L..ECONOMY_MAX_PEARLS } &&
            catalog.constructionSpeedup.pricingPoints.zipWithNext().all { (a, b) -> a.seconds < b.seconds && a.pearls <= b.pearls })
        require(catalog.market.requiredBuildings.all { (id, level) -> catalog.buildings.any { building ->
            building.id == id && building.levels.any { it.level == level }
        } })
        require(catalog.market.maxListings in 1..10 && catalog.market.maxLotQuantity in 1L..99L &&
            catalog.market.maxPriceMultiplier in 1L..2L && catalog.market.feeBps == 500)
        require(catalog.market.baseSlots == 5 && catalog.market.slotPricesPearls.size == 5)
        require(catalog.market.dailyTradeValueByHome.size == 5 && catalog.market.dailyTradeValueByHome.first() == 0L &&
            catalog.market.dailyTradeValueByHome.drop(1).all { it in 1L..ECONOMY_MAX_BALANCE } &&
            catalog.market.dailyTradeValueByHome.zipWithNext().all { (a,b) -> a <= b })
        require(catalog.items.map { it.id }.distinct().size == catalog.items.size)
        require(catalog.items.all { if (it.category == "special") it.baseSellPrice == 0L && !it.tradable else it.baseSellPrice > 0L })
        catalog.leaftailShop?.let { shop ->
            require(shop.offers.all { offer -> catalog.items.any { item -> item.id == offer.itemId &&
                (if (item.category == "special") !item.tradable && offer.quantity == 1L
                else item.id in setOf("wood", "stone", "fiber") && item.tradable && offer.priceCoins == 2L * item.baseSellPrice * offer.quantity) } })
        }
        require(catalog.buildings.map { it.id }.distinct().size == catalog.buildings.size)
        require(catalog.recipes.map { it.id }.distinct().size == catalog.recipes.size)
        require(catalog.recipes.all { it.maxBatch == null || it.maxBatch in 1..catalog.maxBatch })
        require(catalog.recipes.all { recipe -> recipe.requiredRecipes.all { (id, amount) ->
            amount in 1L..ECONOMY_MAX_ITEMS && catalog.recipes.any { it.id == id } } })
        catalog.fishing?.let { fishing ->
            val rarities = setOf("common", "uncommon", "rare", "epic", "legendary")
            require(fishing.routeIds.isNotEmpty() && fishing.routeIds.all { id -> catalog.explorations.any { it.id == id && (it.rewards["fish"] ?: 0) > 0 } })
            require(fishing.classes.map { it.rarity }.toSet() == rarities && fishing.classes.size == rarities.size)
            require(fishing.classes.map { it.itemId }.distinct().size == rarities.size)
            require(fishing.classes.all { tier -> tier.itemId == "fish_${tier.rarity}" && tier.weight in 1..10000 &&
                tier.buyPrice in 1L..ECONOMY_MAX_BALANCE && catalog.items.any { it.id == tier.itemId && it.baseSellPrice < tier.buyPrice } &&
                fishing.fish.any { it.rarity == tier.rarity } })
            require(fishing.fish.isNotEmpty() && fishing.fish.map { it.itemId }.distinct().size == fishing.fish.size)
            require(fishing.collectionDrawsByRoute.keys == fishing.routeIds.toSet())
            require(fishing.collectionDrawsByRoute.all { (id, draws) -> id in fishing.routeIds && draws in 1..100 &&
                draws.toLong() == catalog.explorations.first { it.id == id }.rewards.getValue("fish") })
            require((fishing.rods.map { it.rarityWeights } + fishing.hooks.map { it.rarityWeights } + fishing.baits.map { it.rarityWeights })
                .filterNotNull().all { weights -> weights.keys == rarities && weights.values.all { it in 1..1000 } })
            require(fishing.fish.all { fish -> (fish.weight == null || fish.weight in 1..10000) &&
                (fish.affinity == null || fish.affinity in 0..10) && fish.rarity in rarities &&
                catalog.items.any { it.id == fish.itemId && it.baseSellPrice < fish.buyPrice } })
            require(fishing.rods.map { it.id }.distinct().size == fishing.rods.size && fishing.rods.any { it.id == "reed_rod" && it.price == 0L })
            require(fishing.rods.all { it.price in 0..ECONOMY_MAX_BALANCE && it.rareBonus in 0..100 && it.rarity in rarities &&
                it.requiredHomeLevel in 1..5 && it.classOddsBps != null })
            require(fishing.classes.all { tier -> fishing.rods.any { rod ->
                (tier.rarity != "legendary" || rod.rarity == "legendary") && (rod.classOddsBps?.get(tier.rarity) ?: 0) > 0
            } })
            require(fishing.hooks.map { it.id }.distinct().size == fishing.hooks.size && fishing.hooks.any { it.id == "bare_hook" && it.price == 0L })
            require(fishing.hooks.all { it.price in 0..ECONOMY_MAX_BALANCE && it.rareBonus in 0..100 && it.rarity in rarities && it.requiredHomeLevel in 1..5 })
            require(fishing.baits.map { it.itemId }.distinct().size == fishing.baits.size && fishing.baits.all { bait ->
                bait.price in 1..ECONOMY_MAX_BALANCE && bait.rareBonus in 0..100 && bait.rarity in rarities && bait.requiredHomeLevel in 1..5 &&
                    catalog.items.any { it.id == bait.itemId && it.baseSellPrice < bait.price } })
        }
        catalog.rareDrops?.let { rare ->
            require(rare.itemIds.all { id -> catalog.items.any { it.id == id && it.category == "special" } })
            require(catalog.explorations.all { it.seconds < rare.minSeconds })
        }
        EconomyFood.validateCatalog(catalog)
    }

    /** Square-root conversion preserves a modest head start without importing beta-scale balances. */
    fun legacyConversion(sparks: Long, wood: Long, stone: Long): EconomyMigration {
        require(listOf(sparks, wood, stone).all { it in 0L..ECONOMY_MAX_REVISION })
        return EconomyMigration(coinsGranted = ECONOMY_CURRENCY_SCALE * minOf(500L, floor(2 * sqrt(sparks.toDouble()) + sqrt(wood.toDouble()) + sqrt(stone.toDouble())).toLong()),
            woodGranted = minOf(30L, floor(sqrt(wood.toDouble())).toLong()), stoneGranted = minOf(30L, floor(sqrt(stone.toDouble())).toLong()))
    }

    fun initial(sparks: Long = 0, wood: Long = 0, stone: Long = 0, homeLevel: Int = 1, workshopLevel: Int = 0, includeStartingPack: Boolean = true): EconomyState {
        val grant = legacyConversion(sparks, wood, stone)
        val starting = if (includeStartingPack) catalog.onboarding else null
        val inventory = (starting?.startingItems ?: emptyMap()).toMutableMap()
        if (grant.woodGranted > 0) inventory["wood"] = (inventory["wood"] ?: 0) + grant.woodGranted
        if (grant.stoneGranted > 0) inventory["stone"] = (inventory["stone"] ?: 0) + grant.stoneGranted
        return EconomyState(currencyScale=10,pearlScale=50,itemUnlockVersion=1,
            wallet = EconomyWallet(grant.coinsGranted + (starting?.startingWallet?.coins ?: 0), starting?.startingWallet?.pearls ?: 0), inventory = EconomyFishInventory.items(inventory),
            buildings = mapOf("home" to homeLevel.coerceIn(1, 5), "garden" to 1, "woodlot" to 0, "quarry" to 0,
                "workshop" to workshopLevel.coerceIn(0, 3), "dryer" to 0, "warehouse" to 1, "kiln" to 0,
                "bridge" to 0, "lighthouse" to 0), migration = grant,
            tutorialOrder = if (starting == null) EconomyTutorialOrder() else EconomyTutorialOrder(
                version = 3, step = 0, ingredientsClaimed = true, terms = EconomyTutorialOrders.orders(starting).first()))
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
        val result = EconomyFishInventory.items(inventory).toMutableMap()
        for ((id, quantity) in EconomyFishInventory.items(amounts)) {
            val current = result[id] ?: 0
            if (quantity < 0 || current !in 0L..ECONOMY_MAX_ITEMS || quantity > ECONOMY_MAX_ITEMS - current)
                economyFailure("ECONOMY_CAPACITY", "Запас этого предмета достиг предела. Сначала освободите место.")
            result[id] = current + quantity
        }
        return result.filterValues { it > 0 }
    }

    internal fun spend(input: EconomyState, originalCost: EconomyCost, fishSelection: Map<String, Long>? = null): EconomyState {
        val state = EconomyFishInventory.state(input)
        val cost = originalCost.copy(items = EconomyFishInventory.items(originalCost.items))
        if (state.wallet.coins < cost.coins || cost.items.any { (id, quantity) -> (state.inventory[id] ?: 0) < quantity })
            economyFailure("ECONOMY_RESOURCES", "Не хватает монет или материалов. Можно собрать их, произвести или купить на рынке.")
        return state.copy(wallet = state.wallet.copy(coins = state.wallet.coins - cost.coins),
            fishing = EconomyFishStock.debit(state, cost.items, fishSelection).fishing,
            inventory = state.inventory.mapValues { (id, quantity) -> quantity - (cost.items[id] ?: 0) }.filterValues { it > 0 })
    }

    private fun requireHome(state: EconomyState, level: Int) {
        if ((state.buildings["home"] ?: 1) < level) economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня $level")
    }

    internal fun requireBuildings(state: EconomyState, requiredBuildings: Map<String, Int>) {
        val unmet = requiredBuildings.filter { (id, level) -> (state.buildings[id] ?: 0) < level }
        if (unmet.isNotEmpty()) {
            val description = unmet.entries.joinToString(", ") { (id, level) ->
                "${catalog.buildings.single { it.id == id }.name}: уровень $level"
            }
            economyFailure("ECONOMY_BUILDING_REQUIRED", "Сначала завершите улучшения: $description")
        }
    }

    /** The remaining-time curve is rounded upwards to a whole visible pearl. */
    fun constructionSpeedupPrice(job: EconomyJob, now: Instant): Long {
        if (job.kind != "construction") return 0
        if (catalog.constructionSpeedup.pricingPoints.isEmpty())
            return remainingTimePearlPrice(job.finishesAt, now, catalog.constructionSpeedup.secondsPerPearl,
                ECONOMY_PEARL_SCALE, catalog.constructionSpeedup.priceStepPearls)
        return remainingTimePearlPrice(job.finishesAt, now, catalog.constructionSpeedup.pricingPoints,
            catalog.constructionSpeedup.priceStepPearls)
    }

    /** Rods define class odds; hooks and bait multiply those odds without opening zero-probability classes. */
    fun fishingClassWeights(rodId: String, baitId: String?, hookId: String = "bare_hook",
        spec: EconomyFishingCatalog = checkNotNull(catalog.fishing)): List<Pair<EconomyFishClass, Int>> {
        val rod = spec.rods.find { it.id == rodId }
        val hook = spec.hooks.find { it.id == hookId }
        val bait = spec.baits.find { it.itemId == baitId }
        return spec.classes.map { tier -> tier to when {
            tier.rarity == "legendary" && rod?.rarity != "legendary" -> 0
            spec.fish.none { it.rarity == tier.rarity } -> 0
            rod?.classOddsBps != null -> (rod.classOddsBps.getValue(tier.rarity).toLong() *
                (hook?.rarityWeights?.get(tier.rarity) ?: 100) * (bait?.rarityWeights?.get(tier.rarity) ?: 100) / 10_000L).toInt()
            // Standalone legacy catalogues can still be inspected; the current v5 catalogue requires rod odds.
            else -> maxOf(1L, tier.weight.toLong() * (rod?.rarityWeights?.get(tier.rarity) ?: 100) *
                (hook?.rarityWeights?.get(tier.rarity) ?: 100) * (bait?.rarityWeights?.get(tier.rarity) ?: 100) / 1_000_000L).toInt()
        } }
    }

    /** Display-only distribution; the actual draw below first selects class, then uniform species. */
    fun fishingWeights(rodId: String, baitId: String?, hookId: String = "bare_hook"): List<Pair<EconomyFishSpec, Double>> {
        val spec = checkNotNull(catalog.fishing)
        val classes = fishingClassWeights(rodId, baitId, hookId).associate { it.first.rarity to it.second }
        return spec.fish.map { fish -> fish to classes.getValue(fish.rarity).toDouble() / spec.fish.count {
                it.rarity == fish.rarity }
        }
    }

    fun fishingBaitCompatible(rodId: String, baitId: String?, spec: EconomyFishingCatalog = checkNotNull(catalog.fishing)): Boolean {
        if (baitId == null) return true
        if (spec.rods.none { it.id == rodId }) return false
        val bait = spec.baits.find { it.itemId == baitId } ?: return false
        return fishingClassWeights(rodId, null, spec = spec).any { it.first.rarity == bait.rarity && it.second > 0 }
    }

    private fun requireFishingBaitCompatible(rodId: String, baitId: String?) {
        if (!fishingBaitCompatible(rodId, baitId))
            economyFailure("ECONOMY_FISHING_BAIT", "Эта удочка не ловит рыбу для выбранной наживки")
    }

    private fun fishingRoll(seed: String, drawIndex: Int, domain: String): Long {
        var hash = 2166136261L
        for (character in "$seed:$drawIndex:$domain") hash = ((hash xor character.code.toLong()) * 16777619L) and 0xffffffffL
        hash = ((hash xor (hash ushr 16)) * 0x85ebca6bL) and 0xffffffffL
        hash = ((hash xor (hash ushr 13)) * 0xc2b2ae35L) and 0xffffffffL
        return (hash xor (hash ushr 16)) and 0xffffffffL
    }

    /** Independent, server-private hash domains prevent class/species correlation and catch previews. */
    fun selectFishingCatch(serverSeed: String, rodId: String, baitId: String?, hookId: String = "bare_hook", drawIndex: Int = 0): String {
        val weights = fishingClassWeights(rodId, baitId, hookId).filter { it.second > 0 }
        var roll = fishingRoll(serverSeed, drawIndex, "class") * weights.sumOf { it.second } / 4294967296L
        var selected = weights.last().first
        for ((tier, weight) in weights) {
            if (roll < weight) { selected = tier; break }
            roll -= weight
        }
        val species = checkNotNull(catalog.fishing).fish.filter { it.rarity == selected.rarity }
        return species[(fishingRoll(serverSeed, drawIndex, "species") * species.size / 4294967296L).toInt()].itemId
    }

    /** Floor one whole stack; splitting cannot improve the payout. */
    fun localSellPrice(basePrice: Long, quantity: Long = 1, config: EconomyLocalBuyer = catalog.localBuyer, itemId: String? = null): Long {
        itemId?.let { config.unitPrices[it] }?.let { return it * quantity }
        val total = basePrice / ECONOMY_CURRENCY_SCALE * quantity
        return ECONOMY_CURRENCY_SCALE * (total / 10_000 * config.payoutBps + total % 10_000 * config.payoutBps / 10_000)
    }

    fun commandUsesActor(command: EconomyCommand): Boolean = when (command.action) {
        "start_exploration", "start_fishing" -> catalog.explorations.find { it.id == command.targetId }?.activity != "mining"
        "start_collection", "start_garden_collection", "eat_food" -> true
        else -> false
    }

    fun isMinerJob(job: EconomyJob): Boolean = job.kind == "exploration" && job.actorId == "miner"

    private fun requireMinerAvailable(state: EconomyState) {
        if (state.jobs.any(::isMinerJob)) economyFailure("ECONOMY_MINER_BUSY", "Шахтёр занят. Сначала заберите добычу или отмените работу")
    }

    private fun requireJobCapacity(state: EconomyState) {
        if (state.jobs.size >= 18) economyFailure("ECONOMY_JOBS_CAPACITY", "Все очереди заняты. Сначала заберите готовые результаты")
    }

    /** Saved jobs retain their promised results. Only new starts compete for the hero. */
    private fun requireActorAvailable(state: EconomyState, now: Instant, collecting: Boolean = false) {
        val collection = state.jobs.any { it.collection?.startedAt != null }
        if (!collecting && collection) economyFailure("ECONOMY_COLLECTOR_BUSY", "Сначала завершите сбор припасов")
        state.jobs.firstOrNull { it.kind == "exploration" && !isMinerJob(it) && (!collecting || now.isBefore(Instant.parse(it.finishesAt))) }?.let {
            economyFailure("ECONOMY_EXPLORER_BUSY", if (now.isBefore(Instant.parse(it.finishesAt)))
                "Мохлик ещё в вылазке. Дождитесь его возвращения" else "Сначала заберите находки Мохлика")
        }
        state.jobs.firstOrNull { it.kind == "production" && it.targetId == "quarry" && (!collecting || now.isBefore(Instant.parse(it.finishesAt))) }?.let {
            economyFailure("ECONOMY_QUARRY_BUSY", if (now.isBefore(Instant.parse(it.finishesAt)))
                "Мохлик работает в каменоломне. Дождитесь окончания добычи" else "Сначала заберите добычу из каменоломни")
        }
        if (collection) economyFailure("ECONOMY_COLLECTOR_BUSY", "Сначала завершите текущий сбор припасов")
    }

    fun productionStationSupported(stationId: String): Boolean = stationId != "quarry" && catalog.recipes.any { it.buildingId == stationId }

    fun productionSlotCount(state: EconomyState, stationId: String): Int =
        if (productionStationSupported(stationId)) (state.productionSlots[stationId] ?: 1).coerceIn(1, 3) else 1

    fun productionSlotOffer(state: EconomyState, stationId: String): EconomyProductionSlotUpgrade? =
        if (productionStationSupported(stationId)) catalog.productionSlots.upgrades.find { it.slots == productionSlotCount(state, stationId) + 1 } else null

    fun marketSlotOffer(state: EconomyState): EconomyMarketSlotOffer? =
        catalog.market.slotPricesPearls.getOrNull(state.marketSlots - catalog.market.baseSlots)?.let {
            EconomyMarketSlotOffer("market:${state.marketSlots + 1}", state.marketSlots + 1, it)
        }

    /** Materialize the board from pre-command unlocks only on a successful mutation.
     * In particular, claiming a new building must not reroll previously displayed cards. */
    fun apply(input: EconomyState, command: EconomyCommand, now: Instant, reservedItems: Map<String, Long> = emptyMap(),
        legacyHistory: Set<String> = emptySet()): Pair<EconomyState, String> {
        val known = EconomyItemUnlocks.persist(EconomyFishInventory.state(input), legacyHistory + reservedItems.filterValues { it > 0 }.keys)
        val state = EconomyStageOrders.pin(known, now = now)
        val (next, message) = applyCurrent(state.copy(residentOrders = EconomyFood.normalizedOrders(state, now)), command, now, reservedItems)
        return EconomyItemUnlocks.persist(EconomyStageOrders.pin(next, now = now)) to message
    }

    private fun requireClaimReady(job: EconomyJob, now: Instant) {
        if (now.isBefore(Instant.parse(job.finishesAt))) economyFailure("ECONOMY_JOB_NOT_READY", "Работа ещё не завершена")
        job.collection?.let { collection ->
            if (collection.startedAt == null || collection.finishesAt == null)
                economyFailure("ECONOMY_COLLECTION_REQUIRED", "Сначала отправьте Мохлика собрать урожай")
            if (now.isBefore(Instant.parse(collection.finishesAt)))
                economyFailure("ECONOMY_COLLECTION_NOT_READY", "Мохлик ещё собирает урожай")
        }
    }

    private fun claimJob(state: EconomyState, job: EconomyJob, now: Instant, reservedItems: Map<String, Long>): EconomyState {
        requireClaimReady(job, now)
        val buildings = if (job.kind == "construction") state.buildings + (job.targetId to checkNotNull(job.targetLevel)) else state.buildings
        val delivered = EconomyItemUnlocks.delivered(state.copy(inventory = addItems(state.inventory, job.rewards), buildings = buildings, jobs = state.jobs.filterNot { it.id == job.id },
            completedExplorations = if (job.kind == "exploration" && !isMinerJob(job) && !job.targetId.startsWith("quarry_")) minOf(ECONOMY_MAX_ITEMS, state.completedExplorations + 1) else state.completedExplorations,
            fishing = if (job.kind == "exploration" && catalog.fishing?.routeIds?.contains(job.targetId) == true) {
                val catches = state.fishing.catches.toMutableMap()
                catalog.fishing.fish.forEach { fish -> if ((job.rewards[fish.itemId] ?: 0) > 0)
                    catches[fish.itemId] = minOf(ECONOMY_MAX_ITEMS, (catches[fish.itemId] ?: 0) + job.rewards.getValue(fish.itemId)) }
                state.fishing.copy(catches = catches)
            } else state.fishing,
            fishingCastSeed = if (job.kind == "exploration" && catalog.fishing?.routeIds?.contains(job.targetId) == true) null else state.fishingCastSeed,
            progression = EconomyCollectionProgress.advance(state.progression, job)), job.rewards)
        val next = if (job.kind == "exploration" && catalog.fishing?.routeIds?.contains(job.targetId) == true)
            EconomyFishStock.credit(delivered, job.rewards) else delivered
        addItems(next.inventory, reservedItems)
        assertStorageTransition(state, next, reservedItems)
        return if (job.rareDrop != null) {
            val clock = EconomyRareDrops.settle(if (isMinerJob(job)) state.minerRareDropState else state.rareDropState,
                job.rareDrop, checkNotNull(catalog.rareDrops))
            if (isMinerJob(job)) next.copy(minerRareDropState = clock) else next.copy(rareDropState = clock)
        } else next
    }

    private fun applyCurrent(state: EconomyState, command: EconomyCommand, now: Instant, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        validateEconomyCommand(command)
        if (command.action !in setOf("speedup_construction", "buy_fishing_item", "buy_wardrobe_item", "buy_leaftail_item", "refresh_fishing_shop", "replace_resident_order", "sell", "buy_market_slot") && command.totalPrice != 0L) invalidEconomy()
        if (command.action !in setOf("start_production", "sell", "sell_fish", "buy_fishing_item") && command.quantity != 1L) invalidEconomy()
        return when (command.action) {
            "claim_tutorial_order" -> EconomyTutorialOrders.claim(state, command, reservedItems)
            "claim_workshop_starter" -> EconomyWorkshopStarter.claim(state, command, reservedItems)
            "eat_food", "feed_builder" -> EconomyFood.eat(state, command.targetId, command.action == "feed_builder", now)
            "complete_resident_order", "replace_resident_order" -> when {
                EconomyTutorialOrders.isTutorialId(command.targetId) -> EconomyTutorialOrders.complete(state, command)
                EconomyStageOrders.isStageId(command.targetId) -> EconomyStageOrders.complete(state, command, now, reservedItems)
                else -> EconomyFood.order(state, command.targetId, command.action == "replace_resident_order", now, command.totalPrice, fishSelection = command.fishSelection)
            }
            "start_production" -> {
                if (command.targetId.startsWith("quarry_")) economyFailure("ECONOMY_MINING_ACTIVITY", "Выберите участок добычи для шахтёра")
                if (command.quantity > catalog.maxBatch) invalidEconomy()
                val parts = command.targetId.split('@')
                val baseRecipe = catalog.recipes.find { it.id == parts.first() } ?: economyFailure("ECONOMY_RECIPE", "Рецепт не найден")
                if (parts.size > 2 || parts.getOrNull(1) == "") economyFailure("ECONOMY_RECIPE_FISH", "Эта рыба не подходит для выбранного блюда")
                val recipe = EconomyFood.recipeWithFish(baseRecipe, parts.getOrNull(1))
                if (command.quantity > (recipe.maxBatch ?: catalog.maxBatch)) invalidEconomy()
                if ((state.buildings[recipe.buildingId] ?: 0) < recipe.effectiveBuildingLevel)
                    economyFailure("ECONOMY_BUILDING_REQUIRED", "Сначала постройте или улучшите нужное здание")
                requireHome(state, recipe.requiredHomeLevel)
                requireBuildings(state, recipe.requiredBuildings)
                if (recipe.requiredRecipes.any { (id, amount) -> (state.progression.recipes[id] ?: 0L) < amount })
                    economyFailure("ECONOMY_RECIPE_REQUIRED", "Сначала освоите нужные рецепты")
                if (state.jobs.any { it.targetId == recipe.buildingId && it.kind == "construction" })
                    economyFailure("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения здания и заберите результат")
                if (state.jobs.count { it.targetId == recipe.buildingId && it.kind == "production" } >= productionSlotCount(state, recipe.buildingId))
                    economyFailure("ECONOMY_BUILDING_BUSY", "Все места производства заняты. Заберите готовый результат")
                requireJobCapacity(state)
                val firstHarvest = EconomyTutorialOrders.canPrepareFirstHarvest(state, recipe.id, command.quantity)
                val cost = EconomyCost(recipe.cost.coins * command.quantity, recipe.cost.items.mapValues { it.value * command.quantity })
                val spent = spend(state, cost, command.fishSelection)
                val beforeStock = EconomyFishStock.normalized(state).orEmpty()
                val afterStock = EconomyFishStock.normalized(spent).orEmpty()
                val fishStockCost = beforeStock.mapValues { (id, amount) -> amount - (afterStock[id] ?: 0L) }.filterValues { it > 0L }
                val job = EconomyJob(command.requestId, "production", recipe.buildingId, recipe.id,
                    startedAt = now.toString(), finishesAt = (if (firstHarvest) now.plusMillis(1) else now.plusSeconds(recipe.seconds * command.quantity)).toString(),
                    rewards = recipe.rewards.mapValues { it.value * command.quantity }, cost = cost, catalogVersion = catalog.version,
                    collection = recipe.collection?.let { EconomyCollection(it.kind, it.seconds, null, null) },
                    fishStockCost = fishStockCost.takeIf { it.isNotEmpty() })
                requireRewardCapacity(state, job.rewards)
                spent.copy(jobs = state.jobs + job, tutorialOrder = spent.tutorialOrder.copy(
                    firstHarvestPrepared = spent.tutorialOrder.firstHarvestPrepared || firstHarvest)) to
                    if (firstHarvest) "Первый учебный урожай созрел. Отправьте Мохлика собрать малину" else "Производство началось. Результат дождётся вас."
            }
            "buy_production_slot" -> {
                if (!productionStationSupported(command.targetId)) economyFailure("ECONOMY_PRODUCTION_STATION", "В этой постройке нет мест производства")
                if ((state.buildings[command.targetId] ?: 0) <= 0) economyFailure("ECONOMY_BUILDING_REQUIRED", "Сначала постройте нужное здание")
                val offer = productionSlotOffer(state, command.targetId)
                    ?: economyFailure("ECONOMY_PRODUCTION_SLOTS_MAX", "Все три места производства уже открыты")
                requireHome(state, offer.requiredHomeLevel)
                if (state.jobs.any { it.kind == "construction" && it.targetId == command.targetId })
                    economyFailure("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения здания и заберите результат")
                if (state.wallet.pearls < offer.pricePearls) economyFailure("ECONOMY_PEARLS", "Не хватает жемчужин для нового места")
                state.copy(wallet = state.wallet.copy(pearls = state.wallet.pearls - offer.pricePearls),
                    productionSlots = state.productionSlots + (command.targetId to offer.slots)) to "Открыто новое место производства"
            }
            "start_collection", "start_garden_collection" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                val spec = job.collection?.let { EconomyCollectionSpec(it.kind, it.seconds) }
                    ?: catalog.recipes.find { it.id == job.recipeId }?.collection
                if (job.kind != "production" || job.targetId != "garden" ||
                    job.rewards.none { (id, quantity) -> id in economyBerryItemIds && quantity > 0L } || spec == null)
                    economyFailure("ECONOMY_COLLECTION_KIND", "Для этой работы сбор Мохликом не требуется")
                if (job.collection?.startedAt != null) economyFailure("ECONOMY_COLLECTION_STARTED", "Мохлик уже собирает этот урожай")
                if (now.isBefore(Instant.parse(job.finishesAt))) economyFailure("ECONOMY_JOB_NOT_READY", "Урожай ещё не созрел")
                requireActorAvailable(state, now, collecting = true)
                val batch = command.action == "start_garden_collection"
                val jobs = if (batch) state.jobs.filter { current -> current.kind == "production" && current.targetId == "garden" &&
                    current.rewards.any { (id, quantity) -> id in economyBerryItemIds && quantity > 0L } && current.collection?.startedAt == null &&
                    !now.isBefore(Instant.parse(current.finishesAt)) && (current.collection != null || catalog.recipes.find { it.id == current.recipeId }?.collection != null) }
                    else listOf(job)
                // Check the eventual delivery, including escrow, before sending the hero.
                // This reserves no goods and credits nothing; claim checks capacity again.
                val projected = state.copy(inventory = jobs.fold(state.inventory) { inventory, current -> addItems(inventory, current.rewards) })
                addItems(projected.inventory, reservedItems)
                assertStorageTransition(state, projected, reservedItems)
                val seconds = if (batch) maxOf(8L, jobs.maxOf { current -> current.collection?.seconds ?: checkNotNull(catalog.recipes.find { it.id == current.recipeId }?.collection).seconds }) else spec.seconds
                val ids = jobs.map { it.id }.toSet()
                state.copy(jobs = state.jobs.map { current -> if (current.id !in ids) current else {
                    val saved = current.collection?.let { EconomyCollectionSpec(it.kind, it.seconds) }
                        ?: checkNotNull(catalog.recipes.find { it.id == current.recipeId }?.collection)
                    current.copy(collection = EconomyCollection(saved.kind, saved.seconds,
                        now.toString(), now.plusSeconds(seconds).toString(), if (batch) command.requestId else null))
                } }) to "Мохлик отправился собирать урожай"
            }
            "start_exploration", "start_fishing" -> {
                val exploration = catalog.explorations.find { it.id == command.targetId } ?: economyFailure("ECONOMY_EXPLORATION", "Место исследования не найдено")
                requireHome(state, exploration.requiredHomeLevel)
                requireBuildings(state, exploration.requiredBuildings)
                if (exploration.requiredBuildings.containsKey("quarry") && state.jobs.any { it.kind == "construction" && it.targetId == "quarry" })
                    economyFailure("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения шахты и заберите результат")
                val mining = exploration.activity == "mining"
                if (mining) requireMinerAvailable(state) else requireActorAvailable(state, now)
                val tackle = state.fishing
                val spec = catalog.fishing
                // Normalize old clients too: a general command cannot bypass fishing equipment or bait costs.
                val special = command.action == "start_fishing" || spec?.routeIds?.contains(exploration.id) == true
                if (special) {
                    if (spec == null || exploration.id !in spec.routeIds || (exploration.rewards["fish"] ?: 0) <= 0)
                        economyFailure("ECONOMY_FISHING_ROUTE", "Здесь нельзя рыбачить со снастями Плёски")
                    if (tackle.equippedRodId !in tackle.ownedRods || spec.rods.none { it.id == tackle.equippedRodId })
                        economyFailure("ECONOMY_FISHING_ROD", "Сначала выберите свою удочку")
                    if (tackle.equippedHookId !in tackle.ownedHooks || spec.hooks.none { it.id == tackle.equippedHookId })
                        economyFailure("ECONOMY_FISHING_HOOK", "Сначала выберите свой крючок")
                    if (tackle.equippedBaitId != null && spec.baits.none { it.itemId == tackle.equippedBaitId })
                        economyFailure("ECONOMY_FISHING_BAIT", "Наживка не найдена")
                    requireFishingBaitCompatible(tackle.equippedRodId, tackle.equippedBaitId)
                }
                requireJobCapacity(state)
                // Fishing randomness is server-owned, unlike the client idempotency request ID.
                val id = if (special) UUID.randomUUID().toString() else command.requestId
                val seed = if (special) state.fishingCastSeed ?: UUID.randomUUID().toString() else state.fishingCastSeed
                val draws = if (special) exploration.rewards.getValue("fish").toInt() else 0
                val catches = (0 until draws).map { index -> selectFishingCatch(checkNotNull(seed), tackle.equippedRodId, tackle.equippedBaitId, tackle.equippedHookId, index) }
                val fishingCatch = if (special) EconomyFishingCatch(tackle.equippedRodId, tackle.equippedBaitId,
                    catches.first(), tackle.equippedHookId) else null
                val rewards = exploration.rewards.toMutableMap()
                if (special) {
                    rewards["fish"] = rewards.getValue("fish") - draws
                    catches.forEach { fishId -> rewards[fishId] = (rewards[fishId] ?: 0) + 1 }
                }
                val meal = if (mining) null else EconomyFood.pendingMeal(state, "hero")
                val tripSeconds = EconomyFood.mealDuration(exploration.seconds, meal?.speedBps ?: 0)
                val rare = catalog.rareDrops?.takeIf { (state.buildings["home"] ?: 1) >= it.requiredHomeLevel }
                    ?.let { EconomyRareDrops.prepare(if (mining) state.minerRareDropState else state.rareDropState, tripSeconds, it) }
                rare?.let { rewards.putAll(it.rewards) }
                val cost = if (special && tackle.equippedBaitId != null) exploration.cost.copy(items = exploration.cost.items +
                    (tackle.equippedBaitId to ((exploration.cost.items[tackle.equippedBaitId] ?: 0) + 1))) else exploration.cost
                val job = EconomyJob(id, "exploration", exploration.id, startedAt = now.toString(),
                    finishesAt = now.plusSeconds(tripSeconds).toString(), rewards = rewards.filterValues { it > 0 }, cost = cost,
                    catalogVersion = catalog.version, fishing = fishingCatch, rareDrop = rare?.delivery, meal = meal,
                    actorId = if (mining) "miner" else "mochlik")
                requireRewardCapacity(state, job.rewards)
                spend(state, cost).copy(jobs = state.jobs + job, fishingCastSeed = seed,
                    food = if (meal == null) state.food else state.food.copy(heroMeal = null),
                    rareDropState = if (mining) state.rareDropState else rare?.clock ?: state.rareDropState,
                    minerRareDropState = if (mining) rare?.clock ?: state.minerRareDropState else state.minerRareDropState) to
                    if (mining) "Шахтёр начал работу" else if (special) "Мохлик отправился рыбачить. Снасти и наживка подготовлены" else "Мохлик отправился на исследование"
            }
            "cancel_production" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (job.kind != "production" || !productionStationSupported(job.targetId))
                    economyFailure("ECONOMY_CANCEL_KIND", "Можно отменить только обычное производство")
                if (!now.isBefore(Instant.parse(job.finishesAt)) || job.collection?.startedAt != null)
                    economyFailure("ECONOMY_CANCEL_READY", "Готовое производство уже нельзя отменить. Заберите результат")
                if (job.cost.coins > ECONOMY_MAX_BALANCE - state.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
                // Saved paid terms include the selected fish and survive catalog updates.
                val refunded = EconomyFishStock.credit(state.copy(wallet = state.wallet.copy(coins = state.wallet.coins + job.cost.coins),
                    inventory = addItems(state.inventory, job.cost.items), jobs = state.jobs.filterNot { it.id == job.id }), EconomyFishStock.within(job.fishStockCost ?: job.cost.items, job.cost.items))
                addItems(refunded.inventory, reservedItems)
                assertStorageTransition(state, refunded, reservedItems)
                refunded to "Производство отменено. Потраченные монеты и материалы возвращены"
            }
            "cancel_exploration" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (job.kind != "exploration") economyFailure("ECONOMY_CANCEL_KIND", "Можно отменить только вылазку или работу в шахте")
                if (isMinerJob(job)) {
                    if (job.cost.coins > ECONOMY_MAX_BALANCE - state.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
                    val refunded = state.copy(wallet = state.wallet.copy(coins = state.wallet.coins + job.cost.coins),
                        inventory = addItems(state.inventory, job.cost.items), jobs = state.jobs.filterNot { it.id == job.id })
                    assertStorageTransition(state, refunded, reservedItems)
                    return refunded to "Работа шахтёра отменена. Внесённые припасы возвращены"
                }
                // Unclaimed rewards and already spent provisions are forfeited,
                // including after the timer ends. This is not a completed trip.
                state.copy(jobs = state.jobs.filterNot { it.id == job.id }) to
                    "Вылазка отменена. Добыча потеряна, потраченные припасы не возвращаются"
            }
            "start_tutorial_workshop", "start_construction" -> {
                val tutorialWorkshop = command.action == "start_tutorial_workshop"
                if (tutorialWorkshop && command.targetId != "workshop") invalidEconomy()
                if (tutorialWorkshop && !EconomyWorkshopStarter.canStartTutorialWorkshop(state))
                    economyFailure("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", "Помощь для первой мастерской уже использована или стройка началась")
                val building = catalog.buildings.find { it.id == command.targetId } ?: economyFailure("ECONOMY_BUILDING", "Здание не найдено")
                val next = (state.buildings[building.id] ?: 0) + 1
                val upgrade = building.levels.find { it.level == next } ?: economyFailure("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены")
                requireHome(state, upgrade.requiredHomeLevel)
                if (building.id == "home" && next == 2 && state.tutorialOrder.version != 1 && !state.tutorialOrder.completed)
                    economyFailure("ECONOMY_TUTORIAL_REQUIRED", "Сначала выполните первый заказ с Шишколапом")
                if (building.id == "home" && EconomyStageOrders.required(state, next))
                    economyFailure("ECONOMY_STAGE_REQUIRED", "Сначала выполните заказы текущего этапа")
                requireBuildings(state, upgrade.requiredBuildings)
                if (state.jobs.any { it.kind == "construction" }) economyFailure("ECONOMY_CONSTRUCTION_BUSY", "Строитель занят. Сначала завершите текущую стройку")
                if (building.id == "quarry" && state.jobs.any { job -> isMinerJob(job) || job.kind == "exploration" && catalog.explorations.any { it.id == job.targetId && it.requiredBuildings.containsKey("quarry") } })
                    economyFailure("ECONOMY_BUILDING_BUSY", "Перед улучшением дождитесь окончания добычи и заберите результат")
                if (state.jobs.any { it.kind == "production" && it.targetId == building.id }) economyFailure("ECONOMY_BUILDING_BUSY", "Получите результат производства перед улучшением")
                requireJobCapacity(state)
                val meal = EconomyFood.pendingMeal(state, "builder")
                val cost = if (tutorialWorkshop) EconomyCost(0, emptyMap()) else upgrade.cost
                val job = EconomyJob(command.requestId, "construction", building.id, targetLevel = next,
                    startedAt = now.toString(), finishesAt = now.plusSeconds(EconomyFood.mealDuration(upgrade.seconds, meal?.speedBps ?: 0)).toString(),
                    cost = cost, catalogVersion = catalog.version, meal = meal)
                // The aid is earmarked for this job, without changing inventory,
                // reserved market stock or a legacy negative coin balance.
                val funded = if (tutorialWorkshop) state else spend(state, cost)
                funded.copy(jobs = state.jobs + job, workshopStarterClaimed = state.workshopStarterClaimed || tutorialWorkshop,
                    food = if (meal == null) state.food else state.food.copy(builderMeal = null)) to
                    if (tutorialWorkshop) "Учебные материалы переданы Шишколапу, строительство мастерской началось" else "Материалы внесены, строительство началось"
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
            "claim_garden_collection" -> {
                val jobs = state.jobs.filter { it.collection?.batchId == command.targetId }
                if (jobs.isEmpty()) economyFailure("ECONOMY_JOB_GONE", "Урожай уже получен или сбор не найден")
                jobs.forEach { requireClaimReady(it, now) }
                val projected = state.copy(inventory = jobs.fold(state.inventory) { inventory, job -> addItems(inventory, job.rewards) })
                addItems(projected.inventory, reservedItems)
                assertStorageTransition(state, projected, reservedItems)
                jobs.fold(state) { next, job -> claimJob(next, job, now, reservedItems) } to "Весь собранный урожай доставлен на склад"
            }
            "claim_job" -> {
                val job = state.jobs.find { it.id == command.targetId } ?: economyFailure("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено")
                if (job.collection?.batchId != null) economyFailure("ECONOMY_COLLECTION_BATCH_REQUIRED", "Заберите весь собранный урожай вместе")
                claimJob(state, job, now, reservedItems) to
                    if (job.kind == "construction") "Строительство завершено" else "Припасы доставлены на склад"
            }
            "buy_market_slot" -> {
                if (!EconomyMarketRules.unlocked(state))
                    economyFailure("ECONOMY_MARKET_LOCKED", "Сначала улучшите дом до второго уровня и восстановите мост")
                val offer = marketSlotOffer(state) ?: economyFailure("MARKET_SLOTS_MAX", "Все места рынка уже открыты")
                if (command.targetId != offer.targetId) economyFailure("MARKET_SLOT_CHANGED", "Количество мест изменилось. Проверьте предложение")
                if (command.totalPrice != offer.pricePearls) economyFailure("MARKET_SLOT_PRICE_CHANGED", "Цена места изменилась. Проверьте предложение")
                if (state.wallet.pearls < offer.pricePearls) economyFailure("ECONOMY_PEARLS", "Не хватает жемчужин для места рынка")
                state.copy(marketSlots = offer.slots, wallet = state.wallet.copy(pearls = state.wallet.pearls - offer.pricePearls)) to
                    "Новое место рынка открыто"
            }
            "buy_leaftail_item" -> EconomyLeaftailShops.buy(state, command, now, reservedItems)
            "refresh_fishing_shop" -> {
                val shop = state.fishingShop
                val spec = catalog.fishing?.shop
                if (shop == null || spec == null || shop.id != command.targetId || EconomyFishingShops.expired(shop, now))
                    economyFailure("ECONOMY_FISHING_SHOP_CHANGED", "Предложения обновились. Загляните в лавку ещё раз")
                val price = EconomyFishingShops.refreshPrice(shop, now, spec)
                if (price > command.totalPrice) economyFailure("ECONOMY_FISHING_PRICE_CHANGED", "Цена обновления изменилась. Проверьте предложение Плёски")
                if (state.wallet.pearls < price) economyFailure("ECONOMY_PEARLS", "Не хватает жемчужин для обновления лавки")
                val nextShop = EconomyFishingShops.refresh(state, now)
                    ?: economyFailure("ECONOMY_FISHING_SHOP_NO_REPLACEMENT", "Плёска ждёт новую поставку. Жемчужины не потрачены")
                state.copy(wallet = state.wallet.copy(pearls = state.wallet.pearls - price),
                    fishingShop = nextShop) to "Плёска подготовила новые предложения"
            }
            "buy_wardrobe_item" -> {
                val item = WorldRules.catalog.items.find { it.slot != "rod" && it.purchase != null &&
                    "${it.purchase.currency}:${it.id}" == command.targetId }
                    ?: economyFailure("ECONOMY_WARDROBE_ITEM", "Эта вещь не продаётся")
                val price = checkNotNull(item.purchase)
                if (item.starter || item.id in state.wardrobe) economyFailure("ECONOMY_WARDROBE_OWNED", "Эта вещь уже есть в гардеробе")
                if (command.totalPrice != price.amount) economyFailure("ECONOMY_WARDROBE_PRICE_CHANGED", "Цена изменилась. Проверьте стоимость вещи")
                val balance = if (price.currency == "pearls") state.wallet.pearls else state.wallet.coins
                if (balance < price.amount) economyFailure("ECONOMY_RESOURCES", if (price.currency == "pearls") "Не хватает жемчужин" else "Не хватает монет")
                val wallet = if (price.currency == "pearls") state.wallet.copy(pearls = balance - price.amount)
                    else state.wallet.copy(coins = balance - price.amount)
                state.copy(wallet = wallet, wardrobe = (state.wardrobe + item.id).distinct().sorted()) to "${item.name} теперь в гардеробе"
            }
            "buy_fishing_item" -> {
                val spec = catalog.fishing ?: economyFailure("ECONOMY_FISHING_ITEM", "Лавка Плёски пока недоступна")
                val shop = state.fishingShop
                if (shop == null || EconomyFishingShops.expired(shop, now))
                    economyFailure("ECONOMY_FISHING_SHOP_CHANGED", "Предложения обновились. Загляните в лавку ещё раз")
                val offer = shop.offers.find { it.id == command.targetId }
                    ?: economyFailure("ECONOMY_FISHING_SHOP_CHANGED", "Этого предложения уже нет. Загляните в лавку ещё раз")
                val rod = spec.rods.find { offer.kind == "rod" && it.id == offer.itemId }
                val hook = spec.hooks.find { offer.kind == "hook" && it.id == offer.itemId }
                val bait = spec.baits.find { offer.kind == "bait" && it.itemId == offer.itemId }
                val fish = spec.classes.find { offer.kind == "fish" && it.itemId == offer.itemId && it.rarity == "common" }
                if (rod == null && hook == null && bait == null && fish == null) economyFailure("ECONOMY_FISHING_ITEM", "Плёска не продаёт этот предмет")
                requireHome(state, rod?.requiredHomeLevel ?: hook?.requiredHomeLevel ?: bait?.requiredHomeLevel ?: 1)
                if (command.quantity > catalog.maxBatch || (rod != null || hook != null) && command.quantity != 1L) invalidEconomy()
                if (rod != null && rod.id in state.fishing.ownedRods) economyFailure("ECONOMY_FISHING_OWNED", "Эта удочка уже есть в коллекции")
                if (hook != null && hook.id in state.fishing.ownedHooks) economyFailure("ECONOMY_FISHING_OWNED", "Этот крючок уже есть в коллекции")
                if (command.quantity > offer.remaining) economyFailure("ECONOMY_FISHING_STOCK", "Плёска уже продала эту партию. Дождитесь новых предложений")
                val price = offer.unitPrice * command.quantity
                if (price > command.totalPrice) economyFailure("ECONOMY_FISHING_PRICE_CHANGED", "Цена изменилась. Проверьте предложение Плёски")
                val spent = spend(state, EconomyCost(coins = price))
                val next = if (rod != null) spent.copy(fishing = state.fishing.copy(ownedRods = state.fishing.ownedRods + rod.id))
                    else if (hook != null) spent.copy(fishing = state.fishing.copy(ownedHooks = state.fishing.ownedHooks + hook.id))
                    else spent.copy(inventory = addItems(spent.inventory, mapOf(offer.itemId to command.quantity)))
                addItems(next.inventory, reservedItems)
                assertStorageTransition(state, next, reservedItems)
                next.copy(fishingShop = shop.copy(offers = shop.offers.map {
                    if (it.id == offer.id) it.copy(remaining = it.remaining - command.quantity) else it
                })) to if (rod != null) "Удочка добавлена в коллекцию" else if (hook != null) "Крючок добавлен в коллекцию" else "Покупка у Плёски отправлена на склад"
            }
            "equip_fishing_rod" -> {
                if (catalog.fishing?.rods?.none { it.id == command.targetId } != false || command.targetId !in state.fishing.ownedRods)
                    economyFailure("ECONOMY_FISHING_ROD", "Сначала приобретите эту удочку")
                val bait = state.fishing.equippedBaitId.takeIf { fishingBaitCompatible(command.targetId, it) }
                state.copy(fishing = state.fishing.copy(equippedRodId = command.targetId, equippedBaitId = bait)) to "Удочка выбрана для следующих вылазок"
            }
            "equip_fishing_hook" -> {
                val hook = catalog.fishing?.hooks?.find { it.id == command.targetId }
                if (hook == null || hook.id !in state.fishing.ownedHooks) economyFailure("ECONOMY_FISHING_HOOK", "Сначала приобретите этот крючок")
                state.copy(fishing = state.fishing.copy(equippedHookId = hook.id)) to "Крючок выбран для следующих вылазок"
            }
            "equip_fishing_bait" -> {
                val baitId = command.targetId.takeUnless { it == "none" }
                if (baitId != null && catalog.fishing?.baits?.none { it.itemId == baitId } != false)
                    economyFailure("ECONOMY_FISHING_BAIT", "Наживка не найдена")
                requireFishingBaitCompatible(state.fishing.equippedRodId, baitId)
                if (baitId != null && (state.inventory[baitId] ?: 0) <= 0) economyFailure("ECONOMY_RESOURCES", "Сначала приобретите эту наживку")
                state.copy(fishing = state.fishing.copy(equippedBaitId = baitId)) to
                    if (baitId == null) "Выбрана рыбалка без наживки" else "Наживка выбрана: одна порция на следующую вылазку"
            }
            "sell", "sell_fish" -> {
                val itemId = EconomyFishInventory.itemId(command.targetId)
                if (command.action == "sell_fish" && catalog.fishing?.classes?.none { it.itemId == itemId } != false)
                    economyFailure("ECONOMY_FISHING_ITEM", "Плёска принимает здесь только рыбу")
                val item = catalog.items.find { it.id == itemId && it.tradable && it.category != "special" } ?: economyFailure("ECONOMY_ITEM", "Этот предмет нельзя продать")
                val amount = if (command.action == "sell_fish") item.baseSellPrice * command.quantity
                    else localSellPrice(item.baseSellPrice, command.quantity, itemId = item.id)
                if (amount == 0L) economyFailure("ECONOMY_SALE_QUANTITY", "Для продажи добавьте предметы в партию: выручка должна быть хотя бы одна монета")
                if (command.action == "sell" && amount < command.totalPrice)
                    economyFailure("ECONOMY_SALE_PRICE_CHANGED", "Выручка изменилась. Проверьте цену продажи и подтвердите снова")
                if (amount > ECONOMY_MAX_BALANCE - state.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
                val spent = spend(state, EconomyCost(items = mapOf(item.id to command.quantity)), command.fishSelection)
                spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + amount)) to "Товары проданы за $amount монет"
            }
            else -> invalidEconomy()
        }
    }
}
