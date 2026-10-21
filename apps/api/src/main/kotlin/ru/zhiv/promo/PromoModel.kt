package ru.zhiv.promo

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import ru.zhiv.economy.*
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.Locale
import java.util.UUID

@Serializable data class PromoReward(val coins: Long = 0, val pearls: Long = 0, val items: Map<String, Long> = emptyMap())
@Serializable data class PromoDefinition(val id: String, val code: String, val enabled: Boolean, val title: String,
    val startsAt: String? = null, val endsAt: String? = null, val reward: PromoReward)
@Serializable data class PromoCatalog(val version: Int, val codes: List<PromoDefinition>)
@Serializable data class PromoRequest(val requestId: String, val ownerPublicId: String, val expectedRevision: Long, val code: String)
@Serializable data class PromoResult(val state: EconomyView, val message: String, val acceptedRevision: Long,
    val replayed: Boolean = false, val title: String, val reward: PromoReward)
interface PromoRepository { suspend fun redeem(sessionHash: ByteArray, request: PromoRequest): PromoResult }
val promoJson = Json { ignoreUnknownKeys = false; encodeDefaults = true }
fun normalizePromoCode(code: String) = code.trim().uppercase(Locale.ROOT)
fun validatePromoRequest(request: PromoRequest): PromoRequest {
    if (!Regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$").matches(request.requestId) ||
        request.ownerPublicId.length !in 1..80 || request.expectedRevision !in 0..ECONOMY_MAX_REVISION ||
        request.code.length > 80 || !Regex("^[A-Z0-9][A-Z0-9_-]{2,39}$").matches(normalizePromoCode(request.code)))
        throw AuthFailure("INVALID_PROMO_CODE", "Проверьте промокод: от 3 до 40 латинских букв, цифр, - или _.", 400)
    return request.copy(requestId = UUID.fromString(request.requestId).toString(), code = normalizePromoCode(request.code))
}
fun decodePromoRequest(element: JsonElement): PromoRequest {
    fun invalid(): Nothing = throw AuthFailure("INVALID_PROMO_CODE", "Некорректный запрос промокода", 400)
    val value = element as? JsonObject ?: invalid()
    if (value.keys != setOf("requestId", "ownerPublicId", "expectedRevision", "code")) invalid()
    if (listOf("requestId", "ownerPublicId", "code").any { (value[it] as? JsonPrimitive)?.isString != true }) invalid()
    val revision = value["expectedRevision"] as? JsonPrimitive ?: invalid()
    if (revision.isString || revision.longOrNull == null) invalid()
    return validatePromoRequest(try { promoJson.decodeFromJsonElement(PromoRequest.serializer(), value) } catch (_: Exception) { invalid() })
}
object PromoRules {
    val catalog: PromoCatalog by lazy { parse(checkNotNull(javaClass.getResourceAsStream("/world/promo-codes.json")).bufferedReader().use { it.readText() }) }
    fun parse(raw: String): PromoCatalog = promoJson.decodeFromString<PromoCatalog>(raw).also { catalog ->
        require(catalog.version == 1 && catalog.codes.size <= 1000)
        require(catalog.codes.map { it.id }.distinct().size == catalog.codes.size && catalog.codes.map { it.code }.distinct().size == catalog.codes.size)
        val known = EconomyRules.catalog.items.map { it.id }.toSet()
        catalog.codes.forEach { code ->
            require(Regex("^[a-z0-9][a-z0-9_-]{2,63}$").matches(code.id) && Regex("^[A-Z0-9][A-Z0-9_-]{2,39}$").matches(code.code))
            require(code.title == code.title.trim() && code.title.length in 1..80)
            val start = code.startsAt?.let(Instant::parse); val end = code.endsAt?.let(Instant::parse)
            require(start == null || end == null || start < end)
            val reward = code.reward
            require(reward.coins in 0..1_000_000 && reward.pearls in 0..10_000)
            require(reward.items.keys.all { it in known } && reward.items.values.all { it in 1..10_000 } && reward.items.values.sum() <= 10_000)
            require(reward.coins > 0 || reward.pearls > 0 || reward.items.isNotEmpty())
        }
    }
    fun available(catalog: PromoCatalog, code: String, now: Instant): PromoDefinition {
        val entry = catalog.codes.singleOrNull { it.code == normalizePromoCode(code) && it.enabled }
            ?: economyFailure("PROMO_NOT_FOUND", "Промокод не найден. Проверьте, правильно ли он введён.")
        if (entry.startsAt?.let { now < Instant.parse(it) } == true) economyFailure("PROMO_NOT_STARTED", "Этот промокод начнёт действовать позже.")
        if (entry.endsAt?.let { now >= Instant.parse(it) } == true) economyFailure("PROMO_EXPIRED", "Срок действия промокода закончился.")
        return entry
    }
    /** Catalog currencies are visible amounts: coins are already displayed units, one pearl stores two units. */
    fun storedReward(entry: PromoDefinition) = entry.reward.copy(pearls = entry.reward.pearls * 2)
    fun apply(state: EconomyState, reward: PromoReward, reserved: Map<String, Long> = emptyMap()): EconomyState {
        if (reward.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || reward.pearls > ECONOMY_MAX_PEARLS - state.wallet.pearls)
            economyFailure("ECONOMY_CAPACITY", "В кошельке недостаточно места для подарка. Промокод не использован.")
        val next = EconomyFishStock.credit(state.copy(wallet = EconomyWallet(state.wallet.coins + reward.coins, state.wallet.pearls + reward.pearls),
            inventory = EconomyRules.addItems(state.inventory, reward.items)), reward.items)
        try { EconomyRules.assertStorageTransition(state, next, reserved) } catch (error: AuthFailure) {
            if (error.code == "ECONOMY_STORAGE_FULL") economyFailure(error.code, "В кладовой недостаточно места для подарка. Освободите место и повторите: промокод не использован.")
            throw error
        }
        return next
    }
}
