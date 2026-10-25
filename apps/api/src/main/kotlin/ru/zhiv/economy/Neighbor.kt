package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.identity.hasUserTextControls
import ru.zhiv.relationships.GuestWorldScene
import ru.zhiv.world.WorldEquipment
import ru.zhiv.world.WorldRules
import java.math.BigInteger
import java.time.Instant
import java.time.ZoneOffset

@Serializable data class NeighborSettings(
    val enabled: Boolean = true, val autoBuyEnabled: Boolean = true,
    val name: String = "Берест", val description: String = "Лесной сосед и персонаж мира.",
    val buildings: Map<String, Int> = emptyMap(), val equipment: WorldEquipment = WorldEquipment(),
    val offerSlots: Long = 3, val offerQuantity: Long = 1, val allowedItemIds: List<String> = emptyList(),
    val sellPriceBps: Long = 12500, val buyPriceBps: Long = 10000,
    val firstDelaySeconds: Long = 180, val staleAfterSeconds: Long = 21600,
    val maxLotsPerDay: Long = 2, val dailyBudgetCoins: Long = 300, val maxLotCoins: Long = 150,
    val globalDailyBudgetCoins: Long = 10000, val activeFromHourUtc: Int = 0, val activeUntilHourUtc: Int = 24,
)
@Serializable data class NeighborGarment(val id: String, val name: String, val slot: String, val description: String)
@Serializable data class NeighborOffer(val id: String, val itemId: String, val quantity: Long, val totalPrice: Long, val purchased: Boolean = false)
@Serializable data class NeighborCharacter(val id: String = "berest", val name: String, val description: String,
    val kind: String = "world_character", val world: GuestWorldScene)
@Serializable data class NeighborShop(val cycleId: String, val refreshAt: String, val available: Boolean,
    val reason: String? = null, val offers: List<NeighborOffer>)
@Serializable data class NeighborBuying(val enabled: Boolean, val firstDelaySeconds: Long, val staleAfterSeconds: Long,
    val maxLotsPerDay: Long, val dailyBudgetCoins: Long, val maxLotCoins: Long, val usedLots: Long, val spentCoins: Long)
@Serializable data class NeighborView(val ownerPublicId: String, val serverTime: String, val character: NeighborCharacter,
    val shop: NeighborShop, val buying: NeighborBuying)
@Serializable data class NeighborAdminPlayer(val publicId: String, val name: String)
@Serializable data class NeighborUsage(val usedLots: Long, val spentCoins: Long, val globalSpentCoins: Long)
@Serializable data class NeighborPending(val id: String, val sellerPublicId: String, val sellerName: String, val itemId: String,
    val quantity: Long, val totalPrice: Long, val proceedsCoins: Long, val createdAt: String, val eligible: Boolean, val reason: String?)
@Serializable data class NeighborPurchase(val id: String, val listingId: String, val sellerPublicId: String, val itemId: String,
    val quantity: Long, val totalPrice: Long, val proceedsCoins: Long, val createdAt: String, val source: String)
@Serializable data class NeighborAdminReceipt(val requestId: String, val replayed: Boolean = false)
@Serializable data class NeighborAdminView(val serverTime: String, val settings: NeighborSettings, val version: Long,
    val pausedReason: String?, val usage: NeighborUsage, val player: NeighborAdminPlayer? = null,
    val pending: List<NeighborPending> = emptyList(), val history: List<NeighborPurchase> = emptyList(),
    val receipt: NeighborAdminReceipt? = null)
@Serializable data class NeighborSettingsCommand(val requestId: String, val expectedVersion: Long, val reason: String, val settings: NeighborSettings)
@Serializable data class NeighborBuyCommand(val requestId: String, val listingId: String, val playerPublicId: String,
    val expectedTotalPrice: Long, val reason: String)
interface NeighborRepository {
    suspend fun neighbor(sessionHash: ByteArray): NeighborView
    suspend fun purchase(sessionHash: ByteArray, command: EconomyCommand): EconomyResult
    suspend fun admin(sessionHash: ByteArray, publicId: String? = null): NeighborAdminView
    suspend fun settings(sessionHash: ByteArray, command: NeighborSettingsCommand): NeighborAdminView
    suspend fun buy(sessionHash: ByteArray, command: NeighborBuyCommand): NeighborAdminView
}

object NeighborRules {
    const val MAX_SAFE_SETTING = 9_007_199_254_740_991L
    val exclusiveWardrobe: List<NeighborGarment> by lazy {
        NeighborRules::class.java.getResourceAsStream("/world/neighbor-wardrobe.json")!!.bufferedReader().use {
            economyJson.decodeFromString<List<NeighborGarment>>(it.readText())
        }
    }
    val defaults: NeighborSettings by lazy {
        NeighborRules::class.java.getResourceAsStream("/world/neighbor-catalog.json")!!.bufferedReader().use {
            validate(economyJson.decodeFromString<NeighborSettings>(it.readText()))
        }
    }
    private fun invalid(): Nothing = throw AuthFailure("INVALID_NEIGHBOR_SETTINGS", "Проверьте настройки лесного соседа", 400)
    fun validate(s: NeighborSettings): NeighborSettings {
        if (s.name.isBlank() || s.name != s.name.trim() || s.name.length > 40 || hasUserTextControls(s.name) ||
            s.description.isBlank() || s.description.length > 240 || hasUserTextControls(s.description) ||
            s.offerSlots !in 0..MAX_SAFE_SETTING || s.offerQuantity !in 1L..ECONOMY_MAX_ITEMS ||
            s.allowedItemIds.size > EconomyRules.catalog.items.size ||
            s.allowedItemIds.distinct().size != s.allowedItemIds.size ||
            s.allowedItemIds.any { id -> EconomyRules.catalog.items.none { it.id == id && it.tradable && it.baseSellPrice > 0 && !it.id.startsWith("fish") && it.category != "special" } } ||
            s.sellPriceBps !in 0..MAX_SAFE_SETTING || s.buyPriceBps !in 0..MAX_SAFE_SETTING ||
            s.firstDelaySeconds !in 0..MAX_SAFE_SETTING || s.staleAfterSeconds !in 0..MAX_SAFE_SETTING ||
            s.maxLotsPerDay !in 0..MAX_SAFE_SETTING || s.dailyBudgetCoins !in 0..MAX_SAFE_SETTING || s.maxLotCoins !in 0..ECONOMY_MAX_BALANCE ||
            s.globalDailyBudgetCoins !in 0..MAX_SAFE_SETTING ||
            (s.buildings["home"] ?: 0)<2 || (s.buildings["bridge"] ?: 0)<1 || s.activeFromHourUtc !in 0..23 ||
            s.activeUntilHourUtc !in 1..24 || s.activeFromHourUtc == s.activeUntilHourUtc ||
            s.buildings.keys != EconomyRules.catalog.buildings.map { it.id }.toSet() ||
            s.buildings.any { (id, level) -> level !in (if (id == "home") 1 else 0)..EconomyRules.catalog.buildings.single { it.id == id }.levels.maxOf { it.level } }) invalid()
        val clothes = mapOf("palette" to s.equipment.palette, "head" to s.equipment.head, "neck" to s.equipment.neck, "rod" to s.equipment.rod)
        if (clothes.any { (slot, id) -> id != null &&
            WorldRules.catalog.items.none { it.id == id && it.slot == slot } &&
            exclusiveWardrobe.none { it.id == id && it.slot == slot } }) invalid()
        return s
    }
    private fun quoted(base: Long, quantity: Long, bps: Long, roundUp: Boolean): BigInteger? {
        if(base < 0 || quantity !in 1..ECONOMY_MAX_ITEMS || bps !in 0..MAX_SAFE_SETTING) return null
        val product = BigInteger.valueOf(base).multiply(BigInteger.valueOf(quantity)).multiply(BigInteger.valueOf(bps))
        return product.add(BigInteger.valueOf(if(roundUp) 99999 else 0)).divide(BigInteger.valueOf(100000)).multiply(BigInteger.TEN)
    }
    /** Invalid or unrepresentable stock is filtered before constructing a public offer. */
    fun sellPrice(base: Long, quantity: Long, settings: NeighborSettings): Long {
        val value = quoted(base,quantity,settings.sellPriceBps,true) ?: return ECONOMY_MAX_BALANCE+1
        return if(value > BigInteger.valueOf(ECONOMY_MAX_BALANCE)) ECONOMY_MAX_BALANCE+1 else value.toLong()
    }
    fun buyCap(base: Long, quantity: Long, settings: NeighborSettings): Long =
        (quoted(base,quantity,settings.buyPriceBps,false) ?: BigInteger.ZERO)
            .min(BigInteger.valueOf(ECONOMY_MAX_BALANCE)).toLong()
    /** A broad, PostgreSQL-safe scan cutoff; the final exact age check remains authoritative. */
    fun candidateCutoff(at: Instant, settings: NeighborSettings): Instant =
        at.minusSeconds(minOf(settings.firstDelaySeconds,settings.staleAfterSeconds,maxOf(0L,at.epochSecond)))
    fun active(at: Instant, settings: NeighborSettings): Boolean {
        val hour = at.atOffset(ZoneOffset.UTC).hour
        return settings.enabled && if(settings.activeFromHourUtc < settings.activeUntilHourUtc)
            hour in settings.activeFromHourUtc until settings.activeUntilHourUtc
        else hour >= settings.activeFromHourUtc || hour < settings.activeUntilHourUtc
    }
    fun eligibleItems(state: EconomyState, settings: NeighborSettings): List<EconomyItem> {
        val opened = EconomyItemUnlocks.project(state)
        return EconomyRules.catalog.items.filter { it.tradable && it.baseSellPrice > 0 && !it.id.startsWith("fish") && it.category != "special" && it.id in settings.allowedItemIds && it.id in opened }
    }
    fun validatePurchase(command: EconomyCommand) {
        validateEconomyCommand(command.copy(quantity=1))
        if (command.action != "buy_offer" || parseCanonicalUuidV4(command.targetId) == null ||
            command.quantity !in 1L..ECONOMY_MAX_ITEMS || command.totalPrice !in 0L..ECONOMY_MAX_BALANCE || command.fishSelection != null)
            throw AuthFailure("INVALID_ECONOMY_COMMAND", "Некорректная покупка у соседа", 400)
    }
}
