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
    c.economyRows("""SELECT item_id,sum(quantity) FROM (
        SELECT item_id,quantity FROM economy_market_listings WHERE seller_id=? AND status='active'
        UNION ALL SELECT offered_item_id,1::bigint FROM economy_barter_offers WHERE seller_id=? AND status='active'
        ) held GROUP BY item_id""", user, user) { it.getString(1) to it.getLong(2) }.toMap()

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
        amount < 0L || held < 0L || held > ECONOMY_MAX_ITEMS || amount > ECONOMY_MAX_ITEMS - held
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
            totalPrice = EconomyMoney.nominal(result.getLong("total_price"),result.getInt("currency_scale")), status = result.getString("status"),
            createdAt = result.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
            closedAt = result.getObject("closed_at", OffsetDateTime::class.java)?.toInstant()?.toString(),
            owned = seller == owner, feeBps = result.getInt("seller_fee_bps"),
        ))
    }

    private data class Showcase(val refreshAt: Instant, val ids: List<UUID>)

    private fun readShowcase(c: Connection, user: UUID): Showcase? = c.economyRows(
        "SELECT refresh_at,listing_ids FROM economy_market_showcases WHERE user_id=?", user) {
        Showcase(it.getObject(1, OffsetDateTime::class.java).toInstant(),
            (it.getArray(2).array as Array<*>).map { id -> UUID.fromString(id.toString()) })
    }.firstOrNull()

    /** The account lock serializes first reads, refreshes and purchases across devices. */
    private fun showcase(c: Connection, user: UUID, state: EconomyState, at: Instant): Showcase {
        readShowcase(c, user)?.takeIf { at.isBefore(it.refreshAt) }?.let { return it }
        val config = EconomyRules.catalog.market
        val home = state.buildings["home"] ?: 1
        val band = EconomyMarketRules.homeBand(home)
        val items = EconomyRules.catalog.items.filter { it.tradable && home >= EconomyMarketRules.requiredHomeLevel(it.id) }
        val ids = if (items.isEmpty()) emptyList() else {
            val values = items.joinToString(",") { "(?::text,?::bigint)" }
            val parameters = items.flatMap { listOf<Any?>(it.id, it.baseSellPrice) }.toMutableList()
            parameters.add(user.toString() + at.toString())
            parameters.add(user)
            parameters.add(band.first); parameters.add(band.last)
            parameters.add(config.maxPriceMultiplier)
            parameters.add(config.showcasePerSeller)
            parameters.add(config.showcaseSlots)
            c.economyRows("""WITH prices(item_id,minimum) AS (VALUES $values), candidates AS (
                SELECT l.id,l.seller_id,md5(l.id::text || ?) AS rank
                FROM economy_market_listings l JOIN app_users u ON u.id=l.seller_id JOIN prices p ON p.item_id=l.item_id
                JOIN economy_profiles ep ON ep.user_id=l.seller_id
                WHERE l.status='active' AND l.seller_id<>? AND u.deleted_at IS NULL AND u.banned_at IS NULL
                  AND COALESCE((ep.state->'buildings'->>'home')::int,1) BETWEEN ? AND ?
                  AND l.total_price / l.quantity >= p.minimum AND l.total_price <= p.minimum * l.quantity * ?
            ), diverse AS (
                SELECT id,rank,row_number() OVER (PARTITION BY seller_id ORDER BY rank,id) AS seller_slot FROM candidates
            ) SELECT id FROM diverse WHERE seller_slot<=? ORDER BY rank,id LIMIT ?""", *parameters.toTypedArray()) {
                it.getObject(1, UUID::class.java)
            }
        }
        val result = Showcase(at.plusSeconds(config.showcaseRefreshSeconds), ids)
        c.prepareStatement("""INSERT INTO economy_market_showcases(user_id,refresh_at,listing_ids) VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET refresh_at=EXCLUDED.refresh_at,listing_ids=EXCLUDED.listing_ids""").use { statement ->
            statement.setObject(1, user)
            statement.setObject(2, OffsetDateTime.ofInstant(result.refreshAt, ZoneOffset.UTC))
            val array = c.createArrayOf("uuid", ids.toTypedArray())
            try { statement.setArray(3, array); statement.executeUpdate() } finally { array.free() }
        }
        return result
    }

    override suspend fun market(sessionHash: ByteArray, cursor: String?, limit: Int): EconomyMarketView {
        if (limit !in 1..EconomyRules.catalog.market.showcaseSlots || cursor != null)
            throw AuthFailure("INVALID_ECONOMY_QUERY", "Лавка содержит до 12 предложений без дополнительных страниц", 400)
        return transaction { c ->
            val initial = actor(c, sessionHash)
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
            val user = actor(c, sessionHash)
            if (user.id != initial.id) throw AuthFailure("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите лавку.", 409)
            ensureEconomyProfile(c, user.id)
            val state = readEconomyProfile(c, user.id).state
            val config = EconomyRules.catalog.market
            val at = now(c)
            val unlocked = (state.buildings["home"] ?: 1) >= config.requiredHomeLevel && state.completedExplorations >= config.requiredExplorations
            val band = EconomyMarketRules.homeBand(state.buildings["home"] ?: 1)
            val selection = if (unlocked) showcase(c, user.id, state, at) else Showcase(at.plusSeconds(config.showcaseRefreshSeconds), emptyList())
            val selected = if (selection.ids.isEmpty()) emptyList() else c.economyRows("""SELECT l.*,u.public_id,u.display_name FROM economy_market_listings l
                JOIN app_users u ON u.id=l.seller_id JOIN economy_profiles ep ON ep.user_id=l.seller_id WHERE l.id IN (${selection.ids.joinToString(",") { "?" }})
                AND l.status='active' AND u.deleted_at IS NULL AND u.banned_at IS NULL
                AND COALESCE((ep.state->'buildings'->>'home')::int,1) BETWEEN ? AND ?""",
                *(selection.ids + listOf(band.first, band.last)).toTypedArray<Any>()) { listing(it, user.id).listing }
                .filter { EconomyMarketRules.eligible(it.itemId, it.quantity, it.totalPrice, state.buildings["home"] ?: 1) }
                .sortedBy { selection.ids.indexOf(UUID.fromString(it.id)) }
            val mine = c.economyRows("""SELECT l.*,u.public_id,u.display_name FROM economy_market_listings l
                JOIN app_users u ON u.id=l.seller_id WHERE l.status='active' AND l.seller_id=?
                ORDER BY l.created_at DESC,l.id DESC LIMIT ?""", user.id, config.maxListings) { listing(it, user.id).listing }
            val usage = readEconomyTradeUsage(c, user.id, at)
            EconomyMarketView(selected.take(limit), mine, serverTime=at.toString(), showcase=EconomyMarketShowcase(
                selection.refreshAt.toString(), config.showcaseSlots, config.showcasePerSeller, config.showcaseRefreshSeconds),
                tradeBudget=EconomyMarketTradeBudget(usage.buys, usage.sales,
                    EconomyMarketRules.dailyTradeLimit(state.buildings["home"] ?: 1), economyTradeResetsAt(at),
                    config.feeBps, band.first, band.last))
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
            if (c.economyRows("SELECT 1 FROM economy_barter_receipts WHERE user_id=? AND request_id=? UNION ALL SELECT 1 FROM game_reward_claims WHERE user_id=? AND request_id=?", user.id, requestId, user.id, requestId) { true }.isNotEmpty())
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
        if ((state.buildings["home"] ?: 1) < EconomyMarketRules.requiredHomeLevel(item.id))
            throw AuthFailure("ECONOMY_MARKET_ITEM_LOCKED", "Предмет пока недоступен на вашем уровне дома", 409)
        val marketConfig = EconomyRules.catalog.market
        EconomyMarketRules.validatePrice(command.quantity, command.totalPrice, item.baseSellPrice, marketConfig.maxPriceMultiplier)
        if (item.baseSellPrice * command.quantity > EconomyMarketRules.dailyTradeLimit(state.buildings["home"] ?: 1))
            throw AuthFailure("ECONOMY_MARKET_DAILY_LOT_LIMIT", "Уменьшите партию: её базовая стоимость превышает дневной объём торговли", 409)
        val active = c.economyRows("SELECT count(*) FROM economy_market_listings WHERE seller_id=? AND status='active'", user) { it.getInt(1) }.single()
        if (active >= marketConfig.maxListings) throw AuthFailure("ECONOMY_MARKET_LIMIT", "Достигнут лимит активных объявлений", 409)
        val available = state.inventory[item.id] ?: 0L
        if (available < command.quantity) throw AuthFailure("ECONOMY_RESOURCES", "Недостаточно предметов для этой партии", 409)
        val inventory = state.inventory + (item.id to available - command.quantity)
        val id = UUID.randomUUID()
        val reservedBefore = reservedEconomyMarketItems(c, user)
        c.economyUpdate("""INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price,seller_fee_bps)
            VALUES (?,?,?,?,?,?)""", id, user, item.id, command.quantity, command.totalPrice, marketConfig.feeBps)
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
        val at = now(c)
        val selection = readShowcase(c, user)
        if (selection == null || !at.isBefore(selection.refreshAt) || UUID.fromString(lot.id) !in selection.ids)
            throw AuthFailure("ECONOMY_MARKET_SHOWCASE_CHANGED", "Предложение вне текущей витрины. Обновите лавку.", 409)
        if (!EconomyMarketRules.eligible(lot.itemId, lot.quantity, lot.totalPrice, state.buildings["home"] ?: 1))
            throw AuthFailure("ECONOMY_MARKET_ITEM_LOCKED", "Предмет пока недоступен на вашем уровне дома или цена устарела", 409)
        if (state.wallet.coins < lot.totalPrice) throw AuthFailure("ECONOMY_RESOURCES", "Недостаточно монет", 409)
        ensureEconomyProfile(c, row.seller)
        val seller = readEconomyProfile(c, row.seller).state
        if (!EconomyMarketRules.sameHomeBand(state.buildings["home"] ?: 1, seller.buildings["home"] ?: 1))
            throw AuthFailure("ECONOMY_MARKET_HOME_BAND", "Предложение доступно в другой группе уровней дома. Обновите лавку.", 409)
        val item = EconomyRules.catalog.items.single { it.id == lot.itemId }
        val tradeValue = item.baseSellPrice * lot.quantity
        EconomyMarketRules.assertTradeBudget(readEconomyTradeUsage(c, user, at).buys, tradeValue,
            EconomyMarketRules.dailyTradeLimit(state.buildings["home"] ?: 1))
        EconomyMarketRules.assertTradeBudget(readEconomyTradeUsage(c, row.seller, at).sales, tradeValue,
            EconomyMarketRules.dailyTradeLimit(seller.buildings["home"] ?: 1), seller=true)
        val sellerProceeds = lot.totalPrice - EconomyMarketRules.sellerFee(lot.totalPrice, lot.feeBps)
        if (seller.wallet.coins > ECONOMY_MAX_BALANCE - sellerProceeds)
            throw AuthFailure("ECONOMY_CAPACITY", "Продавец пока не может принять монеты", 409)
        val amount = state.inventory[lot.itemId] ?: 0L
        if (amount > ECONOMY_MAX_ITEMS - lot.quantity)
            throw AuthFailure("ECONOMY_CAPACITY", "Освободите место для предметов", 409)
        val inventory = state.inventory + (lot.itemId to amount + lot.quantity)
        val next = state.copy(wallet = state.wallet.copy(coins = state.wallet.coins - lot.totalPrice), inventory = inventory)
        assertEconomyMarketCapacity(c, user, state, next)
        c.economyUpdate("UPDATE economy_market_listings SET status='sold',buyer_id=?,closed_at=clock_timestamp() WHERE id=?", user, UUID.fromString(lot.id))
        saveEconomyProfile(c, user, next)
        saveEconomyProfile(c, row.seller, seller.copy(wallet = seller.wallet.copy(coins = seller.wallet.coins + sellerProceeds)))
        addEconomyTradeUsage(c, user, at, buys=tradeValue)
        addEconomyTradeUsage(c, row.seller, at, sales=tradeValue)
        ledger(c, user, "market:buy:${lot.id}", "market_buy", -lot.totalPrice, lot.itemId, lot.quantity)
        ledger(c, row.seller, "market:sell:${lot.id}", "market_sell", sellerProceeds, lot.itemId, 0L)
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
