package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

internal fun Connection.economyUpdate(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
    values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
    statement.executeUpdate()
}
internal fun <T> Connection.economyRows(sql: String, vararg values: Any?, read: (ResultSet) -> T): List<T> = prepareStatement(sql).use { statement ->
    values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
    statement.executeQuery().use { result -> buildList { while (result.next()) add(read(result)) } }
}
internal data class EconomyProfileRow(val revision: Long, val state: EconomyState)
internal fun readEconomyProfile(c: Connection, user: UUID): EconomyProfileRow = c.economyRows(
    """SELECT e.revision,e.state,coalesce(w.state->'collection','[]'::jsonb)
        FROM economy_profiles e LEFT JOIN world_profiles w ON w.user_id=e.user_id WHERE e.user_id=?""", user) {
    val state = economyJson.decodeFromString<EconomyState>(it.getString(2))
    val inherited = economyJson.decodeFromString<List<String>>(it.getString(3))
    EconomyProfileRow(it.getLong(1), state.copy(progression = EconomyCollectionProgress.inherit(state.progression, inherited)))
}.single()

/** Caller holds app_users FOR NO KEY UPDATE. The audit remains a permanent
 * conversion fence even if an administrative gameplay reset removes a profile. */
internal fun ensureEconomyProfile(c: Connection, user: UUID) {
    if (c.economyRows("SELECT 1 FROM economy_profiles WHERE user_id=?", user) { true }.isNotEmpty()) return
    val inserted = c.economyUpdate("""
        INSERT INTO economy_profiles(user_id,state)
        SELECT ?,economy_v3_initial_state(CASE WHEN EXISTS(SELECT 1 FROM economy_conversion_audit WHERE user_id=?)
            THEN jsonb_set(coalesce((SELECT state FROM world_profiles WHERE user_id=?),'{}'::jsonb),'{resources}','{"sparks":0,"wood":0,"stone":0}'::jsonb)
            ELSE coalesce((SELECT state FROM world_profiles WHERE user_id=?),'{}'::jsonb) END)
        ON CONFLICT DO NOTHING
    """.trimIndent(), user, user, user, user)
    if (inserted == 1 && EconomyRules.catalog.fishing != null) {
        val state = readEconomyProfile(c, user).state
        val now = c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java).toInstant() }.single()
        // Initial merchant stock belongs to revision zero, just like starter tackle.
        c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",
            economyJson.encodeToString(state.copy(fishingShop = EconomyFishingShops.create(state, now))), user)
    }
    c.economyUpdate("""
        INSERT INTO economy_conversion_audit(user_id,legacy_sparks,legacy_wood,legacy_stone,coins_granted,wood_granted,stone_granted)
        SELECT ?,coalesce((w.state->'resources'->>'sparks')::bigint,0),coalesce((w.state->'resources'->>'wood')::bigint,0),
            coalesce((w.state->'resources'->>'stone')::bigint,0),(e.state->'migration'->>'coinsGranted')::bigint,
            (e.state->'migration'->>'woodGranted')::bigint,(e.state->'migration'->>'stoneGranted')::bigint
        FROM economy_profiles e LEFT JOIN world_profiles w ON w.user_id=e.user_id WHERE e.user_id=? ON CONFLICT DO NOTHING
    """.trimIndent(), user, user)
    c.economyUpdate("""
        INSERT INTO economy_ledger(user_id,source_key,kind,coins,items)
        SELECT user_id,'conversion:v1','legacy_conversion',(state->'wallet'->>'coins')::bigint,state->'inventory'
        FROM economy_profiles WHERE user_id=? ON CONFLICT DO NOTHING
    """.trimIndent(), user)
    c.economyUpdate("""UPDATE world_profiles SET state=jsonb_set(state,'{resources}','{"sparks":0,"wood":0,"stone":0}'::jsonb),
        revision=least(9007199254740991,revision+1),updated_at=clock_timestamp()
        WHERE user_id=? AND state->'resources'<>'{"sparks":0,"wood":0,"stone":0}'::jsonb""", user)
}

internal fun saveEconomyProfile(c: Connection, user: UUID, state: EconomyState, recordAwards: Boolean = true) {
    val count = c.economyUpdate("""UPDATE economy_profiles SET state=?::jsonb,revision=revision+1,updated_at=clock_timestamp()
        WHERE user_id=? AND revision<9007199254740991""", economyJson.encodeToString(state), user)
    if (count != 1) economyFailure("ECONOMY_REVISION_CONFLICT", "Состояние хозяйства изменилось. Обновите страницу.")
    if (recordAwards) recordEconomyAchievements(c, user, state)
}
internal fun economyView(c: Connection, user: UUID, publicId: String, now: Instant): EconomyView {
    val row = readEconomyProfile(c, user)
    val s = row.state
    return EconomyView(publicId, row.revision, now.toString(), s.wallet, s.inventory, s.buildings, s.jobs, s.migration,
        EconomyRules.catalog, EconomyRules.storage(s, reservedEconomyMarketItems(c, user)), s.completedExplorations, s.fishing, s.progression, fishingShop = s.fishingShop)
}

class JdbcEconomyRepository(private val source: DataSource) : EconomyRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private data class Receipt(val signature: String, val message: String, val revision: Long)
    private fun actor(c: Connection, hash: ByteArray): Actor = c.economyRows("""
        SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """.trimIndent(), hash) { Actor(it.getObject(1, UUID::class.java), it.getString(2)) }.firstOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private suspend fun <T> transaction(hash: ByteArray, owner: String? = null, block: (Connection, Actor, Instant) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit = false
            try {
                val initial = actor(c, hash)
                c.economyUpdate("SET LOCAL lock_timeout = '5s'")
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
                val current = actor(c, hash)
                if (current.id != initial.id || (owner != null && current.publicId != owner))
                    economyFailure("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите страницу.")
                ensureEconomyProfile(c, current.id)
                val now = c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java).toInstant() }.single()
                val result = block(c, current, now)
                c.commit()
                result
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }

    override suspend fun snapshot(sessionHash: ByteArray): EconomyView = transaction(sessionHash) { c, actor, now ->
        val state = readEconomyProfile(c, actor.id).state
        if (EconomyRules.catalog.fishing != null && EconomyFishingShops.expired(state.fishingShop, now))
            saveEconomyProfile(c, actor.id, state.copy(fishingShop = EconomyFishingShops.create(state, now)), recordAwards = false)
        economyView(c, actor.id, actor.publicId, now)
    }

    override suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult {
        validateEconomyCommand(command)
        return transaction(sessionHash, command.ownerPublicId) { c, actor, now ->
            val requestId = UUID.fromString(command.requestId)
            val signature = economyJson.encodeToString(command)
            val receipt = c.economyRows("SELECT signature,message,accepted_revision FROM economy_commands WHERE user_id=? AND request_id=?", actor.id, requestId) {
                Receipt(it.getString(1), it.getString(2), it.getLong(3))
            }.firstOrNull()
            if (receipt != null) {
                if (receipt.signature != signature) economyFailure("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
                return@transaction EconomyResult(economyView(c, actor.id, actor.publicId, now), receipt.message, receipt.revision, true)
            }
            if (c.economyRows("SELECT 1 FROM economy_market_receipts WHERE user_id=? AND request_id=?", actor.id, requestId) { true }.isNotEmpty())
                economyFailure("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
            if (c.economyRows("SELECT 1 FROM economy_barter_receipts WHERE user_id=? AND request_id=?", actor.id, requestId) { true }.isNotEmpty())
                economyFailure("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
            if (c.economyRows("SELECT 1 FROM game_reward_claims WHERE user_id=? AND request_id=?", actor.id, requestId) { true }.isNotEmpty())
                economyFailure("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
            val before = readEconomyProfile(c, actor.id)
            if (before.revision != command.expectedRevision) economyFailure("ECONOMY_REVISION_CONFLICT", "Хозяйство уже изменилось. Обновите состояние и повторите действие.")
            if (command.action in setOf("start_exploration", "start_fishing", "start_collection") && c.economyRows(
                "SELECT jsonb_array_length(coalesce(state->'journeys','[]'::jsonb))>0 FROM world_profiles WHERE user_id=?", actor.id
            ) { it.getBoolean(1) }.firstOrNull() == true)
                economyFailure("ECONOMY_EXPLORER_BUSY", "Сначала завершите прежнее путешествие Мохлика")
            val (next, message) = EconomyRules.apply(before.state, command, now, reservedEconomyMarketItems(c, actor.id))
            assertEconomyMarketCapacity(c, actor.id, before.state, next)
            saveEconomyProfile(c, actor.id, next)
            if (next.buildings != before.state.buildings) {
                // The existing renderer consumes WorldState. Update the same transaction;
                // forest geometry switches only after a completed construction is claimed.
                c.economyUpdate("""UPDATE world_profiles SET state=jsonb_set(jsonb_set(jsonb_set(state,'{houseLevel}',to_jsonb(?::integer)),
                    '{workshop}',to_jsonb(?::boolean)),'{workshopLevel}',to_jsonb(?::integer)),
                    revision=least(9007199254740991,revision+1),updated_at=clock_timestamp() WHERE user_id=?""",
                    next.buildings["home"] ?: 1, (next.buildings["workshop"] ?: 0) > 0, next.buildings["workshop"] ?: 0, actor.id)
            }
            val delta = (before.state.inventory.keys + next.inventory.keys).associateWith { (next.inventory[it] ?: 0) - (before.state.inventory[it] ?: 0) }.filterValues { it != 0L }
            c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items) VALUES (?,?,?,?,?,?::jsonb)",
                actor.id, "command:$requestId", command.action, next.wallet.coins - before.state.wallet.coins,
                next.wallet.pearls - before.state.wallet.pearls, economyJson.encodeToString(delta))
            c.economyUpdate("INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,?,?,?)",
                actor.id, requestId, signature, message, before.revision + 1)
            EconomyResult(economyView(c, actor.id, actor.publicId, now), message, before.revision + 1)
        }
    }
}
