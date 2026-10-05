package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId

@Serializable
data class EconomyBarterOffer(
    val id: String,
    val sellerPublicId: String,
    val sellerName: String,
    val offeredItemId: String,
    val requestedItemId: String,
    val status: String,
    val createdAt: String,
    val closedAt: String? = null,
    val owned: Boolean,
)

@Serializable
data class EconomyBarterShowcase(
    val refreshAt: String,
    val slots: Int = EconomyBarterRules.SHOWCASE_SLOTS,
    val maxPerSeller: Int = EconomyBarterRules.SHOWCASE_PER_SELLER,
    val refreshSeconds: Long = EconomyBarterRules.SHOWCASE_SECONDS,
)

@Serializable
data class EconomyBarterView(
    val ownerPublicId: String,
    val offers: List<EconomyBarterOffer>,
    val mine: List<EconomyBarterOffer>,
    val serverTime: String,
    val showcase: EconomyBarterShowcase,
)

/** HTTP decoding enforces an exact action-specific union, without price or quantity. */
@Serializable
data class EconomyBarterCommand(
    val requestId: String,
    val ownerPublicId: String,
    val expectedRevision: Long,
    val action: String,
    val offeredItemId: String? = null,
    val requestedItemId: String? = null,
    val offerId: String? = null,
)

@Serializable
data class EconomyBarterResult(
    val state: EconomyView,
    val message: String,
    val acceptedRevision: Long,
    val replayed: Boolean = false,
    // Immutable command receipt. A create replay can still say active after an exchange.
    val offer: EconomyBarterOffer,
)

interface EconomyBarterRepository {
    suspend fun barter(sessionHash: ByteArray): EconomyBarterView
    suspend fun command(sessionHash: ByteArray, command: EconomyBarterCommand): EconomyBarterResult
}

object EconomyBarterRules {
    const val REQUIRED_HOME_LEVEL = 3
    const val MAX_OFFERS = 3
    const val SHOWCASE_SLOTS = 6
    const val SHOWCASE_PER_SELLER = 1
    const val SHOWCASE_SECONDS = 1800L

    fun eligibleItem(id: String): Boolean = EconomyRules.catalog.items.any {
        it.id == id && it.category == "special" && !it.tradable
    }

    fun validatePair(offered: String, requested: String) {
        if (offered == requested || !eligibleItem(offered) || !eligibleItem(requested))
            throw AuthFailure("ECONOMY_BARTER_ITEM", "Обменять можно один особый материал на другой", 400)
    }

    fun validate(command: EconomyBarterCommand) {
        if (parseCanonicalUuidV4(command.requestId) == null || parsePublicId(command.ownerPublicId) != command.ownerPublicId ||
            command.expectedRevision !in 0L until ECONOMY_MAX_REVISION) invalidEconomy()
        when (command.action) {
            "create_offer" -> {
                if (command.offeredItemId == null || command.requestedItemId == null || command.offerId != null ||
                    command.offeredItemId.length !in 1..80 || command.requestedItemId.length !in 1..80) invalidEconomy()
                if (command.offeredItemId == command.requestedItemId) invalidEconomy()
            }
            "accept_offer", "cancel_offer" -> if (parseCanonicalUuidV4(command.offerId) == null ||
                command.offeredItemId != null || command.requestedItemId != null) invalidEconomy()
            else -> invalidEconomy()
        }
    }
}

fun decodeEconomyBarterCommand(element: JsonElement): EconomyBarterCommand {
    val value = element as? JsonObject ?: invalidEconomy()
    val action = (value["action"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalidEconomy()
    val strings = setOf("requestId", "ownerPublicId", "action") + when (action) {
        "create_offer" -> setOf("offeredItemId", "requestedItemId")
        "accept_offer", "cancel_offer" -> setOf("offerId")
        else -> invalidEconomy()
    }
    if (value.keys != strings + "expectedRevision") invalidEconomy()
    for (field in strings) if ((value[field] as? JsonPrimitive)?.isString != true) invalidEconomy()
    val revision = value["expectedRevision"] as? JsonPrimitive ?: invalidEconomy()
    if (revision.isString || revision.longOrNull == null) invalidEconomy()
    return try { economyJson.decodeFromJsonElement<EconomyBarterCommand>(value).also(EconomyBarterRules::validate) }
    catch (_: SerializationException) { invalidEconomy() }
}
