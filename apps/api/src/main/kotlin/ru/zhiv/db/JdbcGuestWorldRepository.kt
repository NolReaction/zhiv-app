package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.relationships.*
import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

internal data class GuestWorldAccess(
    val viewerId: UUID, val sellerId: UUID, val viewerPublicId: String, val user: GuestProfileUser,
    val economy: JsonObject?, val legacy: JsonObject?, val viewerEconomy: JsonObject?, val serverTime: String,
)

/** Call again after both account locks for a write. Social/lifecycle writers use the same UUID-ordered account locks. */
internal fun requireGuestWorldAccess(c: Connection, hash: ByteArray, circle: UUID): GuestWorldAccess {
    val signedIn = c.economyRows("""SELECT 1 FROM app_sessions s JOIN app_users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
        AND u.deleted_at IS NULL AND u.banned_at IS NULL""", hash) { true }.isNotEmpty()
    if (!signedIn) throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return c.economyRows("""SELECT viewer.id AS viewer_id,other.id AS seller_id,viewer.public_id AS viewer_public_id,
        other.public_id,other.display_name,ep.state AS economy,wp.state AS legacy,vep.state AS viewer_economy,
        statement_timestamp() AS server_time
        FROM app_sessions s JOIN app_users viewer ON viewer.id=s.user_id
        JOIN circles circle ON circle.id=? AND circle.kind='DIRECT' AND circle.archived_at IS NULL
          AND viewer.id IN(circle.direct_user_low_id,circle.direct_user_high_id)
        JOIN app_users other ON other.id=CASE WHEN viewer.id=circle.direct_user_low_id
          THEN circle.direct_user_high_id ELSE circle.direct_user_low_id END
        CROSS JOIN LATERAL effective_recipient_sharing(other.id,viewer.id) privacy
        LEFT JOIN economy_profiles ep ON ep.user_id=other.id LEFT JOIN world_profiles wp ON wp.user_id=other.id
        LEFT JOIN economy_profiles vep ON vep.user_id=viewer.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
          AND viewer.deleted_at IS NULL AND viewer.banned_at IS NULL
          AND other.deleted_at IS NULL AND other.banned_at IS NULL AND privacy.sharing_mode<>'OFF'""", circle, hash) { r ->
        fun json(column: String): JsonObject? = r.getString(column)?.let { Json.parseToJsonElement(it).jsonObject }
        GuestWorldAccess(r.getObject("viewer_id",UUID::class.java),r.getObject("seller_id",UUID::class.java),
            r.getString("viewer_public_id"),GuestProfileUser(r.getString("public_id"),r.getString("display_name")),
            json("economy"),json("legacy"),json("viewer_economy"),
            r.getObject("server_time",OffsetDateTime::class.java).toInstant().toString())
    }.firstOrNull() ?: throw AuthFailure("GUEST_WORLD_UNAVAILABLE", "Мир друга недоступен", 404)
}

class JdbcGuestWorldRepository(private val source: DataSource) : GuestWorldRepository {
    private val market = JdbcEconomyMarketRepository(source)
    override suspend fun world(sessionHash: ByteArray, circleId: UUID): GuestWorld = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.isReadOnly = true
            c.transactionIsolation = Connection.TRANSACTION_REPEATABLE_READ
            c.autoCommit = false
            try {
                val access = requireGuestWorldAccess(c, sessionHash, circleId)
                val gifts = c.economyRows("SELECT item_id FROM game_items WHERE user_id=? ORDER BY item_id", access.sellerId) { it.getString(1) }
                val scene = GuestWorldRules.scene(access.economy, access.legacy, gifts)
                val seller = if (access.economy == null) EconomyRules.initial(includeStartingPack=false).copy(buildings=scene.buildings)
                    else readEconomyProfile(c,access.sellerId).state
                val buyer = if (access.viewerEconomy == null) EconomyRules.initial(includeStartingPack=false)
                    else readEconomyProfile(c,access.viewerId).state
                val reason = when {
                    !EconomyMarketRules.unlocked(buyer) -> "buyer_locked"
                    !EconomyMarketRules.unlocked(seller) -> "seller_locked"
                    !EconomyMarketRules.sameHomeBand(buyer.buildings["home"] ?: 1, seller.buildings["home"] ?: 1) -> "home_band"
                    else -> null
                }
                val listings = c.economyRows("""SELECT * FROM economy_market_listings WHERE seller_id=? AND status='active'
                    ORDER BY created_at DESC,id DESC LIMIT ?""", access.sellerId, EconomyRules.catalog.market.maxListings) { r ->
                    EconomyMarketListing(r.getObject("id",UUID::class.java).toString(),access.user.publicId,access.user.displayName,
                        r.getString("item_id"),r.getLong("quantity"),EconomyMoney.nominal(r.getLong("total_price"),r.getInt("currency_scale")),
                        "active",r.getObject("created_at",OffsetDateTime::class.java).toInstant().toString(),null,false,r.getInt("seller_fee_bps"))
                }
                val result = GuestWorld(access.viewerPublicId,circleId.toString(),access.user,access.serverTime,scene,
                    GuestWorldMarket(listings,reason == null,reason))
                c.commit()
                result
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }
    override suspend fun purchase(sessionHash: ByteArray, circleId: UUID, command: EconomyCommand): EconomyResult =
        market.friendPurchase(sessionHash, circleId, command)
}
