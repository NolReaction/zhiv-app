package ru.zhiv.admin

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.identity.hasUserTextControls
import ru.zhiv.promo.*

@Serializable data class AdminPromoEntry(val definition: PromoDefinition, val version: Long, val redemptions: Long,
    val createdAt: String? = null, val updatedAt: String? = null)
@Serializable data class AdminPromos(val serverTime: String, val codes: List<AdminPromoEntry>)
@Serializable data class AdminPromoCommand(val requestId: String, val action: String, val promoId: String,
    val expectedVersion: Long, val reason: String, val definition: PromoDefinition? = null)
@Serializable data class AdminPromoReceipt(val requestId: String, val action: String, val promoId: String,
    val version: Long, val createdAt: String, val replayed: Boolean = false)
@Serializable data class AdminPromoAuditPayload(val request: AdminPromoCommand, val version: Long)

interface AdminPromoRepository {
    suspend fun list(sessionHash: ByteArray): AdminPromos
    suspend fun manage(sessionHash: ByteArray, request: AdminPromoCommand): AdminPromoReceipt
}

private fun invalidPromo(): Nothing = throw AuthFailure("INVALID_ADMIN_PROMO", "Проверьте код, срок действия, награды и причину изменения.", 400)

fun validateAdminPromo(input: AdminPromoCommand): AdminPromoCommand {
    val id = parseCanonicalUuidV4(input.requestId) ?: invalidPromo()
    if (input.action !in setOf("create", "update", "delete") ||
        !Regex("^[a-z0-9][a-z0-9_-]{2,63}$").matches(input.promoId) ||
        input.expectedVersion !in 0..9_007_199_254_740_990L || !validAdminReason(input.reason) ||
        (input.action == "create" && input.expectedVersion != 0L)) invalidPromo()
    if (input.action == "delete") {
        if (input.definition != null) invalidPromo()
        return input.copy(requestId = id.toString())
    }
    val definition = input.definition?.let { it.copy(code = normalizePromoCode(it.code)) } ?: invalidPromo()
    if (definition.id != input.promoId || hasUserTextControls(definition.title)) invalidPromo()
    try { PromoRules.parse(promoJson.encodeToString(PromoCatalog.serializer(), PromoCatalog(1, listOf(definition)))) }
    catch (_: IllegalArgumentException) { invalidPromo() }
    catch (_: java.time.DateTimeException) { invalidPromo() }
    return input.copy(requestId = id.toString(), definition = definition)
}

/** Json's number decoder accepts quoted numbers: explicitly keep the write contract strict. */
fun decodeAdminPromo(element: JsonElement): AdminPromoCommand {
    val value = element as? JsonObject ?: invalidPromo()
    fun string(element: JsonElement?) {
        if ((element as? JsonPrimitive)?.isString != true) invalidPromo()
    }
    fun number(element: JsonElement?) {
        val primitive = element as? JsonPrimitive ?: invalidPromo()
        if (primitive.isString || primitive.longOrNull == null) invalidPromo()
    }
    listOf("requestId", "action", "promoId", "reason").forEach { string(value[it]) }
    number(value["expectedVersion"])
    value["definition"]?.takeUnless { it == JsonNull }?.let { raw ->
        val definition = raw as? JsonObject ?: invalidPromo()
        listOf("id", "code", "title").forEach { string(definition[it]) }
        listOf("startsAt", "endsAt").forEach { field -> definition[field]?.takeUnless { it == JsonNull }?.let(::string) }
        val enabled = definition["enabled"] as? JsonPrimitive ?: invalidPromo()
        if (enabled.isString || enabled.booleanOrNull == null) invalidPromo()
        val reward = definition["reward"] as? JsonObject ?: invalidPromo()
        listOf("coins", "pearls").forEach { field -> reward[field]?.let(::number) }
        reward["items"]?.let { items -> (items as? JsonObject ?: invalidPromo()).values.forEach(::number) }
    }
    val input = try { promoJson.decodeFromJsonElement(AdminPromoCommand.serializer(), value) }
    catch (_: IllegalArgumentException) { invalidPromo() }
    return validateAdminPromo(input)
}
