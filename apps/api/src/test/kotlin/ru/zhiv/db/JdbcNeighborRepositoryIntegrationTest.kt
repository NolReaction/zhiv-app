package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcNeighborRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var market: JdbcEconomyMarketRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password,
            false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        economy = JdbcEconomyRepository(source)
        market = JdbcEconomyMarketRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clearMarket() {
        for (table in listOf("neighbor_purchases", "economy_market_showcases", "economy_market_listings", "neighbor_settings",
            "neighbor_shop_cycles", "neighbor_identity", "neighbor_daily_usage", "neighbor_global_usage", "neighbor_receipts"))
            execute("DELETE FROM $table")
    }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): Long = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getLong(1) }.single()
    }
    private suspend fun player(name: String = "Лавочник"): Player {
        val token = tokens.issue()
        val user = JdbcZhivRepository(source).bootstrap(name, tokens.issue().hash, token.hash, 365)
        economy.snapshot(token.hash)
        source.connection.use { c ->
            val old = readEconomyProfile(c, user.id).state
            val state = old.copy(wallet = old.wallet.copy(coins = 1000), inventory = mapOf("berries" to 20),
                buildings = old.buildings + mapOf("home" to 2, "bridge" to 1), completedExplorations = 1)
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), user.id)
            c.commit()
        }
        return Player(user.id, user.publicId, token.hash)
    }
    private suspend fun command(player: Player, action: String, target: String, quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), player.publicId, economy.snapshot(player.hash).revision,
            action, target, quantity, price)
    private suspend fun listing(player: Player, quantity: Long = 2, price: Long = 20): EconomyMarketListing {
        val previous = market.market(player.hash).mine.map { it.id }.toSet()
        market.command(player.hash, command(player, "create_listing", "berries", quantity, price))
        return market.market(player.hash).mine.single { it.id !in previous }
    }
    private fun age(lot: EconomyMarketListing, hours: Int = 0, minutes: Int = 0) =
        execute("UPDATE economy_market_listings SET created_at=clock_timestamp()-(? * interval '1 hour')-(? * interval '1 minute') WHERE id=?",
            hours, minutes, UUID.fromString(lot.id))

    @Test fun `personal daily shop freezes offers and purchases replay once without fake people or unknown goods`() = runBlocking<Unit> {
        val p = player(); val repository = JdbcNeighborRepository(source, AdminConfig(setOf(p.publicId)))
        val userCount = scalar("SELECT count(*) FROM app_users")
        val first = repository.neighbor(p.hash)
        assertEquals("berest", first.character.id)
        assertEquals("world_character", first.character.kind)
        assertEquals(3, first.character.world.buildings["home"])
        assertTrue(first.shop.available)
        assertEquals(3, first.shop.offers.size)
        assertTrue(first.shop.offers.none { it.itemId in setOf("ore", "tools", "reinforced_parts") })
        assertEquals(first.shop, repository.neighbor(p.hash).shop)
        assertEquals(userCount, scalar("SELECT count(*) FROM app_users"))
        assertEquals(0L, scalar("SELECT count(*) FROM neighbor_purchases"))
        val settings = NeighborSettingsCommand(UUID.randomUUID().toString(), 0, "Изменить оформление соседа",
            NeighborRules.defaults.copy(name = "Берест осенний"))
        repository.settings(p.hash, settings)
        assertEquals(first.shop.offers, repository.neighbor(p.hash).shop.offers,
            "Updating managed settings cannot reroll today's personal snapshot")
        val offer = first.shop.offers.first()
        val request = command(p, "buy_offer", offer.id, offer.quantity, offer.totalPrice + 10)
        val before = economy.snapshot(p.hash)
        val accepted = repository.purchase(p.hash, request)
        assertEquals(before.wallet.coins - offer.totalPrice, accepted.state.wallet.coins,
            "A maximum accepted quote never overcharges the shown frozen price")
        assertEquals((before.inventory[offer.itemId] ?: 0) + offer.quantity, accepted.state.inventory[offer.itemId])
        assertTrue(repository.purchase(p.hash, request).replayed)
        assertEquals(accepted.state.wallet, economy.snapshot(p.hash).wallet)
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_receipts WHERE user_id=?", p.id))
        assertTrue(repository.neighbor(p.hash).shop.offers.single { it.id == offer.id }.purchased)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            repository.purchase(p.hash, request.copy(totalPrice = request.totalPrice + 10))
        }.code)
        assertEquals("NEIGHBOR_OFFER_UNAVAILABLE", assertFailsWith<AuthFailure> {
            repository.purchase(p.hash, command(p, "buy_offer", offer.id, offer.quantity, offer.totalPrice))
        }.code)
    }

    @Test fun `first small lot gets delayed relief later lots wait six hours and normal proceeds need manual collection`() = runBlocking<Unit> {
        val p = player(); val repository = JdbcNeighborRepository(source, AdminConfig(emptySet()))
        val before = economy.snapshot(p.hash).wallet.coins
        val first = listing(p)
        assertEquals(0, repository.runAutomaticBatch())
        age(first, minutes = 4)
        assertEquals(1, repository.runAutomaticBatch())
        assertEquals(before, economy.snapshot(p.hash).wallet.coins)
        val sale = assertNotNull(market.market(p.hash).mine.single().sale)
        assertNull(sale.buyerPublicId)
        assertEquals("world_character", sale.buyerKind)
        assertEquals("berest", sale.buyerCharacterId)
        assertEquals("Берест · Персонаж мира", sale.buyerName)
        assertEquals(19L, sale.proceedsCoins)
        assertNull(sale.claimedAt)
        val claim = command(p, "claim_sale", first.id)
        val claimed = market.command(p.hash, claim)
        assertEquals(before + 19, claimed.state.wallet.coins)
        assertTrue(market.command(p.hash, claim).replayed)
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases"))
        val second = listing(p); age(second, minutes = 4)
        assertEquals(0, repository.runAutomaticBatch(), "A lifetime first-sale bonus is not reused by a new lot")
        age(second, hours = 7)
        assertEquals(1, repository.runAutomaticBatch())
        val third = listing(p); age(third, hours = 7)
        assertEquals(0, repository.runAutomaticBatch(), "The normal two-lot daily allowance is hard capped")
        val view = repository.neighbor(p.hash)
        assertEquals(2L, view.buying.usedLots)
        assertEquals(40L, view.buying.spentCoins)
        assertEquals(40L, scalar("SELECT spent_coins FROM neighbor_global_usage"))
        assertEquals(2L, scalar("SELECT count(*) FROM neighbor_purchases"))
        assertEquals(0L, scalar("SELECT count(*) FROM game_achievements WHERE user_id=? AND achievement_id='first_sale'", p.id),
            "An NPC purchase cannot award the achievement that requires another player")
    }

    @Test fun `manual buy shares automatic budgets and audit receipt and never bypasses disabled neighbor`() = runBlocking<Unit> {
        val administrator = player("Администратор"); val seller = player()
        val repository = JdbcNeighborRepository(source, AdminConfig(setOf(administrator.publicId)))
        val lot = listing(seller)
        val pending = repository.admin(administrator.hash, seller.publicId).pending.single { it.id == lot.id }
        assertTrue(pending.eligible)
        assertNull(pending.reason, "An eligible pending lot must not display a fallback unavailability reason")
        val request = NeighborBuyCommand(UUID.randomUUID().toString(), lot.id, seller.publicId, lot.totalPrice, "Проверить помощь начинающему игроку")
        assertEquals("ADMIN_FORBIDDEN", assertFailsWith<AuthFailure> { repository.buy(seller.hash, request) }.code)
        val result = repository.buy(administrator.hash, request)
        assertFalse(assertNotNull(result.receipt).replayed)
        assertTrue(assertNotNull(repository.buy(administrator.hash, request).receipt).replayed)
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases"))
        assertEquals(1L, scalar("SELECT count(*) FROM admin_actions WHERE request_id=? AND action='neighbor_buy'", UUID.fromString(request.requestId)))
        assertEquals(0, repository.runAutomaticBatch())
        val next = listing(seller)
        repository.settings(administrator.hash, NeighborSettingsCommand(UUID.randomUUID().toString(), 0, "Временно отключить соседа",
            NeighborRules.defaults.copy(enabled = false)))
        assertEquals("NEIGHBOR_LISTING_UNAVAILABLE", assertFailsWith<AuthFailure> {
            repository.buy(administrator.hash, request.copy(requestId = UUID.randomUUID().toString(), listingId = next.id))
        }.code)
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases"))
    }

    @Test fun `human buyer racing automatic settlement transfers a listing only once`() = runBlocking<Unit> {
        val seller = player(); val buyer = player("Настоящий покупатель")
        val repository = JdbcNeighborRepository(source, AdminConfig(emptySet()))
        val lot = listing(seller); age(lot, minutes = 4)
        assertTrue(market.market(buyer.hash).listings.any { it.id == lot.id })
        val request = command(buyer, "buy_listing", lot.id, lot.quantity, lot.totalPrice)
        val automatic = async(Dispatchers.IO) { repository.runAutomaticBatch() }
        val human = async(Dispatchers.IO) { runCatching { market.command(buyer.hash, request) } }
        val automaticCount = automatic.await()
        val bought = human.await()
        assertEquals(1, automaticCount + if (bought.isSuccess) 1 else 0)
        assertEquals(1L, scalar("SELECT count(*) FROM economy_market_listings WHERE id=? AND status='sold'", UUID.fromString(lot.id)))
        assertEquals(automaticCount.toLong(), scalar("SELECT count(*) FROM neighbor_purchases WHERE listing_id=?", UUID.fromString(lot.id)))
        assertEquals(19L, market.market(seller.hash).mine.single().sale?.proceedsCoins)
        if (bought.isFailure) assertEquals("ECONOMY_MARKET_NOT_ACTIVE", assertIs<AuthFailure>(bought.exceptionOrNull()).code)
    }

    @Test fun `automatic cursor advances beyond a full batch of blocked oldest listings`() = runBlocking<Unit> {
        val blocked = player("Проверяемый профиль"); val seller = player()
        execute("UPDATE app_users SET tap_watchlisted=true WHERE id=?", blocked.id)
        execute("""INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price,created_at,seller_fee_bps)
            SELECT gen_random_uuid(),?,'berries',2,20,clock_timestamp()-interval '8 hours'+n*interval '1 second',500
            FROM generate_series(1,50) n""", blocked.id)
        val valid = listing(seller); age(valid, hours = 7)
        val repository = JdbcNeighborRepository(source, AdminConfig(emptySet()))
        assertEquals(0, repository.runAutomaticBatch(40))
        assertEquals(1, repository.runAutomaticBatch(40), "A blocked old batch cannot starve a later safe seller indefinitely")
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases WHERE listing_id=?", UUID.fromString(valid.id)))
        assertEquals(50L, scalar("SELECT count(*) FROM economy_market_listings WHERE seller_id=? AND status='active'", blocked.id))
    }

    @Test fun `long first relief delay does not hide ordinary six hour candidates from the scheduler query`() = runBlocking<Unit> {
        val p = player(); val repository = JdbcNeighborRepository(source, AdminConfig(setOf(p.publicId)))
        repository.settings(p.hash, NeighborSettingsCommand(UUID.randomUUID().toString(), 0,
            "Проверка независимых сроков выкупа", NeighborRules.defaults.copy(firstDelaySeconds = 86400)))
        execute("INSERT INTO neighbor_identity(user_id,first_buy_consumed) VALUES (?,true)", p.id)
        val lot = listing(p); age(lot, hours = 7)
        assertEquals(1, repository.runAutomaticBatch(),
            "An already used first-sale allowance must use staleAfterSeconds even when firstDelaySeconds is longer")
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases WHERE listing_id=?", UUID.fromString(lot.id)))
    }

    @Test fun `merging neighbor state adds spent limits consumes first relief and unions purchased items without rerolling offers`() = runBlocking<Unit> {
        val target = player("Основной профиль"); val origin = player("Присоединяемый профиль")
        val targetRequest = UUID.randomUUID(); val originRequest = UUID.randomUUID()
        val retainedOffer = NeighborOffer(UUID.randomUUID().toString(), "berries", 1, 20)
        execute("INSERT INTO neighbor_identity(user_id,first_buy_consumed) VALUES (?,false),(?,true)", target.id, origin.id)
        execute("""INSERT INTO neighbor_daily_usage(user_id,trade_day,used_lots,spent_coins)
            VALUES (?,(clock_timestamp() AT TIME ZONE 'UTC')::date,1,20),(?,(clock_timestamp() AT TIME ZONE 'UTC')::date,1,30)""", target.id, origin.id)
        execute("""INSERT INTO neighbor_global_usage(trade_day,spent_coins)
            VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,50)""")
        execute("""INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers,purchased_items)
            VALUES (?,(clock_timestamp() AT TIME ZONE 'UTC')::date,?::jsonb,'["wood"]'),
                   (?,(clock_timestamp() AT TIME ZONE 'UTC')::date,'[]','["berries","stone"]')""",
            target.id, economyJson.encodeToString(listOf(retainedOffer)), origin.id)
        execute("""INSERT INTO neighbor_receipts(user_id,request_id,signature,message,accepted_revision)
            VALUES (?,?,'neighbor:target-signature','Сохранённая покупка',1),
                   (?,?,'neighbor:origin-signature','Покупка второго профиля',2)""", target.id, targetRequest, origin.id, originRequest)
        source.connection.use { c ->
            c.autoCommit = false
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE", target.id, origin.id) { true }
            mergeNeighborState(c, target.id, origin.id)
            c.commit()
        }
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_identity WHERE user_id=? AND first_buy_consumed", target.id))
        assertEquals(2L, scalar("SELECT used_lots FROM neighbor_daily_usage WHERE user_id=?", target.id))
        assertEquals(50L, scalar("SELECT spent_coins FROM neighbor_daily_usage WHERE user_id=?", target.id))
        assertEquals(50L, scalar("SELECT spent_coins FROM neighbor_global_usage"), "Merging users cannot replenish the global spending fence")
        assertEquals(2L, scalar("SELECT count(*) FROM neighbor_receipts WHERE user_id=?", target.id))
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_receipts WHERE user_id=? AND request_id=? AND signature='neighbor:origin-signature'", target.id, originRequest))
        source.connection.use { c ->
            val saved = c.economyRows("SELECT offers,purchased_items FROM neighbor_shop_cycles WHERE user_id=?", target.id) {
                economyJson.decodeFromString<List<NeighborOffer>>(it.getString(1)) to
                    economyJson.decodeFromString<List<String>>(it.getString(2)).toSet()
            }.single()
            assertEquals(listOf(retainedOffer), saved.first, "The target's frozen daily offer IDs and prices remain stable")
            assertEquals(setOf("wood", "berries", "stone"), saved.second, "Both profiles retain same-day resale protection")
        }
        val visible = JdbcNeighborRepository(source, AdminConfig(emptySet())).neighbor(target.hash)
        assertTrue(visible.shop.offers.single { it.id == retainedOffer.id }.purchased,
            "A source-profile same-day purchase must disable the matching retained target offer after merging")
    }

    @Test fun `real player sale permanently consumes newcomer relief even after sold listing history is cleaned`() = runBlocking<Unit> {
        val seller = player(); val buyer = player("Друг-покупатель")
        val realSale = listing(seller)
        assertTrue(market.market(buyer.hash).listings.any { it.id == realSale.id })
        market.command(buyer.hash, command(buyer, "buy_listing", realSale.id, realSale.quantity, realSale.totalPrice))
        market.command(seller.hash, command(seller, "claim_sale", realSale.id))
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_identity WHERE user_id=? AND first_buy_consumed", seller.id))
        execute("DELETE FROM economy_market_listings WHERE id=?", UUID.fromString(realSale.id))
        val next = listing(seller); age(next, minutes = 4)
        val repository = JdbcNeighborRepository(source, AdminConfig(emptySet()))
        assertEquals(0, repository.runAutomaticBatch(),
            "Deleting historical sold lots cannot restore the short first-sale assistance delay")
        assertEquals(0L, scalar("SELECT count(*) FROM neighbor_purchases WHERE user_id=?", seller.id))
        age(next, hours = 7)
        assertEquals(1, repository.runAutomaticBatch(), "The same account remains eligible for ordinary stale-lot assistance")
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases WHERE user_id=?", seller.id))
    }

    @Test fun `watchlisted accounts personal coin budget and global cap protect both manual and automatic buys`() = runBlocking<Unit> {
        val administrator = player("Администратор"); val first = player(); val second = player(); val blocked = player()
        val repository = JdbcNeighborRepository(source, AdminConfig(setOf(administrator.publicId)))
        repository.settings(administrator.hash, NeighborSettingsCommand(UUID.randomUUID().toString(), 0,
            "Проверка строгих бюджетов выкупа", NeighborRules.defaults.copy(dailyBudgetCoins = 20, maxLotCoins = 20,
                globalDailyBudgetCoins = 40)))
        val unsafe = listing(blocked); age(unsafe, hours = 7)
        execute("UPDATE app_users SET tap_watchlisted=true WHERE id=?", blocked.id)
        assertEquals("NEIGHBOR_LISTING_UNAVAILABLE", assertFailsWith<AuthFailure> {
            repository.buy(administrator.hash, NeighborBuyCommand(UUID.randomUUID().toString(), unsafe.id, blocked.publicId,
                unsafe.totalPrice, "Попытка проверки защищённого профиля"))
        }.code)
        val firstLot = listing(first); age(firstLot, hours = 7)
        val firstExtra = listing(first); age(firstExtra, hours = 7)
        val secondLot = listing(second); age(secondLot, hours = 7)
        assertEquals(2, repository.runAutomaticBatch())
        assertEquals(0L, scalar("SELECT count(*) FROM neighbor_purchases WHERE user_id=?", blocked.id))
        assertEquals(1L, scalar("SELECT count(*) FROM neighbor_purchases WHERE user_id=?", first.id),
            "The 20 coin personal budget permits one 20 coin lot despite the two-lot allowance")
        assertEquals(40L, scalar("SELECT spent_coins FROM neighbor_global_usage"))
        val laterSeller = player(); val later = listing(laterSeller); age(later, hours = 7)
        assertEquals(0, repository.runAutomaticBatch())
        assertEquals("NEIGHBOR_LISTING_UNAVAILABLE", assertFailsWith<AuthFailure> {
            repository.buy(administrator.hash, NeighborBuyCommand(UUID.randomUUID().toString(), later.id, laterSeller.publicId,
                later.totalPrice, "Проверка общего исчерпанного бюджета"))
        }.code)
        assertEquals(2L, scalar("SELECT count(*) FROM neighbor_purchases"))
    }
}
