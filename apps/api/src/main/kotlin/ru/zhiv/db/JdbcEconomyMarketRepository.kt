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

/** Callers hold the common account lock, shared by production, market and lifecycle writes. */
internal fun reservedEconomyMarketItems(c: Connection, user: UUID): Map<String, Long> =
    c.economyRows("""SELECT item_id,sum(quantity) FROM economy_market_listings
        WHERE seller_id=? AND status='active' GROUP BY item_id""", user) { it.getString(1) to it.getLong(2) }.toMap()

/** Escrow occupies warehouse space; returning it must also work for preserved old overflow. */
internal fun assertEconomyMarketCapacity(
    c: Connection,
    user: UUID,
    before: EconomyState,
    next: EconomyState,
    reservedBefore: Map<String, Long> = reservedEconomyMarketItems(c, user),
) {
    val reservedAfter = reservedEconomyMarketItems(c, user)
    if ((next.inventory.keys + reservedAfter.keys).any { item ->
        val amount = next.inventory[item] ?: 0L
        val held = reservedAfter[item] ?: 0L
        amount < 0L || held < 0L || held > ECONOMY_MAX_BALANCE || amount > ECONOMY_MAX_BALANCE - held
    }) throw AuthFailure("ECONOMY_CAPACITY", "Освободите место для предметов", 409)
    EconomyRules.assertStorageTransition(before, next, reservedBefore, reservedAfter)
}

/** Lifecycle callers already hold the common user lock. Cancel before merging or resetting profiles. */
internal fun cancelEconomyMarketListings(c: Connection, user: UUID) {
    val lots = c.economyRows("""SELECT id,item_id,quantity FROM economy_market_listings
        WHERE seller_id=? AND status='active' ORDER BY id FOR UPDATE""", user) {
        Triple(it.getObject(1, UUID::class.java), it.getString(2), it.getLong(3))
    }
    if (lots.isEmpty()) return
    ensureEconomyProfile(c, user)
    val row = readEconomyProfile(c, user)
    val inventory = row.state.inventory.toMutableMap()
    val reservedBefore = reservedEconomyMarketItems(c, user)
    for ((id, item, quantity) in lots) {
        inventory[item] = Math.addExact(inventory[item] ?: 0L, quantity)
        c.economyUpdate("UPDATE economy_market_listings SET status='cancelled',closed_at=clock_timestamp() WHERE id=?", id)
        c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,items)
            VALUES (?,?,'market_cancel',0,?::jsonb)""", user, "market:cancel:$id", economyJson.encodeToString(mapOf(item to quantity)))
    }
    val next = row.state.copy(inventory = inventory)
    assertEconomyMarketCapacity(c, user, row.state, next, reservedBefore)
    saveEconomyProfile(c, user, next)
}

internal fun mergeEconomyMarketReceipts(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""INSERT INTO economy_market_receipts(user_id,request_id,signature,message,accepted_revision,created_at)
        SELECT ?,request_id,signature,message,accepted_revision,created_at FROM economy_market_receipts WHERE user_id=?
        ON CONFLICT DO NOTHING""", target, source)
}

class JdbcEconomyMarketRepository(private val source: DataSource) : EconomyMarketRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private data class ListingRow(val seller: UUID, val listing: EconomyMarketListing)
    private data class Receipt(val signature: String, val message: String, val revision: Long)

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
            } catch (error: Exception) {
                c.rollback()
                throw error
            }
        }
    }

    private fun now(c: Connection): Instant = c.economyRows("SELECT clock_timestamp()") {
        it.getObject(1, OffsetDateTime::class.java).toInstant()
    }.single()

    private fun listing(result: ResultSet, owner: UUID): ListingRow {
        val seller = result.getObject("seller_id", UUID::class.java)
        return ListingRow(seller, EconomyMarketListing(
            id = result.getObject("id", UUID::class.java).toString(),
            sellerPublicId = result.getString("public_id"), sellerName = result.getString("display_name"),
            itemId = result.getString("item_id"), quantity = result.getLong("quantity"),
            totalPrice = result.getLong("total_price"), status = result.getString("status"),
            createdAt = result.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
            closedAt = result.getObject("closed_at", OffsetDateTime::class.java)?.toInstant()?.toString(),
            owned = seller == owner,
        ))
    }

    override suspend fun market(sessionHash: ByteArray, cursor: String?, limit: Int): EconomyMarketView {
        if (limit !in 1..EconomyMarketRules.MAX_PAGE_SIZE)
            throw AuthFailure("INVALID_ECONOMY_QUERY", "Размер страницы должен быть от 1 до 50", 400)
        val page = EconomyMarketRules.cursor(cursor)
        return transaction { c ->
            val user = actor(c, sessionHash)
            val cursorSql = if (page == null) "" else " AND (l.created_at,l.id)<(?,?)"
            val parameters = mutableListOf<Any?>(user.id)
            if (page != null) {
                parameters.add(OffsetDateTime.ofInstant(page.createdAt, ZoneOffset.UTC))
                parameters.add(page.id)
            }
            parameters.add(limit + 1)
            val rows = c.economyRows("""SELECT l.*,u.public_id,u.display_name FROM economy_market_listings l
                JOIN app_users u ON u.id=l.seller_id WHERE l.status='active' AND l.seller_id<>?
                AND u.deleted_at IS NULL AND u.banned_at IS NULL $cursorSql
                ORDER BY l.created_at DESC,l.id DESC LIMIT ?""", *parameters.toTypedArray()) { listing(it, user.id).listing }
            val mine = c.economyRows("""SELECT l.*,u.public_id,u.display_name FROM economy_market_listings l
                JOIN app_users u ON u.id=l.seller_id WHERE l.status='active' AND l.seller_id=?
                ORDER BY l.created_at DESC,l.id DESC LIMIT ?""", user.id, EconomyRules.catalog.market.maxListings) { listing(it, user.id).listing }
            val listings = rows.take(limit)
            EconomyMarketView(listings, mine,
                if (rows.size > limit) EconomyMarketRules.cursor(listings.last()) else null, now(c).toString())
        }
    }

    override suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult {
        EconomyMarketRules.validate(command)
        return transaction { c ->
            val initial = actor(c, sessionHash)
            // Read the immutable seller before locking; account merges cancel, never reassign, active lots.
            val listingId = if (command.action == "create_listing") null else UUID.fromString(command.targetId)
            val seller = listingId?.let { id -> c.economyRows("SELECT seller_id FROM economy_market_listings WHERE id=?", id) {
                it.getObject(1, UUID::class.java)
            }.firstOrNull() }
            // Use PostgreSQL's UUID ordering, matching account lifecycle and social writers.
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE", initial.id, seller ?: initial.id) { true }
            val user = actor(c, sessionHash)
            if (user.id != initial.id || user.publicId != command.ownerPublicId)
                throw AuthFailure("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите хозяйство.", 409)
            ensureEconomyProfile(c, user.id)
            val signature = economyJson.encodeToString(command)
            val requestId = UUID.fromString(command.requestId)
            val receipt = c.economyRows("""SELECT signature,message,accepted_revision FROM economy_market_receipts
                WHERE user_id=? AND request_id=?""", user.id, requestId) { Receipt(it.getString(1), it.getString(2), it.getLong(3)) }.firstOrNull()
            if (receipt != null) {
                if (receipt.signature != signature)
                    throw AuthFailure("ECONOMY_REQUEST_CONFLICT", "Запрос уже использован для другого действия", 409)
                return@transaction EconomyResult(economyView(c, user.id, user.publicId, now(c)), receipt.message, receipt.revision, true)
            }
            if (c.economyRows("SELECT 1 FROM economy_commands WHERE user_id=? AND request_id=?", user.id, requestId) { true }.isNotEmpty())
                throw AuthFailure("ECONOMY_REQUEST_CONFLICT", "Запрос уже использован для другого действия", 409)
            val before = readEconomyProfile(c, user.id)
            if (before.revision != command.expectedRevision)
                throw AuthFailure("ECONOMY_REVISION_CONFLICT", "Хозяйство уже изменилось. Обновите его и повторите действие.", 409)
            val marketConfig = EconomyRules.catalog.market
            if (command.action != "cancel_listing" &&
                ((before.state.buildings["home"] ?: 1) < marketConfig.requiredHomeLevel || before.state.completedExplorations < marketConfig.requiredExplorations))
                throw AuthFailure("ECONOMY_MARKET_LOCKED", "Для торговли нужен дом второго уровня и завершённое исследование", 409)

            val message = when (command.action) {
                "create_listing" -> create(c, user.id, before.state, command)
                "buy_listing", "cancel_listing" -> {
                    val row = c.economyRows("""SELECT l.*,u.public_id,u.display_name FROM economy_market_listings l
                        JOIN app_users u ON u.id=l.seller_id WHERE l.id=? AND u.deleted_at IS NULL AND u.banned_at IS NULL
                        FOR UPDATE OF l""", listingId) { listing(it, user.id) }.firstOrNull()
                        ?: throw AuthFailure("ECONOMY_MARKET_NOT_FOUND", "Объявление не найдено", 404)
                    if (row.seller != seller) throw AuthFailure("ECONOMY_MARKET_NOT_ACTIVE", "Объявление изменилось", 409)
                    if (row.listing.status != "active") throw AuthFailure("ECONOMY_MARKET_NOT_ACTIVE", "Объявление уже закрыто", 409)
                    if (command.action == "buy_listing") buy(c, user.id, before.state, row, command)
                    else cancel(c, user.id, before.state, row)
                }
                else -> error("Validated market action")
            }
            val view = economyView(c, user.id, user.publicId, now(c))
            c.economyUpdate("""INSERT INTO economy_market_receipts(user_id,request_id,signature,message,accepted_revision)
                VALUES (?,?,?,?,?)""", user.id, requestId, signature, message, view.revision)
            EconomyResult(view, message, view.revision)
        }
    }

    private fun create(c: Connection, user: UUID, state: EconomyState, command: EconomyCommand): String {
        val item = EconomyRules.catalog.items.firstOrNull { it.id == command.targetId && it.tradable }
            ?: throw AuthFailure("ECONOMY_MARKET_ITEM", "Этот предмет нельзя выставить на рынок", 400)
        val marketConfig = EconomyRules.catalog.market
        EconomyMarketRules.validatePrice(command.quantity, command.totalPrice, item.baseSellPrice, marketConfig.maxPriceMultiplier)
        val active = c.economyRows("SELECT count(*) FROM economy_market_listings WHERE seller_id=? AND status='active'", user) { it.getInt(1) }.single()
        if (active >= marketConfig.maxListings) throw AuthFailure("ECONOMY_MARKET_LIMIT", "Достигнут лимит активных объявлений", 409)
        val available = state.inventory[item.id] ?: 0L
        if (available < command.quantity) throw AuthFailure("ECONOMY_RESOURCES", "Недостаточно предметов для этой партии", 409)
        val inventory = state.inventory + (item.id to available - command.quantity)
        val id = UUID.randomUUID()
        val reservedBefore = reservedEconomyMarketItems(c, user)
        c.economyUpdate("""INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price)
            VALUES (?,?,?,?,?)""", id, user, item.id, command.quantity, command.totalPrice)
        val next = state.copy(inventory = inventory)
        assertEconomyMarketCapacity(c, user, state, next, reservedBefore)
        saveEconomyProfile(c, user, next)
        ledger(c, user, "market:create:$id", "market_create", 0L, item.id, -command.quantity)
        return "Партия выставлена на рынок"
    }

    private fun buy(c: Connection, user: UUID, state: EconomyState, row: ListingRow, command: EconomyCommand): String {
        if (row.seller == user) throw AuthFailure("ECONOMY_MARKET_SELF_TRADE", "Нельзя купить свою партию", 409)
        val lot = row.listing
        if (lot.quantity != command.quantity || lot.totalPrice != command.totalPrice)
            throw AuthFailure("ECONOMY_MARKET_QUOTE_CHANGED", "Проверьте состав и цену партии", 409)
        if (EconomyRules.catalog.items.none { it.id == lot.itemId && it.tradable })
            throw AuthFailure("ECONOMY_MARKET_ITEM", "Торговля этим предметом приостановлена", 409)
        if (state.wallet.coins < lot.totalPrice) throw AuthFailure("ECONOMY_RESOURCES", "Недостаточно монет", 409)
        ensureEconomyProfile(c, row.seller)
        val seller = readEconomyProfile(c, row.seller).state
        if (seller.wallet.coins > ECONOMY_MAX_BALANCE - lot.totalPrice)
            throw AuthFailure("ECONOMY_CAPACITY", "Продавец пока не может принять монеты", 409)
        val amount = state.inventory[lot.itemId] ?: 0L
        if (amount > ECONOMY_MAX_BALANCE - lot.quantity)
            throw AuthFailure("ECONOMY_CAPACITY", "Освободите место для предметов", 409)
        val inventory = state.inventory + (lot.itemId to amount + lot.quantity)
        val next = state.copy(wallet = state.wallet.copy(coins = state.wallet.coins - lot.totalPrice), inventory = inventory)
        assertEconomyMarketCapacity(c, user, state, next)
        c.economyUpdate("UPDATE economy_market_listings SET status='sold',buyer_id=?,closed_at=clock_timestamp() WHERE id=?", user, UUID.fromString(lot.id))
        saveEconomyProfile(c, user, next)
        saveEconomyProfile(c, row.seller, seller.copy(wallet = seller.wallet.copy(coins = seller.wallet.coins + lot.totalPrice)))
        ledger(c, user, "market:buy:${lot.id}", "market_buy", -lot.totalPrice, lot.itemId, lot.quantity)
        ledger(c, row.seller, "market:sell:${lot.id}", "market_sell", lot.totalPrice, lot.itemId, 0L)
        return "Партия куплена"
    }

    private fun cancel(c: Connection, user: UUID, state: EconomyState, row: ListingRow): String {
        if (row.seller != user) throw AuthFailure("ECONOMY_MARKET_OWNER", "Отменить объявление может только продавец", 403)
        val lot = row.listing
        val inventory = state.inventory + (lot.itemId to Math.addExact(state.inventory[lot.itemId] ?: 0L, lot.quantity))
        val reservedBefore = reservedEconomyMarketItems(c, user)
        c.economyUpdate("UPDATE economy_market_listings SET status='cancelled',closed_at=clock_timestamp() WHERE id=?", UUID.fromString(lot.id))
        val next = state.copy(inventory = inventory)
        assertEconomyMarketCapacity(c, user, state, next, reservedBefore)
        saveEconomyProfile(c, user, next)
        ledger(c, user, "market:cancel:${lot.id}", "market_cancel", 0L, lot.itemId, lot.quantity)
        return "Объявление снято, предметы возвращены"
    }

    private fun ledger(c: Connection, user: UUID, sourceKey: String, kind: String, coins: Long, item: String, quantity: Long) {
        c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,items) VALUES (?,?,?,?,?::jsonb)""",
            user, sourceKey, kind, coins, economyJson.encodeToString(if (quantity == 0L) emptyMap() else mapOf(item to quantity)))
    }
}
