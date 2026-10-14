package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.world.WorldRules
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
/** Only committed inventory movements and escrow count as legacy knowledge. Pending job rewards are private. */
internal fun legacyEconomyItemHistory(c: Connection, user: UUID): Set<String> {
    // Historical migration tests read populated V32-V38 schemas with the current
    // mapper. Build only sources that exist; SQL still parses absent tables in CASE.
    val available = c.economyRows("""SELECT
        EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.economy_ledger')
            AND attname='items' AND NOT attisdropped),
        to_regclass('public.economy_market_listings') IS NOT NULL,
        to_regclass('public.economy_barter_offers') IS NOT NULL""") {
        Triple(it.getBoolean(1),it.getBoolean(2),it.getBoolean(3))
    }.single()
    val sources = buildList {
        if (available.first) add("""SELECT item.key AS item_id FROM economy_ledger l CROSS JOIN LATERAL jsonb_each(
            CASE WHEN jsonb_typeof(l.items)='object' THEN l.items ELSE '{}'::jsonb END) item
            WHERE l.user_id=? AND CASE WHEN jsonb_typeof(item.value)='number'
                THEN (item.value#>>'{}')::numeric>0 ELSE false END""")
        if (available.second) add("SELECT item_id FROM economy_market_listings WHERE seller_id=? AND status='active'")
        if (available.third) add("SELECT offered_item_id AS item_id FROM economy_barter_offers WHERE seller_id=? AND status='active'")
    }
    if (sources.isEmpty()) return emptySet()
    return c.economyRows("SELECT item_id FROM (${sources.joinToString(" UNION ")}) history",
        *Array(sources.size) { user }) { it.getString(1) }.toSet()
}

internal fun readEconomyProfile(c: Connection, user: UUID): EconomyProfileRow {
    val row = c.economyRows(
        """SELECT e.revision,e.state,coalesce(w.state->'collection','[]'::jsonb),coalesce(w.state->'inventory','[]'::jsonb)
            FROM economy_profiles e LEFT JOIN world_profiles w ON w.user_id=e.user_id WHERE e.user_id=?""", user) {
        val state = EconomyFishInventory.state(economyJson.decodeFromString<EconomyState>(it.getString(2)))
        val inherited = economyJson.decodeFromString<List<String>>(it.getString(3))
        val legacyWardrobe = economyJson.decodeFromString<List<String>>(it.getString(4))
        val clothing = WorldRules.catalog.items.filter { item -> item.slot != "rod" }.map { item -> item.id }.toSet()
        EconomyProfileRow(it.getLong(1), state.copy(progression = EconomyCollectionProgress.inherit(state.progression, inherited),
            wardrobe = (state.wardrobe + legacyWardrobe).filter { id -> id in clothing }.distinct().sorted()))
    }.single()
    val history = if (row.state.itemUnlockVersion == 0) legacyEconomyItemHistory(c, user) else emptySet()
    // Seal the legacy projection in the returned value before a reward writer adds
    // gifted stock. Reading still leaves stored JSON and its revision untouched.
    return row.copy(state = EconomyItemUnlocks.persist(row.state, history))
}

/** Caller holds app_users FOR NO KEY UPDATE. The audit remains a permanent
 * conversion fence even if an administrative gameplay reset removes a profile. */
internal fun ensureEconomyProfile(c: Connection, user: UUID) {
    if (c.economyRows("SELECT 1 FROM economy_profiles WHERE user_id=?", user) { true }.isNotEmpty()) return
    val converted = c.economyRows("SELECT 1 FROM economy_conversion_audit WHERE user_id=?", user) { true }.isNotEmpty()
    val inserted = c.economyUpdate("""
        INSERT INTO economy_profiles(user_id,state)
        SELECT ?,economy_v4_initial_state(CASE WHEN EXISTS(SELECT 1 FROM economy_conversion_audit WHERE user_id=?)
            THEN jsonb_set(coalesce((SELECT state FROM world_profiles WHERE user_id=?),'{}'::jsonb),'{resources}','{"sparks":0,"wood":0,"stone":0}'::jsonb)
            ELSE coalesce((SELECT state FROM world_profiles WHERE user_id=?),'{}'::jsonb) END,?)
        ON CONFLICT DO NOTHING
    """.trimIndent(), user, user, user, user, !converted)
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
        SELECT user_id,'conversion:v1','legacy_conversion',(state->'migration'->>'coinsGranted')::bigint,
            jsonb_build_object('wood',(state->'migration'->>'woodGranted')::bigint,'stone',(state->'migration'->>'stoneGranted')::bigint)
        FROM economy_profiles WHERE user_id=? ON CONFLICT DO NOTHING
    """.trimIndent(), user)
    if (inserted == 1 && !converted) EconomyRules.catalog.onboarding?.let { pack ->
        c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items)
            VALUES (?,'starting-pack:v1','starting_pack',?,?,?::jsonb) ON CONFLICT DO NOTHING""",
            user, pack.startingWallet.coins, pack.startingWallet.pearls, economyJson.encodeToString(pack.startingItems))
    }
    c.economyUpdate("""UPDATE world_profiles SET state=jsonb_set(state,'{resources}','{"sparks":0,"wood":0,"stone":0}'::jsonb),
        revision=least(9007199254740991,revision+1),updated_at=clock_timestamp()
        WHERE user_id=? AND state->'resources'<>'{"sparks":0,"wood":0,"stone":0}'::jsonb""", user)
}

internal fun saveEconomyProfile(c: Connection, user: UUID, state: EconomyState, recordAwards: Boolean = true) {
    val history = if (state.itemUnlockVersion == 0) legacyEconomyItemHistory(c, user) else emptySet()
    val persisted = EconomyItemUnlocks.persist(EconomyFishInventory.state(state), history)
    val count = c.economyUpdate("""UPDATE economy_profiles SET state=?::jsonb,revision=revision+1,updated_at=clock_timestamp()
        WHERE user_id=? AND revision<9007199254740991""", economyJson.encodeToString(persisted), user)
    if (count != 1) economyFailure("ECONOMY_REVISION_CONFLICT", "Состояние хозяйства изменилось. Обновите страницу.")
    if (recordAwards) recordEconomyAchievements(c, user, persisted)
}
internal fun economyView(c: Connection, user: UUID, publicId: String, now: Instant): EconomyView {
    val row = readEconomyProfile(c, user)
    val s = EconomyStageOrders.pin(row.state, now=now)
    return EconomyView(publicId, row.revision, now.toString(), s.wallet, s.inventory, s.buildings, s.jobs.map { EconomyPublicJobs.project(it, now) }, s.migration,
        EconomyRules.catalog, EconomyRules.storage(s, reservedEconomyMarketItems(c, user)), s.completedExplorations, s.fishing, s.progression, wardrobe = s.wardrobe, fishingShop = s.fishingShop,
        productionSlots = s.productionSlots, food = s.food, residentOrders = s.residentOrders,
        workshopStarterClaimed = s.workshopStarterClaimed, tutorialOrder = s.tutorialOrder, stageOrders = s.stageOrders,
        marketSlots = s.marketSlots, unlockedItems = s.unlockedItems)
}

/** Save only public action context before a consumed job disappears. In
 * particular, fishing IDs do not equal command IDs. Private rolls and future
 * rewards must never become analytics metadata. */
internal fun economyLedgerContext(before: EconomyState, command: EconomyCommand, now: Instant? = null, after: EconomyState? = null): Map<String, String> {
    if (command.action == "start_production") return mapOf("targetId" to command.targetId.substringBefore('@'))
    if (command.action == "start_garden_collection" || command.action == "claim_garden_collection") {
        val batchId = if (command.action == "start_garden_collection") command.requestId else command.targetId
        val jobs = (if (command.action == "start_garden_collection") after ?: before else before).jobs.filter { it.collection?.batchId == batchId }
        return mapOf("originAction" to "start_production", "targetId" to "garden", "batchId" to batchId,
            "jobIds" to jobs.joinToString(",") { it.id }, "recipeIds" to jobs.mapNotNull { it.recipeId }.joinToString(","))
    }
    if (command.action in setOf("complete_resident_order", "replace_resident_order") && now != null) {
        val offer = EconomyFood.residentOrderBoard(before, now).offers.find { it.id == command.targetId }
        if (offer != null) return mapOf("targetId" to offer.templateId)
    }
    if (command.action !in setOf("claim_job", "speedup_construction", "start_collection", "cancel_production", "cancel_exploration"))
        return mapOf("targetId" to command.targetId)
    val job = before.jobs.find { it.id == command.targetId } ?: return emptyMap()
    val action = when (job.kind) {
        "construction" -> "start_construction"
        "production" -> "start_production"
        "exploration" -> if (EconomyRules.catalog.fishing?.routeIds?.contains(job.targetId) == true) "start_fishing" else "start_exploration"
        else -> return emptyMap()
    }
    val target = if (job.kind == "production") job.recipeId else job.targetId
    return buildMap {
        put("originAction", action)
        if (!target.isNullOrEmpty()) put("targetId", target)
    }
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
            val signature = economyJson.encodeToString(command.copy(fishSelection = command.fishSelection?.toSortedMap()))
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
            if (EconomyRules.commandUsesActor(command) && c.economyRows(
                "SELECT jsonb_array_length(coalesce(state->'journeys','[]'::jsonb))>0 FROM world_profiles WHERE user_id=?", actor.id
            ) { it.getBoolean(1) }.firstOrNull() == true)
                economyFailure("ECONOMY_EXPLORER_BUSY", "Сначала завершите прежнее путешествие Мохлика")
            val history = if (before.state.itemUnlockVersion == 0) legacyEconomyItemHistory(c, actor.id) else emptySet()
            val (next, message) = EconomyRules.apply(before.state, command, now, reservedEconomyMarketItems(c, actor.id), history)
            assertEconomyMarketCapacity(c, actor.id, before.state, next)
            saveEconomyProfile(c, actor.id, next)
            if (next.wardrobe != before.state.wardrobe) syncWorldWardrobe(c, actor.id, next.wardrobe)
            if (next.buildings != before.state.buildings) {
                // The existing renderer consumes WorldState. Update the same transaction;
                // forest geometry switches only after a completed construction is claimed.
                c.economyUpdate("""UPDATE world_profiles SET state=jsonb_set(jsonb_set(jsonb_set(state,'{houseLevel}',to_jsonb(?::integer)),
                    '{workshop}',to_jsonb(?::boolean)),'{workshopLevel}',to_jsonb(?::integer)),
                    revision=least(9007199254740991,revision+1),updated_at=clock_timestamp() WHERE user_id=?""",
                    next.buildings["home"] ?: 1, (next.buildings["workshop"] ?: 0) > 0, next.buildings["workshop"] ?: 0, actor.id)
            }
            val delta = (before.state.inventory.keys + next.inventory.keys).associateWith { (next.inventory[it] ?: 0) - (before.state.inventory[it] ?: 0) }.filterValues { it != 0L }
            c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items,context) VALUES (?,?,?,?,?,?::jsonb,?::jsonb)",
                actor.id, "command:$requestId", command.action, next.wallet.coins - before.state.wallet.coins,
                next.wallet.pearls - before.state.wallet.pearls, economyJson.encodeToString(delta),
                economyJson.encodeToString(economyLedgerContext(before.state, command, now, next)))
            c.economyUpdate("INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,?,?,?)",
                actor.id, requestId, signature, message, before.revision + 1)
            EconomyResult(economyView(c, actor.id, actor.publicId, now), message, before.revision + 1)
        }
    }
}
