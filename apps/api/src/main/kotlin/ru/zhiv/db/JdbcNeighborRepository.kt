package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import ru.zhiv.admin.AdminConfig
import ru.zhiv.admin.validAdminReason
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import ru.zhiv.relationships.GuestWorldScene
import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

/** One global advisory lock serializes config and NPC budgets. Acquire it before
 * account locks; player market writers never need it. Account -> listing order
 * remains identical to human trades, reset, merge and cancel. */
class JdbcNeighborRepository(private val source: DataSource, private val adminConfig: AdminConfig) : NeighborRepository {
    private data class Actor(val id: UUID, val publicId: String, val name: String)
    private data class Config(val settings: NeighborSettings, val version: Long, val pause: String?)
    private data class Lot(val id: UUID, val seller: UUID, val publicId: String, val name: String,
        val itemId: String, val quantity: Long, val price: Long, val fee: Int, val created: Instant, val status: String)
    private fun fail(code: String, message: String, status: Int = 409): Nothing = throw AuthFailure(code, message, status)
    private fun now(c: Connection): Instant = c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java).toInstant() }.single()
    private fun lock(c: Connection) { c.economyRows("SELECT pg_advisory_xact_lock(28753,1)") { true } }
    private fun actor(c: Connection, hash: ByteArray, admin: Boolean = false, lockedSession: Boolean = false): Actor {
        val a = c.economyRows("""SELECT u.id,u.public_id,u.display_name FROM app_users u JOIN app_sessions s ON s.user_id=u.id
            WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL AND u.banned_at IS NULL ${if(lockedSession) "FOR UPDATE OF s" else ""}""", hash) {
            Actor(it.getObject(1, UUID::class.java), it.getString(2), it.getString(3))
        }.firstOrNull() ?: fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
        if (admin && a.publicId !in adminConfig.allowedPublicIds) fail("ADMIN_FORBIDDEN", "Нет доступа к панели управления", 403)
        return a
    }
    private suspend fun <T> tx(body: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c -> c.autoCommit = false
            try { c.economyUpdate("SET LOCAL lock_timeout='3s'"); val result=body(c); c.commit(); result }
            catch (e: Exception) { c.rollback(); throw e }
        }
    }
    private fun config(c: Connection): Config = c.economyRows("SELECT settings,version,paused_reason FROM neighbor_settings WHERE singleton") {
        Config(NeighborRules.validate(economyJson.decodeFromString<NeighborSettings>(it.getString(1))),it.getLong(2),it.getString(3))
    }.singleOrNull() ?: Config(NeighborRules.defaults,0,null)
    private fun usage(c: Connection, user: UUID?, at: Instant): NeighborUsage {
        val personal = user?.let { id -> c.economyRows("SELECT used_lots,spent_coins FROM neighbor_daily_usage WHERE user_id=? AND trade_day=?",id,economyTradeDay(at)) {
            it.getLong(1) to it.getLong(2)
        }.singleOrNull() } ?: (0L to 0L)
        val global = c.economyRows("SELECT spent_coins FROM neighbor_global_usage WHERE trade_day=?",economyTradeDay(at)) { it.getLong(1) }.singleOrNull() ?: 0L
        return NeighborUsage(personal.first,personal.second,global)
    }
    private fun offers(c: Connection, user: UUID, at: Instant): List<NeighborOffer>? = c.economyRows(
        "SELECT offers,purchased_items FROM neighbor_shop_cycles WHERE user_id=? AND cycle_day=?",user,economyTradeDay(at)) {
        val purchased=economyJson.decodeFromString<List<String>>(it.getString(2)).toSet()
        economyJson.decodeFromString<List<NeighborOffer>>(it.getString(1)).map { offer ->
            if(offer.itemId in purchased) offer.copy(purchased=true) else offer
        }
    }.singleOrNull()
    private fun snapshotOffers(c: Connection,user: UUID,state: EconomyState,at: Instant,s: NeighborSettings): List<NeighborOffer> {
        offers(c,user,at)?.let { return it }
        // Sorting by a stable daily digest avoids rerolls across devices or settings.
        val selected = NeighborRules.eligibleItems(state,s).sortedBy { item ->
            java.security.MessageDigest.getInstance("SHA-256").digest("$user:${economyTradeDay(at)}:${item.id}".toByteArray())
                .joinToString("") { "%02x".format(it) }
        }.map { item -> item to NeighborRules.sellPrice(maxOf(item.baseSellPrice,EconomyRules.localSellPrice(item.baseSellPrice,itemId=item.id)),s.offerQuantity,s) }
            .filter { (_,price) -> price in 0..ECONOMY_MAX_BALANCE }
            .let { candidates -> candidates.take(minOf(s.offerSlots,candidates.size.toLong()).toInt()) }
            .map { (item,price) -> NeighborOffer(UUID.randomUUID().toString(),item.id,s.offerQuantity,price) }
        c.economyUpdate("INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers) VALUES (?,?,?::jsonb)",user,economyTradeDay(at),economyJson.encodeToString(selected))
        return selected
    }
    private fun lockActor(c: Connection, hash: ByteArray, owner: String? = null): Actor {
        val first = actor(c,hash)
        c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",first.id) { true }
        val current = actor(c,hash)
        if (current.id != first.id || (owner != null && current.publicId != owner)) fail("ECONOMY_OWNER_CHANGED","Открыт другой профиль. Обновите хозяйство.")
        return current
    }
    override suspend fun neighbor(sessionHash: ByteArray): NeighborView = tx { c ->
        lock(c); val a=lockActor(c,sessionHash); val cfg=config(c); val at=now(c)
        ensureEconomyProfile(c,a.id)
        val state=readEconomyProfile(c,a.id).state
        val available=cfg.settings.enabled && EconomyMarketRules.unlocked(state)
        val stock=if(available) snapshotOffers(c,a.id,state,at,cfg.settings) else offers(c,a.id,at).orEmpty()
        // Keep the stored day and purchase fences intact; hide goods the player can no longer access.
        val visibleItems=NeighborRules.eligibleItems(state,cfg.settings).map { it.id }.toSet()
        val visibleStock=stock.filter { it.itemId in visibleItems }
        val u=usage(c,a.id,at); val s=cfg.settings
        NeighborView(a.publicId,at.toString(),NeighborCharacter(name=s.name,description=s.description,
            world=GuestWorldScene(s.buildings,s.equipment,emptyList(),emptyList(),emptyList())),
            NeighborShop(economyTradeDay(at).toString(),economyTradeResetsAt(at),available,
                if(!s.enabled) "paused" else if(!available) "market_locked" else null,visibleStock),
            NeighborBuying(s.enabled && s.autoBuyEnabled && cfg.pause==null && NeighborRules.active(at,s),s.firstDelaySeconds,s.staleAfterSeconds,
                s.maxLotsPerDay,s.dailyBudgetCoins,s.maxLotCoins,u.usedLots,u.spentCoins))
    }
    override suspend fun purchase(sessionHash: ByteArray, command: EconomyCommand): EconomyResult {
        NeighborRules.validatePurchase(command)
        return tx { c ->
            lock(c); val a=lockActor(c,sessionHash,command.ownerPublicId); ensureEconomyProfile(c,a.id)
            val request=UUID.fromString(command.requestId); val signature="neighbor:"+economyJson.encodeToString(command)
            val previous=c.economyRows("SELECT signature,message,accepted_revision FROM neighbor_receipts WHERE user_id=? AND request_id=?",a.id,request) {
                Triple(it.getString(1),it.getString(2),it.getLong(3))
            }.singleOrNull()
            if(previous!=null) {
                if(previous.first!=signature) fail("ECONOMY_REQUEST_CONFLICT","Этот запрос уже использован с другими параметрами")
                return@tx EconomyResult(economyView(c,a.id,a.publicId,now(c)),previous.second,previous.third,true)
            }
            // Write the same receipt into the existing market journal below: its
            // established cross-domain fences reject reuse in any other endpoint.
            if(c.economyRows("""SELECT 1 FROM economy_commands WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_market_receipts WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_barter_receipts WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM game_reward_claims WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM promo_redemptions WHERE user_id=? AND request_id=?""",
                a.id,request,a.id,request,a.id,request,a.id,request,a.id,request) { true }.isNotEmpty()) fail("ECONOMY_REQUEST_CONFLICT","Этот запрос уже использован")
            val row=readEconomyProfile(c,a.id); val at=now(c); val s=config(c).settings
            if(row.revision!=command.expectedRevision) fail("ECONOMY_REVISION_CONFLICT","Хозяйство изменилось. Обновите его.")
            if(!s.enabled || !EconomyMarketRules.unlocked(row.state)) fail("NEIGHBOR_UNAVAILABLE","Лавка соседа сейчас недоступна")
            val stock=offers(c,a.id,at) ?: fail("NEIGHBOR_OFFER_UNAVAILABLE","Обновите лавку соседа")
            val offer=stock.find { it.id==command.targetId && !it.purchased } ?: fail("NEIGHBOR_OFFER_UNAVAILABLE","Предложение уже куплено или закончилось")
            if(offer.quantity!=command.quantity || command.totalPrice<offer.totalPrice) fail("NEIGHBOR_QUOTE_CHANGED","Проверьте состав и цену партии")
            if(NeighborRules.eligibleItems(row.state,s).none { it.id==offer.itemId }) fail("NEIGHBOR_OFFER_UNAVAILABLE","Предмет ещё не открыт или его продажа приостановлена")
            val definition=EconomyRules.catalog.items.single { it.id==offer.itemId }
            val tradeValue=definition.baseSellPrice*offer.quantity
            EconomyMarketRules.assertTradeBudget(readEconomyTradeUsage(c,a.id,at).buys,tradeValue,EconomyMarketRules.dailyTradeLimit(row.state.buildings["home"] ?: 1))
            if(row.state.wallet.coins<offer.totalPrice) fail("ECONOMY_RESOURCES","Недостаточно монет")
            val next=row.state.copy(wallet=row.state.wallet.copy(coins=row.state.wallet.coins-offer.totalPrice),
                inventory=EconomyRules.addItems(row.state.inventory,mapOf(offer.itemId to offer.quantity)))
            assertEconomyMarketCapacity(c,a.id,row.state,next)
            c.economyUpdate("UPDATE neighbor_shop_cycles SET offers=?::jsonb,purchased_items=purchased_items || to_jsonb(?::text) WHERE user_id=? AND cycle_day=?",
                economyJson.encodeToString(stock.map { if(it.id==offer.id) it.copy(purchased=true) else it }),offer.itemId,a.id,economyTradeDay(at))
            saveEconomyProfile(c,a.id,next); addEconomyTradeUsage(c,a.id,at,buys=tradeValue)
            c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,items) VALUES (?,?,'neighbor_buy_offer',?,?::jsonb)",
                a.id,"neighbor:offer:${offer.id}",-offer.totalPrice,economyJson.encodeToString(mapOf(offer.itemId to offer.quantity)))
            val view=economyView(c,a.id,a.publicId,at); val message="Партия куплена в лавке соседа"
            c.economyUpdate("INSERT INTO neighbor_receipts(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,?,?,?)",a.id,request,signature,message,view.revision)
            c.economyUpdate("INSERT INTO economy_market_receipts(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,?,?,?)",a.id,request,signature,message,view.revision)
            EconomyResult(view,message,view.revision)
        }
    }
    private fun lot(c: Connection,id: UUID,locking: Boolean=false): Lot? = c.economyRows("""SELECT l.*,u.public_id,u.display_name
        FROM economy_market_listings l JOIN app_users u ON u.id=l.seller_id WHERE l.id=? ${if(locking) "FOR UPDATE OF l" else ""}""",id) {
        Lot(it.getObject("id",UUID::class.java),it.getObject("seller_id",UUID::class.java),it.getString("public_id"),it.getString("display_name"),
            it.getString("item_id"),it.getLong("quantity"),EconomyMoney.nominal(it.getLong("total_price"),it.getInt("currency_scale")),
            it.getInt("seller_fee_bps"),it.getObject("created_at",OffsetDateTime::class.java).toInstant(),it.getString("status"))
    }.singleOrNull()
    private fun first(c: Connection,user: UUID): Boolean =
        !c.economyRows("SELECT first_buy_consumed FROM neighbor_identity WHERE user_id=?",user) { it.getBoolean(1) }.any { it } &&
        !c.economyRows("SELECT 1 FROM economy_market_listings WHERE seller_id IN (SELECT user_id FROM account_history_user_ids(?)) AND status='sold' LIMIT 1",user) { true }.any { it }
    private fun reason(c: Connection,l: Lot,state: EconomyState,at: Instant,cfg: Config,manual: Boolean): String? {
        val s=cfg.settings
        if(!s.enabled) return "Сосед отключён"
        if(cfg.pause!=null) return cfg.pause
        if(!NeighborRules.active(at,s)) return "Вне времени работы"
        if(!manual && !s.autoBuyEnabled) return "Автоматический выкуп выключен"
        if(l.status!="active") return "Партия уже закрыта"
        val safe=c.economyRows("SELECT 1 FROM app_users WHERE id=? AND deleted_at IS NULL AND banned_at IS NULL AND NOT tap_watchlisted AND security_signal_at IS NULL",l.seller) { true }.isNotEmpty()
        if(!safe) return "Профиль требует проверки"
        if(!EconomyMarketRules.unlocked(state)) return "Рынок продавца закрыт"
        val item=NeighborRules.eligibleItems(state,s).find { it.id==l.itemId } ?: return "Этот товар не входит в ассортимент соседа"
        if(l.price<=0 || l.price>s.maxLotCoins || l.price>NeighborRules.buyCap(item.baseSellPrice,l.quantity,s) ||
            !EconomyMarketRules.eligible(l.itemId,l.quantity,l.price,state)) return "Цена или размер партии выше лимита"
        if(c.economyRows("SELECT 1 FROM neighbor_shop_cycles WHERE user_id=? AND cycle_day=? AND purchased_items @> to_jsonb(?::text)",l.seller,economyTradeDay(at),l.itemId) { true }.isNotEmpty()) return "Этот товар сегодня куплен у соседа"
        val u=usage(c,l.seller,at)
        if(u.usedLots>=s.maxLotsPerDay || l.price>s.dailyBudgetCoins-u.spentCoins) return "Дневной бюджет этого игрока исчерпан"
        if(l.price>s.globalDailyBudgetCoins-u.globalSpentCoins) return "Общий дневной бюджет исчерпан"
        val trade=item.baseSellPrice*l.quantity
        val limit=EconomyMarketRules.dailyTradeLimit(state.buildings["home"] ?: 1)
        if(trade>limit-readEconomyTradeUsage(c,l.seller,at).sales) return "Дневной объём торговли исчерпан"
        if(!manual) {
            val delay=if(first(c,l.seller)) s.firstDelaySeconds else s.staleAfterSeconds
            if(at.isBefore(l.created.plusSeconds(delay))) return "Партия ещё ждёт покупателей"
        }
        return null
    }
    /** Both scheduler and admin enter this same settlement. Global lock is held,
     * seller account precedes listing lock; a racing human purchase wins once. */
    private fun settle(c: Connection,id: UUID,at: Instant,cfg: Config,manual: Boolean,expectedSeller: String?=null,expectedPrice: Long?=null): Lot? {
        val original=lot(c,id) ?: return null
        c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",original.seller) { true }
        val l=lot(c,id,true) ?: return null
        if(expectedSeller!=null && (l.publicId!=expectedSeller || l.price!=expectedPrice)) fail("NEIGHBOR_QUOTE_CHANGED","Продавец или цена партии изменились")
        val exists=c.economyRows("SELECT 1 FROM economy_profiles WHERE user_id=?",l.seller) { true }.isNotEmpty()
        if(!exists) return null
        val state=readEconomyProfile(c,l.seller).state
        val why=reason(c,l,state,at,cfg,manual)
        if(why!=null) { if(manual) fail("NEIGHBOR_LISTING_UNAVAILABLE",why); return null }
        val proceeds=l.price-EconomyMarketRules.sellerFee(l.price,l.fee)
        // A full pending payout cannot overflow until explicit manual claim.
        c.economyUpdate("""UPDATE economy_market_listings SET status='sold',closed_at=?,buyer_id=NULL,
            sale_owner_id=seller_id,sale_proceeds_coins=?,sale_buyer_public_id=NULL,sale_buyer_name=?,sale_buyer_character_id='berest'
            WHERE id=? AND status='active'""",OffsetDateTime.ofInstant(at,java.time.ZoneOffset.UTC),proceeds,"${cfg.settings.name} · Персонаж мира",id)
        saveEconomyProfile(c,l.seller,EconomyFishStock.release(state,id.toString()))
        addEconomyTradeUsage(c,l.seller,at,sales=EconomyRules.catalog.items.single { it.id==l.itemId }.baseSellPrice*l.quantity)
        c.economyUpdate("""INSERT INTO neighbor_identity(user_id,first_buy_consumed) VALUES (?,true)
            ON CONFLICT(user_id) DO UPDATE SET first_buy_consumed=true""",l.seller)
        c.economyUpdate("""INSERT INTO neighbor_daily_usage(user_id,trade_day,used_lots,spent_coins) VALUES (?,?,1,?)
            ON CONFLICT(user_id,trade_day) DO UPDATE SET used_lots=neighbor_daily_usage.used_lots+1,spent_coins=neighbor_daily_usage.spent_coins+EXCLUDED.spent_coins""",l.seller,economyTradeDay(at),l.price)
        c.economyUpdate("""INSERT INTO neighbor_global_usage(trade_day,spent_coins) VALUES (?,?)
            ON CONFLICT(trade_day) DO UPDATE SET spent_coins=neighbor_global_usage.spent_coins+EXCLUDED.spent_coins""",economyTradeDay(at),l.price)
        c.economyUpdate("""INSERT INTO neighbor_purchases(id,listing_id,user_id,item_id,quantity,total_price,proceeds_coins,source,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)""",UUID.randomUUID(),id,l.seller,l.itemId,l.quantity,l.price,proceeds,if(manual) "manual" else "auto",OffsetDateTime.ofInstant(at,java.time.ZoneOffset.UTC))
        c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,items) VALUES (?,?,'neighbor_sold',0,'{}'::jsonb)",l.seller,"neighbor:sold:$id")
        return l
    }
    private fun adminView(c: Connection,publicId: String?=null,receipt: NeighborAdminReceipt?=null): NeighborAdminView {
        val cfg=config(c); val at=now(c)
        val player=publicId?.let { id -> c.economyRows("SELECT id,public_id,display_name FROM app_users WHERE public_id=? AND deleted_at IS NULL",id) {
            Actor(it.getObject(1,UUID::class.java),it.getString(2),it.getString(3))
        }.singleOrNull() ?: fail("NEIGHBOR_PLAYER_NOT_FOUND","Профиль не найден",404) }
        val ids=player?.let { p -> c.economyRows("SELECT id FROM economy_market_listings WHERE seller_id=? AND status='active' ORDER BY created_at,id LIMIT 100",p.id) { it.getObject(1,UUID::class.java) } }.orEmpty()
        val state=player?.let { p -> if(c.economyRows("SELECT 1 FROM economy_profiles WHERE user_id=?",p.id) { true }.isNotEmpty()) readEconomyProfile(c,p.id).state else null }
        val pending=ids.mapNotNull { lot(c,it) }.map { l ->
            val why=if(state==null) "Хозяйство не открыто" else reason(c,l,state,at,cfg,true)
            NeighborPending(l.id.toString(),l.publicId,l.name,l.itemId,l.quantity,l.price,l.price-EconomyMarketRules.sellerFee(l.price,l.fee),l.created.toString(),why==null,why)
        }
        val history=c.economyRows("""SELECT p.*,u.public_id FROM neighbor_purchases p JOIN app_users u ON u.id=p.user_id
            ${if(player!=null) "WHERE p.user_id=?" else ""} ORDER BY p.created_at DESC,p.id DESC LIMIT 50""",*listOfNotNull(player?.id).toTypedArray()) {
            NeighborPurchase(it.getObject("id").toString(),it.getObject("listing_id").toString(),it.getString("public_id"),it.getString("item_id"),
                it.getLong("quantity"),it.getLong("total_price"),it.getLong("proceeds_coins"),it.getObject("created_at",OffsetDateTime::class.java).toInstant().toString(),it.getString("source"))
        }
        val u=usage(c,player?.id,at)
        val pause=cfg.pause ?: if(!cfg.settings.enabled) "Сосед отключён" else if(!NeighborRules.active(at,cfg.settings)) "Вне времени работы"
            else if(u.globalSpentCoins>=cfg.settings.globalDailyBudgetCoins) "Общий дневной бюджет исчерпан" else null
        return NeighborAdminView(at.toString(),cfg.settings,cfg.version,pause,u,player?.let { NeighborAdminPlayer(it.publicId,it.name) },pending,history,receipt)
    }
    override suspend fun admin(sessionHash: ByteArray, publicId: String?): NeighborAdminView = tx { c ->
        actor(c,sessionHash,true)
        if(publicId!=null && parsePublicId(publicId)!=publicId) fail("INVALID_NEIGHBOR_PLAYER","Проверьте ID игрока",400)
        adminView(c,publicId)
    }
    private fun auditReplay(c: Connection,a: Actor,request: UUID,action: String,payload: JsonElement): Boolean {
        c.economyRows("SELECT pg_advisory_xact_lock(?)",request.mostSignificantBits xor request.leastSignificantBits) { true }
        return c.economyRows("SELECT actor_public_id,action,payload->'request' FROM admin_actions WHERE request_id=?",request) {
            if(it.getString(1)!=a.publicId || it.getString(2)!=action || economyJson.parseToJsonElement(it.getString(3))!=payload)
                fail("ADMIN_REQUEST_CONFLICT","Этот запрос уже использован с другими параметрами")
            true
        }.singleOrNull() ?: false
    }
    private fun audit(c: Connection,a: Actor,target: Actor,request: UUID,action: String,reason: String,payload: JsonElement) {
        c.economyUpdate("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,
            action,reason,affected_sessions,payload,changed) VALUES (?,?,?,?,?,?,?,0,?::jsonb,true)""",
            request,a.id,target.id,a.publicId,target.publicId,action,reason,buildJsonObject { put("request",payload) }.toString())
    }
    override suspend fun settings(sessionHash: ByteArray, command: NeighborSettingsCommand): NeighborAdminView {
        if(parseCanonicalUuidV4(command.requestId)==null || command.expectedVersion !in 0L..9_007_199_254_740_989L || !validAdminReason(command.reason)) fail("INVALID_NEIGHBOR_SETTINGS","Проверьте настройки и причину",400)
        NeighborRules.validate(command.settings)
        return tx { c ->
            lock(c); val a=actor(c,sessionHash,true); val request=UUID.fromString(command.requestId); val payload=economyJson.encodeToJsonElement(command)
            if(auditReplay(c,a,request,"neighbor_settings",payload)) return@tx adminView(c,receipt=NeighborAdminReceipt(command.requestId,true))
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",a.id) { true }
            actor(c,sessionHash,true,true)
            val cfg=config(c)
            if(cfg.version!=command.expectedVersion) fail("NEIGHBOR_VERSION_CONFLICT","Настройки изменились. Обновите их.")
            actor(c,sessionHash,true)
            c.economyUpdate("""INSERT INTO neighbor_settings(singleton,version,settings) VALUES (true,?,?::jsonb)
                ON CONFLICT(singleton) DO UPDATE SET version=EXCLUDED.version,settings=EXCLUDED.settings,paused_reason=NULL,updated_at=clock_timestamp()""",
                cfg.version+1,economyJson.encodeToString(command.settings))
            audit(c,a,a,request,"neighbor_settings",command.reason,payload)
            adminView(c,receipt=NeighborAdminReceipt(command.requestId))
        }
    }
    override suspend fun buy(sessionHash: ByteArray, command: NeighborBuyCommand): NeighborAdminView {
        if(parseCanonicalUuidV4(command.requestId)==null || parseCanonicalUuidV4(command.listingId)==null ||
            parsePublicId(command.playerPublicId)!=command.playerPublicId || command.expectedTotalPrice !in 1L..ECONOMY_MAX_BALANCE || !validAdminReason(command.reason))
            fail("INVALID_NEIGHBOR_BUY","Проверьте партию и причину",400)
        return tx { c ->
            lock(c); val a=actor(c,sessionHash,true); val request=UUID.fromString(command.requestId); val payload=economyJson.encodeToJsonElement(command)
            if(auditReplay(c,a,request,"neighbor_buy",payload)) return@tx adminView(c,command.playerPublicId,NeighborAdminReceipt(command.requestId,true))
            val initial=lot(c,UUID.fromString(command.listingId)) ?: fail("NEIGHBOR_LISTING_UNAVAILABLE","Объявление уже недоступно")
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",a.id,initial.seller) { true }
            actor(c,sessionHash,true,true)
            val bought=settle(c,UUID.fromString(command.listingId),now(c),config(c),true,command.playerPublicId,command.expectedTotalPrice)
                ?: fail("NEIGHBOR_LISTING_UNAVAILABLE","Объявление уже недоступно")
            actor(c,sessionHash,true)
            audit(c,a,Actor(bought.seller,bought.publicId,bought.name),request,"neighbor_buy",command.reason,payload)
            adminView(c,command.playerPublicId,NeighborAdminReceipt(command.requestId))
        }
    }
    /** Bounded batches run independently of reads and player presence. */
    private var scanAfter: Pair<Instant,UUID>? = null
    suspend fun runAutomaticBatch(limit: Int = 40): Int {
        require(limit in 1..100)
        val ids=tx { c ->
            val cfg=config(c); val at=now(c)
            if(!cfg.settings.autoBuyEnabled || cfg.pause!=null || !NeighborRules.active(at,cfg.settings)) return@tx emptyList<UUID>()
            val cursor=scanAfter
            val after=if(cursor==null) "" else "AND (created_at,id)>(?,?)"
            val params=mutableListOf<Any>(cfg.settings.maxLotCoins,OffsetDateTime.ofInstant(NeighborRules.candidateCutoff(at,cfg.settings),java.time.ZoneOffset.UTC))
            if(cursor!=null) { params.add(OffsetDateTime.ofInstant(cursor.first,java.time.ZoneOffset.UTC));params.add(cursor.second) }
            params.add(limit)
            val rows=c.economyRows("SELECT id,created_at FROM economy_market_listings WHERE status='active' AND total_price<=? AND created_at<=? $after ORDER BY created_at,id LIMIT ?",*params.toTypedArray()) {
                it.getObject(1,UUID::class.java) to it.getObject(2,OffsetDateTime::class.java).toInstant()
            }
            scanAfter=if(rows.size<limit) null else rows.last().let { it.second to it.first }
            rows.map { it.first }
        }
        var count=0
        for(id in ids) if(tx { c -> lock(c); settle(c,id,now(c),config(c),false)!=null }) count++
        return count
    }
    suspend fun pauseAutomatic(reason: String) = tx { c ->
        lock(c); val cfg=config(c)
        c.economyUpdate("""INSERT INTO neighbor_settings(singleton,version,settings,paused_reason) VALUES (true,?,?::jsonb,?)
            ON CONFLICT(singleton) DO UPDATE SET paused_reason=EXCLUDED.paused_reason,updated_at=clock_timestamp()""",
            maxOf(1,cfg.version),economyJson.encodeToString(cfg.settings),reason.take(240))
    }
}

/** Lifecycle already owns both account locks. Do not acquire the NPC global lock
 * here: account -> global would reverse neighbor transaction lock order. */
internal fun mergeNeighborState(c: Connection,target: UUID,source: UUID) {
    c.economyUpdate("""INSERT INTO neighbor_identity(user_id,first_buy_consumed)
        SELECT ?,first_buy_consumed FROM neighbor_identity WHERE user_id=?
        ON CONFLICT(user_id) DO UPDATE SET first_buy_consumed=neighbor_identity.first_buy_consumed OR EXCLUDED.first_buy_consumed""",target,source)
    c.economyUpdate("""INSERT INTO neighbor_daily_usage(user_id,trade_day,used_lots,spent_coins)
        SELECT ?,trade_day,used_lots,spent_coins FROM neighbor_daily_usage WHERE user_id=?
        ON CONFLICT(user_id,trade_day) DO UPDATE SET
        used_lots=LEAST(9007199254740991,neighbor_daily_usage.used_lots+EXCLUDED.used_lots),
        spent_coins=LEAST(9007199254740991,neighbor_daily_usage.spent_coins+EXCLUDED.spent_coins)""",target,source)
    c.economyUpdate("""INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers,purchased_items,created_at)
        SELECT ?,cycle_day,offers,purchased_items,created_at FROM neighbor_shop_cycles WHERE user_id=?
        ON CONFLICT(user_id,cycle_day) DO UPDATE SET purchased_items=COALESCE((SELECT jsonb_agg(DISTINCT value)
            FROM jsonb_array_elements(neighbor_shop_cycles.purchased_items || EXCLUDED.purchased_items)),'[]'::jsonb)""",target,source)
    c.economyUpdate("""INSERT INTO neighbor_receipts(user_id,request_id,signature,message,accepted_revision,created_at)
        SELECT ?,request_id,signature,message,accepted_revision,created_at FROM neighbor_receipts WHERE user_id=? ON CONFLICT DO NOTHING""",target,source)
    c.economyUpdate("UPDATE neighbor_purchases SET user_id=? WHERE user_id=?",target,source)
}
