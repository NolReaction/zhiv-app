package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import ru.zhiv.http.parseCanonicalUuidV4
import java.time.Instant

internal val economyJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }
const val ECONOMY_MAX_BALANCE = 10_000_000_000L
const val ECONOMY_MAX_REVISION = 9_007_199_254_740_991L
internal val economyBerryItemIds = setOf("berries", "strawberries", "blueberries", "currants", "blackberries", "cranberries")

@Serializable data class EconomyWallet(val coins: Long = 0, val pearls: Long = 0)
@Serializable data class EconomyCost(val coins: Long = 0, val items: Map<String, Long> = emptyMap())
@Serializable data class EconomyMigration(val version: Int = 1, val coinsGranted: Long, val woodGranted: Long, val stoneGranted: Long)
@Serializable data class EconomyCollectionSpec(val kind: String, val seconds: Long) {
    init { require(kind == "berry_harvest" && seconds in 1L..120L) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCollection(
    val kind: String, val seconds: Long, val startedAt: String?, val finishesAt: String?,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val batchId: String? = null,
) {
    init {
        require(kind == "berry_harvest" && seconds in 1L..120L)
        require((startedAt == null) == (finishesAt == null))
        require(batchId == null || startedAt != null && parseCanonicalUuidV4(batchId) != null)
        if (startedAt != null && finishesAt != null)
            require(!Instant.parse(finishesAt).isBefore(Instant.parse(startedAt).plusSeconds(seconds)))
    }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyFishing(
    val ownedRods: List<String> = listOf("reed_rod"), val equippedRodId: String = "reed_rod",
    val equippedBaitId: String? = null, val catches: Map<String, Long> = emptyMap(),
    val ownedHooks: List<String> = listOf("bare_hook"), val equippedHookId: String = "bare_hook",
    @EncodeDefault(EncodeDefault.Mode.NEVER) val stock: Map<String, Long>? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val escrow: Map<String, Map<String, Long>>? = null,
)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyFishingCatch(val rodId: String, val baitId: String?, val fishId: String, val hookId: String = "bare_hook",
    @EncodeDefault(EncodeDefault.Mode.NEVER) val catchRevealed: Boolean? = null)
@Serializable data class EconomyFishClass(val rarity: String, val itemId: String, val weight: Int, val buyPrice: Long)
@Serializable data class EconomyFishSpec(val itemId: String, val description: String, val rarity: String,
    val weight: Int? = null, val affinity: Int? = null, val buyPrice: Long, val requiredHookId: String? = null)
@Serializable data class EconomyRodSpec(val id: String, val name: String, val description: String, val price: Long, val rareBonus: Int = 0,
    val rarity: String = "common", val requiredHomeLevel: Int = 1, val rarityWeights: Map<String, Int>? = null,
    val classOddsBps: Map<String, Int>? = null, val shop: String = "plesk", val speciesWeights: Map<String, Int>? = null) {
    init { require(shop in setOf("plesk", "leaftail")) }
    init { require(speciesWeights == null || speciesWeights.size <= 100 && speciesWeights.values.all { it in 1..1000 }) }
    init {
        require(classOddsBps == null || (classOddsBps.keys == setOf("common", "uncommon", "rare", "epic", "legendary") &&
            classOddsBps.values.all { it in 0..10000 } && classOddsBps.values.sum() == 10000))
    }
}
@Serializable data class EconomyHookSpec(val id: String, val name: String, val description: String, val price: Long, val rareBonus: Int = 0,
    val rarity: String = "common", val requiredHomeLevel: Int = 1, val rarityWeights: Map<String, Int>? = null, val shop: String = "plesk",
    val speciesWeights: Map<String, Int>? = null) {
    init { require(shop in setOf("plesk", "leaftail")) }
    init { require(speciesWeights == null || speciesWeights.size <= 100 && speciesWeights.values.all { it in 1..1000 }) }
}
@Serializable data class EconomyBaitSpec(val itemId: String, val description: String, val price: Long, val rareBonus: Int = 0,
    val rarity: String = "common", val requiredHomeLevel: Int = 1, val rarityWeights: Map<String, Int>? = null, val shop: String = "plesk") {
    init { require(shop in setOf("plesk", "leaftail")) }
}
@Serializable data class EconomyFishingOffer(val id: String, val kind: String, val itemId: String, val unitPrice: Long, val remaining: Long)
@Serializable data class EconomyFishingShop(val id: String, val openedAt: String, val refreshAt: String, val refreshPricePearls: Long, val offers: List<EconomyFishingOffer>)
@Serializable data class EconomyLeaftailShopState(val cycle: Long = -1, val purchased: Map<String, Int> = emptyMap()) {
    init { require(cycle in -1L..ECONOMY_MAX_REVISION && purchased.all { (id, amount) -> id.length in 1..80 && amount in 0..100 }) }
}
@Serializable data class EconomyLeaftailOffer(val id: String, val itemId: String, val priceCoins: Long, val stock: Int = 1, val quantity: Long = 1,
    val kind: String = "item", val requiredHomeLevel: Int = 1) {
    init { require(kind in setOf("item", "wardrobe", "rod", "hook", "bait") && requiredHomeLevel in 1..5) }
    init { require(id.length in 1..60 && itemId.length in 1..80 && priceCoins in 1L..ECONOMY_MAX_BALANCE && stock == 1 && quantity in 1L..100L) }
}
@Serializable data class EconomyLeaftailSupplyOffer(val id: String, val itemId: String, val unitPriceCoins: Long,
    val stock: Int, val requiredHomeLevel: Int = 1) {
    init { require(id.length in 1..60 && itemId.length in 1..80 && unitPriceCoins in 1L..ECONOMY_MAX_BALANCE && stock in 1..100 && requiredHomeLevel in 1..5) }
}
@Serializable data class EconomyLeaftailPearlOffer(val id: String, val itemId: String, val pricePearls: Long,
    val stock: Int = 1, val requiredHomeLevel: Int = 1) {
    init { require(id.length in 1..60 && itemId.length in 1..80 && pricePearls in 1L..ECONOMY_MAX_BALANCE && stock == 1 && requiredHomeLevel in 1..5) }
}
@Serializable data class EconomyLeaftailRelicExchangeConfig(val requiredHomeLevel: Int, val quantity: Long, val priceCoins: Long) {
    init { require(requiredHomeLevel in 4..5 && quantity in 2L..100L && priceCoins in 1L..ECONOMY_MAX_BALANCE) }
}
@Serializable data class EconomyLeaftailShopConfig(val requiredHomeLevel: Int, val refreshSeconds: Long, val offers: List<EconomyLeaftailOffer>,
    val travelOffers: List<EconomyLeaftailOffer> = emptyList(),
    val supplyOffers: List<EconomyLeaftailSupplyOffer> = emptyList(), val pearlOffers: List<EconomyLeaftailPearlOffer> = emptyList(),
    val relicExchange: EconomyLeaftailRelicExchangeConfig? = null) {
    init {
        require(requiredHomeLevel in 1..5 && refreshSeconds == 86400L && offers.size in 1..12 && offers.all { it.kind == "item" })
        val combined = offers + travelOffers
        require(combined.size <= 32 && combined.map { it.id }.distinct().size == combined.size &&
            combined.map { "${it.kind}:${it.itemId}" }.distinct().size == combined.size)
        val allIds = combined.map { it.id } + supplyOffers.map { it.id } + pearlOffers.map { it.id }
        require(supplyOffers.size <= 32 && pearlOffers.size <= 12 && allIds.size <= 64 && allIds.distinct().size == allIds.size)
        require((supplyOffers.map { it.itemId } + pearlOffers.map { it.itemId }).distinct().size == supplyOffers.size + pearlOffers.size)
        val effective = (if (supplyOffers.isNotEmpty()) supplyOffers.map { "item:${it.itemId}" } else offers.map { "${it.kind}:${it.itemId}" }) +
            travelOffers.map { "${it.kind}:${it.itemId}" } + pearlOffers.map { "item:${it.itemId}" }
        require(effective.size <= 48 && effective.distinct().size == effective.size)
    }
}
internal val fishingShopRarities = listOf("common", "uncommon", "rare", "epic", "legendary")
private fun fishingShopDefaultGearRarityBps() = listOf(
    mapOf("common" to 0, "uncommon" to 10000, "rare" to 0, "epic" to 0, "legendary" to 0),
    mapOf("common" to 0, "uncommon" to 9000, "rare" to 1000, "epic" to 0, "legendary" to 0),
    mapOf("common" to 0, "uncommon" to 8350, "rare" to 1400, "epic" to 250, "legendary" to 0),
    mapOf("common" to 0, "uncommon" to 7800, "rare" to 1700, "epic" to 480, "legendary" to 20),
    mapOf("common" to 0, "uncommon" to 7000, "rare" to 2250, "epic" to 700, "legendary" to 50),
)
@Serializable data class EconomyFishingShopConfig(
    val refreshSeconds: Long = 21600, val refreshPricePearls: Long = 100, val refreshPriceStepPearls: Long = 2, val slots: Int = 4,
    val baitStock: Long = 5, val fishStock: Long = 3, val fishPriceBps: Int = 8000,
    val gearRarityBpsByHome: List<Map<String, Int>> = fishingShopDefaultGearRarityBps(),
) {
    init {
        require(refreshSeconds in 1L..86400L && refreshPricePearls in 1L..ECONOMY_MAX_BALANCE && slots == 4)
        require(refreshPriceStepPearls in 1L..refreshPricePearls)
        require(baitStock in 1L..100L && fishStock in 1L..100L && fishPriceBps in 1..9999)
        require(gearRarityBpsByHome.size == 5 && gearRarityBpsByHome.all { row ->
            row.keys == fishingShopRarities.toSet() && row.values.all { it in 0..10000 } && row.values.sum() == 10000
        })
    }
}
@Serializable data class EconomyFishingCatalog(val routeIds: List<String>, val fish: List<EconomyFishSpec>,
    val rods: List<EconomyRodSpec>, val baits: List<EconomyBaitSpec>, val shop: EconomyFishingShopConfig = EconomyFishingShopConfig(),
    val hooks: List<EconomyHookSpec> = listOf(EconomyHookSpec("bare_hook", "Простой крючок", "Начальная снасть без дополнительных усилений.", 0, 0)),
    val collectionDrawsByRoute: Map<String, Int> = emptyMap(), val classes: List<EconomyFishClass> = emptyList())
@Serializable data class EconomyRareDropSpec(val version: Int = 1, val requiredHomeLevel: Int,
    val minSeconds: Long, val maxSeconds: Long, val itemIds: List<String>) {
    init { require(version == 1 && requiredHomeLevel in 1..5 && minSeconds in 1L..31_536_000L && maxSeconds in minSeconds..31_536_000L
        && itemIds.size == 3 && itemIds.distinct().size == itemIds.size) }
}
@Serializable data class EconomyRareDropClock(val version: Int = 1, val remainingSeconds: Long, val itemId: String)
@Serializable data class EconomyRareDropDelivery(val version: Int = 1, val seconds: Long, val itemId: String? = null) {
    init { require(version == 1 && seconds > 0) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyJob(
    val id: String, val kind: String, val targetId: String, val recipeId: String? = null,
    val targetLevel: Int? = null, val startedAt: String, val finishesAt: String,
    val rewards: Map<String, Long> = emptyMap(), val cost: EconomyCost = EconomyCost(), val catalogVersion: Int = 1,
    val collection: EconomyCollection? = null, val fishing: EconomyFishingCatch? = null, val rareDrop: EconomyRareDropDelivery? = null,
    val meal: EconomyJobMeal? = null, val actorId: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val tradeSpeedBps: Int = 0,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val fishStockCost: Map<String, Long>? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val expeditionFinds: Map<String, Long>? = null,
) {
    init {
        require(actorId == null || kind == "exploration" && actorId in setOf("mochlik", "miner"))
        require(tradeSpeedBps in 0..1000)
        require(tradeSpeedBps == 0 || kind == "construction" || kind == "production" && targetId == "woodlot" || kind == "exploration" && actorId == "miner")
        require(collection == null || kind == "production" && targetId == "garden" &&
            rewards.any { (id, quantity) -> id in economyBerryItemIds && quantity > 0L })
        require(rareDrop == null || kind == "exploration" && (rareDrop.itemId == null || rewards[rareDrop.itemId] == 1L))
        require(meal == null || (meal.consumer == "hero" && kind == "exploration" || meal.consumer == "builder" && kind == "construction"))
        require(expeditionFinds == null || kind == "exploration" && expeditionFinds.all { (id, count) -> id.matches(Regex("[a-z0-9_]{1,80}")) && count in 1L..ECONOMY_MAX_ITEMS })
    }
}
@Serializable data class EconomyBookCollection(
    val finds: List<String> = emptyList(), val travelSeconds: Long = 0, val quarrySeconds: Long = 0,
)
@Serializable data class EconomyProgression(
    val routes: Map<String, Long> = emptyMap(), val recipes: Map<String, Long> = emptyMap(),
    val collections: EconomyBookCollection = EconomyBookCollection(),
)
@Serializable data class EconomyState(
    val schemaVersion: Int = 1, val wallet: EconomyWallet, val inventory: Map<String, Long>,
    val buildings: Map<String, Int>, val jobs: List<EconomyJob> = emptyList(), val migration: EconomyMigration,
    val completedExplorations: Long = 0, val fishing: EconomyFishing = EconomyFishing(),
    val fishingCastSeed: String? = null, val progression: EconomyProgression = EconomyProgression(),
    val wardrobe: List<String> = listOf("moss", "amber_scarf"),
    val rareDropState: EconomyRareDropClock? = null, val minerRareDropState: EconomyRareDropClock? = null,
    val fishingShop: EconomyFishingShop? = null, val currencyScale: Int = 1, val pearlScale: Int? = null,
    val productionSlots: Map<String, Int> = emptyMap(),
    val food: EconomyFoodState = EconomyFoodState(), val residentOrders: EconomyResidentOrders = EconomyResidentOrders(),
    val tradeRelations: EconomyTradeRelationsState = EconomyTradeRelationsState(),
    val workshopStarterClaimed: Boolean = false, val tutorialOrder: EconomyTutorialOrder = EconomyTutorialOrder(),
    val stageOrders: EconomyStageOrderState = EconomyStageOrderState(),
    val marketSlots: Int = 5, val unlockedItems: List<String> = emptyList(), val itemUnlockVersion: Int = 0,
    val leaftailShop: EconomyLeaftailShopState = EconomyLeaftailShopState(),
) { init { require(marketSlots in 5..10 && unlockedItems.distinct().size == unlockedItems.size && itemUnlockVersion in 0..1) } }
@Serializable data class EconomyItem(val id: String, val name: String, val category: String, val baseSellPrice: Long, val tradable: Boolean = true)
@Serializable data class EconomyBuildingLevel(
    val level: Int, val seconds: Long, val cost: EconomyCost, val requiredHomeLevel: Int = 1,
    val requiredBuildings: Map<String, Int> = emptyMap(), val warehouseCapacity: Long? = null,
)
@Serializable data class EconomyBuilding(val id: String, val name: String, val description: String, val levels: List<EconomyBuildingLevel>)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyRecipe(
    val id: String, val name: String, val buildingId: String, val buildingLevel: Int = 1,
    val requiredHomeLevel: Int = 1, val seconds: Long, val cost: EconomyCost = EconomyCost(), val rewards: Map<String, Long>,
    val requiredBuildings: Map<String, Int> = emptyMap(), val collection: EconomyCollectionSpec? = null,
    val maxBatch: Int? = null, val fishInput: EconomyRecipeFishInput? = null,
    val requiredRecipes: Map<String, Long> = emptyMap(),
    // Older clients accept an omitted flag, but reject an explicit null.
    @EncodeDefault(EncodeDefault.Mode.NEVER) val baseCampfire: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val retired: Boolean = false,
) {
    init {
        require(buildingLevel > 0)
        require(baseCampfire == null || baseCampfire == true && id == "cook_grilled_fish" && buildingId == "dryer" && buildingLevel == 1)
        require(collection == null || buildingId == "garden" &&
            rewards.any { (id, quantity) -> id in economyBerryItemIds && quantity > 0L })
    }
    val effectiveBuildingLevel: Int get() = if (baseCampfire == true) 0 else buildingLevel
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyExploration(
    val id: String, val name: String, val description: String, val requiredHomeLevel: Int = 1,
    val seconds: Long, val cost: EconomyCost = EconomyCost(), val rewards: Map<String, Long>,
    val requiredBuildings: Map<String, Int> = emptyMap(), val activity: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val retired: Boolean = false,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val finds: EconomyExpeditionFinds? = null,
) { init { require(activity == null || activity == "mining") } }
@Serializable data class EconomyMarketConfig(val requiredHomeLevel: Int = 2, val requiredExplorations: Long = 1, val maxListings: Int = 10, val maxLotQuantity: Long = 99, val maxPriceMultiplier: Long = 2, val feeBps: Int = 500,
    val showcaseSlots: Int = 12, val showcasePerSeller: Int = 2, val showcaseRefreshSeconds: Long = 300,
    val dailyTradeValueByHome: List<Long> = listOf(0, 2400, 4800, 9600, 14400),
    val baseSlots: Int = 5, val slotPricesPearls: List<Long> = emptyList(),
    val requiredBuildings: Map<String, Int> = emptyMap()) {
    init {
        require(showcaseSlots in 1..12 && showcasePerSeller in 1..10 && showcaseRefreshSeconds in 1L..86400L)
        require(feeBps in 0..10000 && dailyTradeValueByHome.size == 5 && dailyTradeValueByHome.all { it in 0L..ECONOMY_MAX_BALANCE })
        require(baseSlots == 5 && maxListings == 10 && (slotPricesPearls.isEmpty() ||
            slotPricesPearls.size == maxListings - baseSlots && slotPricesPearls.all { it in 1L..ECONOMY_MAX_PEARLS }))
    }
}
@Serializable data class EconomyLocalBuyer(val payoutBps: Int = 10_000, val unitPrices: Map<String, Long> = emptyMap())
@Serializable data class EconomyTimePricePoint(val seconds: Long, val pearls: Long)
@Serializable data class EconomyConstructionSpeedup(val secondsPerPearl: Long, val priceStepPearls: Long = 2,
    val pricingPoints: List<EconomyTimePricePoint> = emptyList())
@Serializable data class EconomyProductionSlotUpgrade(val slots: Int, val requiredHomeLevel: Int, val pricePearls: Long) {
    init { require(slots in 2..3 && requiredHomeLevel in 1..5 && pricePearls in 1L..ECONOMY_MAX_PEARLS) }
}
@Serializable data class EconomyProductionSlots(val upgrades: List<EconomyProductionSlotUpgrade> = emptyList()) {
    init { require(upgrades.size <= 2 && upgrades.withIndex().all { (index, upgrade) -> upgrade.slots == index + 2 }) }
}
/** Reference technologies price occupied work, independently of the player's bonuses. */
@Serializable data class EconomyTimeEconomy(
    val version: Int, val coinsPerMinute: Long, val constructionCoinsPerMinute: Long, val orderBonusBps: Int,
    val baselineRecipes: Map<String, String>, val baselineExplorations: Map<String, String>,
    val externalPrices: Map<String, Long>,
) {
    init {
        require(version == 1 && coinsPerMinute in 1L..1_000_000L && constructionCoinsPerMinute in 1L..1_000_000L && orderBonusBps in 0..10_000)
        require(externalPrices.values.all { it in 0L..ECONOMY_MAX_BALANCE })
    }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCatalog(
    val version: Int, val maxBatch: Int, val items: List<EconomyItem>, val buildings: List<EconomyBuilding>,
    val recipes: List<EconomyRecipe>, val explorations: List<EconomyExploration>, val market: EconomyMarketConfig = EconomyMarketConfig(),
    val constructionSpeedup: EconomyConstructionSpeedup, val fishing: EconomyFishingCatalog? = null,
    val localBuyer: EconomyLocalBuyer = EconomyLocalBuyer(),
    val rareDrops: EconomyRareDropSpec? = null, val currencyScale: Int = 10, val pearlScale: Int = 50,
    val productionSlots: EconomyProductionSlots = EconomyProductionSlots(),
    val food: EconomyFoodCatalog? = null, val onboarding: EconomyOnboardingCatalog? = null,
    val stageOrders: List<EconomyStageOrderCourse> = emptyList(),
    val leaftailShop: EconomyLeaftailShopConfig? = null,
    val tradeRelations: EconomyTradeRelationsCatalog? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val timeEconomy: EconomyTimeEconomy? = null,
)
@Serializable data class EconomyStorage(
    val capacity: Long, val used: Long, val reserved: Long, val available: Long, val overflow: Long,
)
@Serializable data class EconomyView(
    val ownerPublicId: String, val revision: Long, val serverTime: String,
    val wallet: EconomyWallet, val inventory: Map<String, Long>, val buildings: Map<String, Int>,
    val jobs: List<EconomyJob>, val migration: EconomyMigration, val catalog: EconomyCatalog,
    val storage: EconomyStorage, val completedExplorations: Long = 0, val fishing: EconomyFishing = EconomyFishing(),
    val progression: EconomyProgression = EconomyProgression(), val wardrobe: List<String> = listOf("moss", "amber_scarf"), val fishingShop: EconomyFishingShop? = null, val currencyScale: Int = 10, val pearlScale: Int = 50,
    val productionSlots: Map<String, Int> = emptyMap(),
    val food: EconomyFoodState = EconomyFoodState(), val residentOrders: EconomyResidentOrders = EconomyResidentOrders(),
    val tradeRelations: EconomyTradeRelationsState = EconomyTradeRelationsState(),
    val workshopStarterClaimed: Boolean = false, val tutorialOrder: EconomyTutorialOrder = EconomyTutorialOrder(),
    val stageOrders: EconomyStageOrderState = EconomyStageOrderState(),
    val marketSlots: Int = 5, val unlockedItems: List<String> = emptyList(),
    val leaftailShop: EconomyLeaftailShopState = EconomyLeaftailShopState(),
)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCommand(
    val requestId: String, val ownerPublicId: String, val expectedRevision: Long,
    val action: String, val targetId: String, val quantity: Long = 1, val totalPrice: Long = 0,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val fishSelection: Map<String, Long>? = null,
)
@Serializable data class EconomyResult(val state: EconomyView, val message: String, val acceptedRevision: Long, val replayed: Boolean = false)
interface EconomyRepository {
    suspend fun snapshot(sessionHash: ByteArray): EconomyView
    suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult
}
