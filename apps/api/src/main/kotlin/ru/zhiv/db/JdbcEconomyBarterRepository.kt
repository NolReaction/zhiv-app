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
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

/** Lifecycle callers hold the common account lock. Escrow is returned exactly once. */
internal fun cancelEconomyBarterOffers(c: Connection, user: UUID) {
    val offers = c.economyRows("""SELECT id,offered_item_id FROM economy_barter_offers
        WHERE seller_id=? AND status='active' ORDER BY id FOR UPDATE""", user) {
        it.getObject(1, UUID::class.java) to it.getString(2)
    }
    if (offers.isEmpty()) return
    ensureEconomyProfile(c, user)
    val before = readEconomyProfile(c, user).state
    val reservedBefore = reservedEconomyMarketItems(c, user)
    val inventory = before.inventory.toMutableMap()
    for ((id, item) in offers) {
        val held = inventory[item] ?: 0L
        if (held >= ECONOMY_MAX_BALANCE) throw AuthFailure("ECONOMY_CAPACITY", "Освободите место для материала", 409)
        inventory[item] = held + 1L
        c.economyUpdate("UPDATE economy_barter_offers SET status='cancelled',closed_at=clock_timestamp() WHERE id=?", id)
        c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items)
            VALUES (?,?,'barter_cancel',0,0,?::jsonb)""", user, "barter:cancel:$id", economyJson.encodeToString(mapOf(item to 1L)))
    }
    val next = before.copy(inventory=inventory)
    assertEconomyMarketCapacity(c, user, before, next, reservedBefore)
    saveEconomyProfile(c, user, next)
}

/** Preserve original signatures and offer snapshots as cross-account replay fences. */
internal fun mergeEconomyBarterReceipts(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""INSERT INTO economy_barter_receipts(user_id,request_id,signature,message,accepted_revision,offer,created_at)
        SELECT ?,request_id,signature,message,accepted_revision,offer,created_at FROM economy_barter_receipts WHERE user_id=?
        ON CONFLICT DO NOTHING""", target, source)
}

class JdbcEconomyBarterRepository(private val source: DataSource) : EconomyBarterRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private data class OfferRow(val seller: UUID, val offer: EconomyBarterOffer)
    private data class Showcase(val refreshAt: Instant, val ids: List<UUID>)
    private data class Receipt(val signature: String, val message: String, val revision: Long, val offer: EconomyBarterOffer)

    private fun actor(c: Connection, hash: ByteArray): Actor = c.economyRows("""SELECT u.id,u.public_id FROM app_users u
        JOIN app_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND u.deleted_at IS NULL AND u.banned_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()""", hash) {
        Actor(it.getObject(1, UUID::class.java), it.getString(2))
    }.firstOrNull() ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private suspend fun <T> transaction(block: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit = false
            try {
                c.economyUpdate("SET LOCAL lock_timeout = '5s'")
                val result = block(c)
                c.commit()
                result
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }

    private fun now(c: Connection): Instant = c.economyRows("SELECT clock_timestamp()") {
        it.getObject(1, OffsetDateTime::class.java).toInstant()
    }.single()

    private fun offer(result: ResultSet, owner: UUID): OfferRow {
        val seller = result.getObject("seller_id", UUID::class.java)
        return OfferRow(seller, EconomyBarterOffer(
            id=result.getObject("id", UUID::class.java).toString(),
            sellerPublicId=result.getString("public_id"), sellerName=result.getString("display_name"),
            offeredItemId=result.getString("offered_item_id"), requestedItemId=result.getString("requested_item_id"),
            status=result.getString("status"), createdAt=result.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
            closedAt=result.getObject("closed_at", OffsetDateTime::class.java)?.toInstant()?.toString(), owned=seller == owner))
    }

    private fun readShowcase(c: Connection, user: UUID): Showcase? = c.economyRows(
        "SELECT refresh_at,offer_ids FROM economy_barter_showcases WHERE user_id=?", user) {
        Showcase(it.getObject(1, OffsetDateTime::class.java).toInstant(),
            (it.getArray(2).array as Array<*>).map { id -> UUID.fromString(id.toString()) })
    }.firstOrNull()

    private fun showcase(c: Connection, user: UUID, at: Instant): Showcase {
        readShowcase(c, user)?.takeIf { at.isBefore(it.refreshAt) }?.let { return it }
        val itemIds = EconomyRules.catalog.items.filter { EconomyBarterRules.eligibleItem(it.id) }.map { it.id }
        val ids = if (itemIds.isEmpty()) emptyList() else {
            val placeholders = itemIds.joinToString(",") { "?" }
            val parameters = mutableListOf<Any?>(user.toString() + at.toString(), user)
            parameters.addAll(itemIds); parameters.addAll(itemIds)
            parameters.add(EconomyBarterRules.SHOWCASE_PER_SELLER); parameters.add(EconomyBarterRules.SHOWCASE_SLOTS)
            c.economyRows("""WITH candidates AS (
                SELECT o.id,o.seller_id,md5(o.id::text || ?) AS rank FROM economy_barter_offers o
                JOIN app_users u ON u.id=o.seller_id
                WHERE o.status='active' AND o.seller_id<>? AND u.deleted_at IS NULL AND u.banned_at IS NULL
                AND o.offered_item_id IN ($placeholders) AND o.requested_item_id IN ($placeholders)
            ), diverse AS (
                SELECT id,rank,row_number() OVER (PARTITION BY seller_id ORDER BY rank,id) AS seller_slot FROM candidates
            ) SELECT id FROM diverse WHERE seller_slot<=? ORDER BY rank,id LIMIT ?""", *parameters.toTypedArray()) {
                it.getObject(1, UUID::class.java)
            }
        }
        val result = Showcase(at.plusSeconds(EconomyBarterRules.SHOWCASE_SECONDS), ids)
        c.prepareStatement("""INSERT INTO economy_barter_showcases(user_id,refresh_at,offer_ids) VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET refresh_at=EXCLUDED.refresh_at,offer_ids=EXCLUDED.offer_ids""").use { statement ->
            statement.setObject(1, user); statement.setObject(2, OffsetDateTime.ofInstant(result.refreshAt, ZoneOffset.UTC))
            val array = c.createArrayOf("uuid", ids.toTypedArray())
            try { statement.setArray(3, array); statement.executeUpdate() } finally { array.free() }
        }
        return result
    }

    override suspend fun barter(sessionHash: ByteArray): EconomyBarterView = transaction { c ->
        val initial = actor(c, sessionHash)
        c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
        val user = actor(c, sessionHash)
        if (user.id != initial.id) throw AuthFailure("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите обмен.", 409)
        ensureEconomyProfile(c, user.id)
        val state = readEconomyProfile(c, user.id).state
        val at = now(c)
        val selection = if ((state.buildings["home"] ?: 1) >= EconomyBarterRules.REQUIRED_HOME_LEVEL) showcase(c, user.id, at)
            else Showcase(at.plusSeconds(EconomyBarterRules.SHOWCASE_SECONDS), emptyList())
        val offers = if (selection.ids.isEmpty()) emptyList() else c.economyRows("""SELECT o.*,u.public_id,u.display_name
            FROM economy_barter_offers o JOIN app_users u ON u.id=o.seller_id
            WHERE o.id IN (${selection.ids.joinToString(",") { "?" }}) AND o.status='active'
            AND u.deleted_at IS NULL AND u.banned_at IS NULL""", *selection.ids.toTypedArray()) { offer(it, user.id).offer }
            .filter { EconomyBarterRules.eligibleItem(it.offeredItemId) && EconomyBarterRules.eligibleItem(it.requestedItemId) }
            .sortedBy { selection.ids.indexOf(UUID.fromString(it.id)) }
        val mine = c.economyRows("""SELECT o.*,u.public_id,u.display_name FROM economy_barter_offers o JOIN app_users u ON u.id=o.seller_id
            WHERE o.seller_id=? AND o.status='active' ORDER BY o.created_at DESC,o.id DESC LIMIT ?""", user.id, EconomyBarterRules.MAX_OFFERS) { offer(it, user.id).offer }
        EconomyBarterView(user.publicId, offers, mine, at.toString(), EconomyBarterShowcase(selection.refreshAt.toString()))
    }

    override suspend fun command(sessionHash: ByteArray, command: EconomyBarterCommand): EconomyBarterResult {
        EconomyBarterRules.validate(command)
        return transaction { c ->
            val initial = actor(c, sessionHash)
            // Offer ownership never changes: merging accounts cancels instead of transferring offers.
            val offerId = command.offerId?.let(UUID::fromString)
            val seller = offerId?.let { id -> c.economyRows("SELECT seller_id FROM economy_barter_offers WHERE id=?", id) {
                it.getObject(1, UUID::class.java)
            }.firstOrNull() }
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE", initial.id, seller ?: initial.id) { true }
            val user = actor(c, sessionHash)
            if (user.id != initial.id || user.publicId != command.ownerPublicId)
                throw AuthFailure("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите хозяйство.", 409)
            ensureEconomyProfile(c, user.id)
            val signature = economyJson.encodeToString(command)
            val requestId = UUID.fromString(command.requestId)
            val receipt = c.economyRows("""SELECT signature,message,accepted_revision,offer FROM economy_barter_receipts
                WHERE user_id=? AND request_id=?""", user.id, requestId) {
                Receipt(it.getString(1), it.getString(2), it.getLong(3), economyJson.decodeFromString<EconomyBarterOffer>(it.getString(4)))
            }.firstOrNull()
            if (receipt != null) {
                if (receipt.signature != signature) throw AuthFailure("ECONOMY_REQUEST_CONFLICT", "Запрос уже использован для другого действия", 409)
                return@transaction EconomyBarterResult(economyView(c, user.id, user.publicId, now(c)), receipt.message, receipt.revision, true, receipt.offer)
            }
            if (c.economyRows("""SELECT 1 FROM economy_commands WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_market_receipts WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM game_reward_claims WHERE user_id=? AND request_id=? LIMIT 1""",
                user.id, requestId, user.id, requestId, user.id, requestId) { true }.isNotEmpty())
                throw AuthFailure("ECONOMY_REQUEST_CONFLICT", "Запрос уже использован для другого действия", 409)
            val before = readEconomyProfile(c, user.id)
            if (before.revision != command.expectedRevision)
                throw AuthFailure("ECONOMY_REVISION_CONFLICT", "Хозяйство уже изменилось. Обновите его и повторите действие.", 409)
            if (command.action != "cancel_offer" && (before.state.buildings["home"] ?: 1) < EconomyBarterRules.REQUIRED_HOME_LEVEL)
                throw AuthFailure("ECONOMY_BARTER_LOCKED", "Обмен особыми материалами откроется с домом третьего уровня", 409)
            val result = if (command.action == "create_offer") create(c, user.id, before.state, command) else {
                val row = c.economyRows("""SELECT o.*,u.public_id,u.display_name FROM economy_barter_offers o
                    JOIN app_users u ON u.id=o.seller_id WHERE o.id=? AND u.deleted_at IS NULL AND u.banned_at IS NULL
                    FOR UPDATE OF o""", offerId) { offer(it, user.id) }.firstOrNull()
                    ?: throw AuthFailure("ECONOMY_BARTER_NOT_FOUND", "Предложение обмена не найдено", 404)
                if (row.seller != seller || row.offer.status != "active")
                    throw AuthFailure("ECONOMY_BARTER_NOT_ACTIVE", "Предложение уже закрыто", 409)
                if (command.action == "accept_offer") accept(c, user.id, before.state, row)
                else cancel(c, user.id, before.state, row)
            }
            val view = economyView(c, user.id, user.publicId, now(c))
            c.economyUpdate("""INSERT INTO economy_barter_receipts(user_id,request_id,signature,message,accepted_revision,offer)
                VALUES (?,?,?,?,?,?::jsonb)""", user.id, requestId, signature, result.first, view.revision, economyJson.encodeToString(result.second))
            EconomyBarterResult(view, result.first, view.revision, offer=result.second)
        }
    }

    private fun currentOffer(c: Connection, id: UUID, owner: UUID): EconomyBarterOffer = c.economyRows("""SELECT o.*,u.public_id,u.display_name
        FROM economy_barter_offers o JOIN app_users u ON u.id=o.seller_id WHERE o.id=?""", id) { offer(it, owner).offer }.single()

    private fun create(c: Connection, user: UUID, state: EconomyState, command: EconomyBarterCommand): Pair<String, EconomyBarterOffer> {
        val offered = checkNotNull(command.offeredItemId); val requested = checkNotNull(command.requestedItemId)
        EconomyBarterRules.validatePair(offered, requested)
        val active = c.economyRows("SELECT count(*) FROM economy_barter_offers WHERE seller_id=? AND status='active'", user) { it.getInt(1) }.single()
        if (active >= EconomyBarterRules.MAX_OFFERS) throw AuthFailure("ECONOMY_BARTER_LIMIT", "Можно держать до трёх предложений обмена", 409)
        val amount = state.inventory[offered] ?: 0L
        if (amount < 1L) throw AuthFailure("ECONOMY_RESOURCES", "Нет материала для обмена", 409)
        val beforeReserved = reservedEconomyMarketItems(c, user)
        val id = UUID.randomUUID()
        val next = state.copy(inventory=state.inventory + (offered to amount - 1L))
        c.economyUpdate("""INSERT INTO economy_barter_offers(id,seller_id,offered_item_id,requested_item_id)
            VALUES (?,?,?,?)""", id, user, offered, requested)
        assertEconomyMarketCapacity(c, user, state, next, beforeReserved)
        saveEconomyProfile(c, user, next)
        ledger(c, user, "barter:create:$id", "barter_create", mapOf(offered to -1L))
        return "Материал предложен к обмену" to currentOffer(c, id, user)
    }

    private fun accept(c: Connection, user: UUID, state: EconomyState, row: OfferRow): Pair<String, EconomyBarterOffer> {
        if (row.seller == user) throw AuthFailure("ECONOMY_BARTER_SELF_TRADE", "Нельзя принять собственное предложение", 409)
        val offer = row.offer; val id = UUID.fromString(offer.id)
        val selection = readShowcase(c, user)
        if (selection == null || !now(c).isBefore(selection.refreshAt) || id !in selection.ids)
            throw AuthFailure("ECONOMY_BARTER_SHOWCASE_CHANGED", "Предложение вне текущей витрины. Обновите обмен.", 409)
        EconomyBarterRules.validatePair(offer.offeredItemId, offer.requestedItemId)
        val payment = state.inventory[offer.requestedItemId] ?: 0L
        if (payment < 1L) throw AuthFailure("ECONOMY_RESOURCES", "Нет материала, который просит другой игрок", 409)
        ensureEconomyProfile(c, row.seller)
        val sellerState = readEconomyProfile(c, row.seller).state
        val gained = state.inventory[offer.offeredItemId] ?: 0L
        val sellerGained = sellerState.inventory[offer.requestedItemId] ?: 0L
        if (gained >= ECONOMY_MAX_BALANCE || sellerGained >= ECONOMY_MAX_BALANCE)
            throw AuthFailure("ECONOMY_CAPACITY", "Освободите место для материала", 409)
        val reservedBuyer = reservedEconomyMarketItems(c, user); val reservedSeller = reservedEconomyMarketItems(c, row.seller)
        val nextBuyer = state.copy(inventory=state.inventory + (offer.requestedItemId to payment - 1L) + (offer.offeredItemId to gained + 1L))
        val nextSeller = sellerState.copy(inventory=sellerState.inventory + (offer.requestedItemId to sellerGained + 1L))
        c.economyUpdate("UPDATE economy_barter_offers SET status='exchanged',buyer_id=?,closed_at=clock_timestamp() WHERE id=?", user, id)
        assertEconomyMarketCapacity(c, user, state, nextBuyer, reservedBuyer)
        assertEconomyMarketCapacity(c, row.seller, sellerState, nextSeller, reservedSeller)
        saveEconomyProfile(c, user, nextBuyer); saveEconomyProfile(c, row.seller, nextSeller)
        ledger(c, user, "barter:accept:$id", "barter_accept", mapOf(offer.requestedItemId to -1L, offer.offeredItemId to 1L))
        ledger(c, row.seller, "barter:exchange:$id", "barter_exchange", mapOf(offer.requestedItemId to 1L))
        return "Особые материалы обменены" to currentOffer(c, id, user)
    }

    private fun cancel(c: Connection, user: UUID, state: EconomyState, row: OfferRow): Pair<String, EconomyBarterOffer> {
        if (row.seller != user) throw AuthFailure("ECONOMY_BARTER_OWNER", "Снять предложение может только его автор", 403)
        val item = row.offer.offeredItemId; val id = UUID.fromString(row.offer.id)
        val amount = state.inventory[item] ?: 0L
        if (amount >= ECONOMY_MAX_BALANCE) throw AuthFailure("ECONOMY_CAPACITY", "Освободите место для материала", 409)
        val reservedBefore = reservedEconomyMarketItems(c, user)
        val next = state.copy(inventory=state.inventory + (item to amount + 1L))
        c.economyUpdate("UPDATE economy_barter_offers SET status='cancelled',closed_at=clock_timestamp() WHERE id=?", id)
        assertEconomyMarketCapacity(c, user, state, next, reservedBefore)
        saveEconomyProfile(c, user, next)
        ledger(c, user, "barter:cancel:$id", "barter_cancel", mapOf(item to 1L))
        return "Предложение снято, материал возвращён" to currentOffer(c, id, user)
    }

    private fun ledger(c: Connection, user: UUID, sourceKey: String, kind: String, items: Map<String, Long>) {
        c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items) VALUES (?,?,?,0,0,?::jsonb)""",
            user, sourceKey, kind, economyJson.encodeToString(items))
    }
}
