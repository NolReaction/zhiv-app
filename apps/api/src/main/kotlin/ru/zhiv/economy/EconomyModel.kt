package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

internal val economyJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }
const val ECONOMY_MAX_BALANCE = 1_000_000_000L
const val ECONOMY_MAX_REVISION = 9_007_199_254_740_991L

@Serializable data class EconomyWallet(val coins: Long = 0, val pearls: Long = 0)
@Serializable data class EconomyCost(val coins: Long = 0, val items: Map<String, Long> = emptyMap())
@Serializable data class EconomyMigration(val version: Int = 1, val coinsGranted: Long, val woodGranted: Long, val stoneGranted: Long)
@Serializable data class EconomyJob(
    val id: String, val kind: String, val targetId: String, val recipeId: String? = null,
    val targetLevel: Int? = null, val startedAt: String, val finishesAt: String,
    val rewards: Map<String, Long> = emptyMap(), val cost: EconomyCost = EconomyCost(), val catalogVersion: Int = 1,
)
@Serializable data class EconomyState(
    val schemaVersion: Int = 1, val wallet: EconomyWallet, val inventory: Map<String, Long>,
    val buildings: Map<String, Int>, val jobs: List<EconomyJob> = emptyList(), val migration: EconomyMigration,
    val completedExplorations: Long = 0,
)
@Serializable data class EconomyItem(val id: String, val name: String, val category: String, val baseSellPrice: Long, val tradable: Boolean = true)
@Serializable data class EconomyBuildingLevel(
    val level: Int, val seconds: Long, val cost: EconomyCost, val requiredHomeLevel: Int = 1,
    val requiredBuildings: Map<String, Int> = emptyMap(), val warehouseCapacity: Long? = null,
)
@Serializable data class EconomyBuilding(val id: String, val name: String, val description: String, val levels: List<EconomyBuildingLevel>)
@Serializable data class EconomyRecipe(
    val id: String, val name: String, val buildingId: String, val buildingLevel: Int = 1,
    val requiredHomeLevel: Int = 1, val seconds: Long, val cost: EconomyCost = EconomyCost(), val rewards: Map<String, Long>,
    val requiredBuildings: Map<String, Int> = emptyMap(),
)
@Serializable data class EconomyExploration(
    val id: String, val name: String, val description: String, val requiredHomeLevel: Int = 1,
    val seconds: Long, val cost: EconomyCost = EconomyCost(), val rewards: Map<String, Long>,
    val requiredBuildings: Map<String, Int> = emptyMap(),
)
@Serializable data class EconomyMarketConfig(val requiredHomeLevel: Int = 2, val requiredExplorations: Long = 1, val maxListings: Int = 10, val maxLotQuantity: Long = 99, val maxPriceMultiplier: Long = 5, val feeBps: Int = 0)
@Serializable data class EconomyCatalog(
    val version: Int, val maxBatch: Int, val items: List<EconomyItem>, val buildings: List<EconomyBuilding>,
    val recipes: List<EconomyRecipe>, val explorations: List<EconomyExploration>, val market: EconomyMarketConfig = EconomyMarketConfig(),
)
@Serializable data class EconomyStorage(
    val capacity: Long, val used: Long, val reserved: Long, val available: Long, val overflow: Long,
)
@Serializable data class EconomyView(
    val ownerPublicId: String, val revision: Long, val serverTime: String,
    val wallet: EconomyWallet, val inventory: Map<String, Long>, val buildings: Map<String, Int>,
    val jobs: List<EconomyJob>, val migration: EconomyMigration, val catalog: EconomyCatalog,
    val storage: EconomyStorage, val completedExplorations: Long = 0,
)
@Serializable data class EconomyCommand(
    val requestId: String, val ownerPublicId: String, val expectedRevision: Long,
    val action: String, val targetId: String, val quantity: Long = 1, val totalPrice: Long = 0,
)
@Serializable data class EconomyResult(val state: EconomyView, val message: String, val acceptedRevision: Long, val replayed: Boolean = false)
interface EconomyRepository {
    suspend fun snapshot(sessionHash: ByteArray): EconomyView
    suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult
}
