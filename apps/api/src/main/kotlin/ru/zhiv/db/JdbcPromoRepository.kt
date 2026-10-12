package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.promo.*
import java.security.MessageDigest
import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

class JdbcPromoRepository(private val source: DataSource, private val catalog: PromoCatalog = PromoRules.catalog) : PromoRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private fun actor(c: Connection, hash: ByteArray) = c.economyRows("""SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL""", hash) {
        Actor(it.getObject(1, UUID::class.java), it.getString(2)) }.firstOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    override suspend fun redeem(sessionHash: ByteArray, request: PromoRequest): PromoResult = withContext(Dispatchers.IO) {
        val input = validatePromoRequest(request)
        source.connection.use { c ->
            c.autoCommit = false
            try {
                val initial = actor(c, sessionHash)
                c.economyUpdate("SET LOCAL lock_timeout = '5s'")
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
                val owner = actor(c, sessionHash)
                if (owner.id != initial.id || owner.publicId != input.ownerPublicId)
                    economyFailure("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите страницу.")
                ensureEconomyProfile(c, owner.id)
                val now = c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java).toInstant() }.single()
                val requestId = UUID.fromString(input.requestId)
                val signature = "promo:v1:" + MessageDigest.getInstance("SHA-256").digest(promoJson.encodeToString(input).toByteArray()).joinToString("") { "%02x".format(it) }
                val prior = c.economyRows("SELECT signature FROM economy_commands WHERE user_id=? AND request_id=?", owner.id, requestId) { it.getString(1) }.firstOrNull()
                if (prior != null) {
                    if (prior != signature) economyFailure("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
                    val result = c.economyRows("SELECT title,reward,accepted_revision FROM promo_redemptions WHERE user_id=? AND origin_user_id=? AND request_id=?", owner.id, owner.id, requestId) {
                        PromoResult(economyView(c, owner.id, owner.publicId, now), "Подарок уже получен", it.getLong(3), true,
                            it.getString(1), promoJson.decodeFromString<PromoReward>(it.getString(2))) }.singleOrNull()
                        ?: economyFailure("PROMO_ALREADY_USED", "Вы уже получили подарок по этому промокоду.")
                    c.commit(); return@withContext result
                }
                for (table in listOf("economy_market_receipts", "economy_barter_receipts", "game_reward_claims")) {
                    if (c.economyRows("SELECT 1 FROM $table WHERE user_id=? AND request_id=?", owner.id, requestId) { true }.isNotEmpty())
                        economyFailure("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
                }
                val entry = PromoRules.available(catalog, input.code, now)
                if (c.economyRows("SELECT 1 FROM promo_redemptions WHERE user_id=? AND promo_id=?", owner.id, entry.id) { true }.isNotEmpty())
                    economyFailure("PROMO_ALREADY_USED", "Вы уже получили подарок по этому промокоду.")
                val before = readEconomyProfile(c, owner.id)
                if (before.revision != input.expectedRevision)
                    economyFailure("ECONOMY_REVISION_CONFLICT", "Хозяйство изменилось. Обновите состояние и повторите ввод промокода.")
                val reward = PromoRules.storedReward(entry)
                val next = PromoRules.apply(before.state, reward, reservedEconomyMarketItems(c, owner.id))
                saveEconomyProfile(c, owner.id, next)
                val revision = before.revision + 1
                c.economyUpdate("""INSERT INTO promo_redemptions(user_id,origin_user_id,promo_id,request_id,title,reward,accepted_revision)
                    VALUES (?,?,?,?,?,?::jsonb,?)""", owner.id, owner.id, entry.id, requestId, entry.title, promoJson.encodeToString(reward), revision)
                c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items)
                    VALUES (?,?,'promo_code',?,?,?::jsonb)""", owner.id, "promo:${entry.id}", reward.coins, reward.pearls, economyJson.encodeToString(reward.items))
                c.economyUpdate("INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,?,?,?)",
                    owner.id, requestId, signature, "Подарок получен", revision)
                val result = PromoResult(economyView(c, owner.id, owner.publicId, now), "Подарок получен", revision, title = entry.title, reward = reward)
                c.commit(); result
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }
}

/** Balances are merged elsewhere. Copy only redemption fences; never grant a second gift. */
internal fun mergePromoRedemptions(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""INSERT INTO promo_redemptions(user_id,origin_user_id,promo_id,request_id,title,reward,accepted_revision,claimed_at)
        SELECT ?,origin_user_id,promo_id,request_id,title,reward,accepted_revision,claimed_at FROM promo_redemptions WHERE user_id=? ON CONFLICT DO NOTHING""", target, source)
}
