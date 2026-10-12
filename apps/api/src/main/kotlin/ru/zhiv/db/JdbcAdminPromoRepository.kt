package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.admin.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.promo.*
import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

/** The same catalogue lock fences redemption against a concurrently disabled/deleted campaign. */
internal fun lockPromoCatalog(c: Connection, writing: Boolean) {
    c.economyRows("SELECT ${if (writing) "pg_advisory_xact_lock" else "pg_advisory_xact_lock_shared"}(28752, 1)") { true }
}

internal fun availableManagedPromo(c: Connection, catalog: PromoCatalog, code: String): PromoDefinition {
    lockPromoCatalog(c, writing = false)
    val now = c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java).toInstant() }.single()
    val managed = c.economyRows("SELECT definition,deleted_at FROM managed_promo_codes WHERE code=?", code) {
        promoJson.decodeFromString<PromoDefinition>(it.getString(1)) to (it.getObject(2) != null)
    }.singleOrNull()
    val entry = if (managed != null) managed.first.takeUnless { managed.second } else {
        catalog.codes.singleOrNull { it.code == code }?.takeUnless { legacy ->
            c.economyRows("SELECT 1 FROM managed_promo_codes WHERE promo_id=?", legacy.id) { true }.isNotEmpty()
        }
    }
    return PromoRules.available(PromoCatalog(1, listOfNotNull(entry)), code, now)
}

class JdbcAdminPromoRepository(private val source: DataSource, private val config: AdminConfig,
    private val catalog: PromoCatalog = PromoRules.catalog) : AdminPromoRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private fun fail(code: String, message: String, status: Int = 409): Nothing = throw AuthFailure(code, message, status)
    private fun actor(c: Connection, hash: ByteArray, lock: Boolean = false): Actor {
        val actor = c.economyRows("""SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
            WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL AND u.banned_at IS NULL ${if (lock) "FOR UPDATE OF s" else ""}""", hash) {
            Actor(it.getObject(1, UUID::class.java), it.getString(2))
        }.firstOrNull() ?: fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
        if (actor.publicId !in config.allowedPublicIds) fail("ADMIN_FORBIDDEN", "Нет доступа к панели управления", 403)
        return actor
    }
    private suspend fun <T> tx(readOnly: Boolean = false, body: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            if (readOnly) { c.transactionIsolation = Connection.TRANSACTION_REPEATABLE_READ; c.isReadOnly = true }
            c.autoCommit = false
            try {
                c.economyUpdate("SET LOCAL statement_timeout = '8s'")
                c.economyUpdate("SET LOCAL lock_timeout = '3s'")
                val result = body(c); c.commit(); result
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }
    private fun serverTime(c: Connection) = c.economyRows("SELECT clock_timestamp()") {
        it.getObject(1, OffsetDateTime::class.java).toInstant().toString()
    }.single()

    override suspend fun list(sessionHash: ByteArray): AdminPromos = tx(readOnly = true) { c ->
        actor(c, sessionHash)
        val claims = c.economyRows("SELECT promo_id,count(*) FROM promo_redemptions GROUP BY promo_id") {
            it.getString(1) to it.getLong(2)
        }.toMap()
        val rows = c.economyRows("SELECT * FROM managed_promo_codes") {
            AdminPromoEntry(promoJson.decodeFromString<PromoDefinition>(it.getString("definition")), it.getLong("version"),
                claims[it.getString("promo_id")] ?: 0,
                it.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
                it.getObject("updated_at", OffsetDateTime::class.java).toInstant().toString()) to (it.getObject("deleted_at") != null)
        }
        val overridden = rows.map { it.first.definition.id }.toSet()
        val legacy = catalog.codes.filter { it.id !in overridden }.map { AdminPromoEntry(it, 0, claims[it.id] ?: 0) }
        AdminPromos(serverTime(c), (rows.filterNot { it.second }.map { it.first } + legacy).sortedBy { it.definition.code })
    }

    override suspend fun manage(sessionHash: ByteArray, request: AdminPromoCommand): AdminPromoReceipt = tx { c ->
        val initial = actor(c, sessionHash)
        val input = validateAdminPromo(request)
        val requestId = UUID.fromString(input.requestId)
        val requestJson = promoJson.encodeToString(input)
        val action = "promo_${input.action}"
        c.economyRows("SELECT pg_advisory_xact_lock(?)", requestId.mostSignificantBits xor requestId.leastSignificantBits) { true }
        c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
        val current = actor(c, sessionHash, lock = true)
        if (current.id != initial.id) fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
        val previous = c.economyRows("SELECT *,payload->'request'=?::jsonb AS same_payload FROM admin_actions WHERE request_id=?", requestJson, requestId) { r ->
            if (r.getString("actor_public_id") != current.publicId || r.getString("action") != action || !r.getBoolean("same_payload"))
                fail("ADMIN_REQUEST_CONFLICT", "Этот запрос уже использован с другими параметрами")
            val payload = promoJson.decodeFromString<AdminPromoAuditPayload>(r.getString("payload"))
            AdminPromoReceipt(input.requestId, input.action, input.promoId, payload.version,
                r.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(), replayed = true)
        }.singleOrNull()
        if (previous != null) return@tx previous
        lockPromoCatalog(c, writing = true)
        // Session expiry continues to advance while waiting for another catalogue operation.
        actor(c, sessionHash)
        val row = c.economyRows("SELECT definition,version,deleted_at FROM managed_promo_codes WHERE promo_id=?", input.promoId) {
            Triple(promoJson.decodeFromString<PromoDefinition>(it.getString(1)), it.getLong(2), it.getObject(3) != null)
        }.singleOrNull()
        val legacy = catalog.codes.singleOrNull { it.id == input.promoId }
        val before = row?.first ?: legacy
        val version = row?.second ?: 0
        if (input.action == "create") {
            if (before != null || c.economyRows("SELECT 1 FROM promo_redemptions WHERE promo_id=? LIMIT 1", input.promoId) { true }.isNotEmpty())
                fail("ADMIN_PROMO_EXISTS", "Такой ID акции уже использован. Создайте новый ID.")
            val managedCount = c.economyRows("SELECT count(*) FROM managed_promo_codes WHERE deleted_at IS NULL") { it.getLong(1) }.single()
            val overridden = c.economyRows("SELECT promo_id FROM managed_promo_codes") { it.getString(1) }.toSet()
            if (managedCount + catalog.codes.count { it.id !in overridden } >= 1000)
                fail("ADMIN_PROMO_LIMIT", "В списке уже 1000 акций. Удалите завершённые акции.")
        } else if (before == null || row?.third == true) fail("ADMIN_PROMO_NOT_FOUND", "Промокод уже удалён или не найден", 404)
        if (version != input.expectedVersion) fail("ADMIN_PROMO_VERSION_CONFLICT", "Промокод изменился. Обновите список перед редактированием.")
        val definition = input.definition ?: checkNotNull(before)
        val codeUsed = c.economyRows("SELECT 1 FROM managed_promo_codes WHERE code=? AND promo_id<>?", definition.code, input.promoId) { true }.isNotEmpty()
        if (codeUsed || catalog.codes.any { it.code == definition.code && it.id != input.promoId })
            fail("ADMIN_PROMO_CODE_EXISTS", "Этот текст промокода уже используется другой акцией.")
        val nextVersion = version + 1
        c.economyUpdate("""INSERT INTO managed_promo_codes(promo_id,code,definition,version,deleted_at)
            VALUES (?,?,?::jsonb,?,CASE WHEN ? THEN clock_timestamp() ELSE NULL END)
            ON CONFLICT(promo_id) DO UPDATE SET code=EXCLUDED.code,definition=EXCLUDED.definition,
            version=EXCLUDED.version,updated_at=clock_timestamp(),deleted_at=EXCLUDED.deleted_at""",
            input.promoId, definition.code, promoJson.encodeToString(definition), nextVersion, input.action == "delete")
        c.economyRows("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,
            action,reason,affected_sessions,payload,changed) VALUES (?,?,?,?,?,?,?,0,?::jsonb,true) RETURNING created_at""",
            requestId, current.id, current.id, current.publicId, current.publicId, action, input.reason,
            promoJson.encodeToString(AdminPromoAuditPayload(input, nextVersion))) {
            AdminPromoReceipt(input.requestId, input.action, input.promoId, nextVersion,
                it.getObject(1, OffsetDateTime::class.java).toInstant().toString())
        }.single()
    }
}
