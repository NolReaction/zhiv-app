package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.game.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

/** Upgrade the real previous schema: immutable receipts keep their body and unit. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcCurrencyDenominationIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    @Test fun `V40 converts operational money once and replays old receipts without another credit`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("39").load().migrate()
            val tokens = TokenCodec(); val sellerToken = tokens.issue(); val buyerToken = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val seller = identities.bootstrap("Прежний номинал", tokens.issue().hash, sellerToken.hash, 365)
            val buyer = identities.bootstrap("Покупатель", tokens.issue().hash, buyerToken.hash, 365)
            val job = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 3,
                startedAt = "2026-10-01T00:00:00Z", finishesAt = "2030-10-01T00:00:00Z",
                cost = EconomyCost(150, mapOf("wood" to 20L)), catalogVersion = 2)
            val old = EconomyState(wallet = EconomyWallet(123, 4), inventory = mapOf("wood" to 17L),
                buildings = mapOf("home" to 2, "warehouse" to 1, "garden" to 1), jobs = listOf(job),
                completedExplorations = 1, migration = EconomyMigration(coinsGranted = 7, woodGranted = 0, stoneGranted = 0))
            val ordinary = EconomyCommand(UUID.randomUUID().toString(), seller.publicId, 6, "start_construction", "home")
            val rewardRequest = ProgressionRewardClaim(UUID.randomUUID().toString(), seller.publicId, "achievement", "thousand_taps", 1)
            val originalGift = ProgressionRewardReceipt("achievement", ProgressionReward(pearls = 1),
                "2026-10-01T00:00:00Z", achievementId = "thousand_taps", level = 1)
            val active = UUID.randomUUID(); val closed = UUID.randomUUID()
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,7)", seller.id, economyJson.encodeToString(old))
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state) VALUES (?,?::jsonb)", buyer.id,
                    economyJson.encodeToString(old.copy(wallet = EconomyWallet(100), inventory = emptyMap(), jobs = emptyList())))
                c.economyUpdate("INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,?,'Готово',7)",
                    seller.id, UUID.fromString(ordinary.requestId), economyJson.encodeToString(ordinary))
                c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls) VALUES (?,'historic','sell',-3,1)", seller.id)
                c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'thousand_taps','2026-10-01T00:00:00Z')", seller.id)
                c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'thousand_taps',1,1,'2026-10-01T00:00:00Z')", seller.id)
                c.economyUpdate("""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,claim,accepted_revision,claimed_at)
                    VALUES (?,?,?,?,'achievement',?::jsonb,7,'2026-10-01T00:00:00Z')""", seller.id, seller.id,
                    UUID.fromString(rewardRequest.requestId), progressionRewardsJson.encodeToString(rewardRequest), progressionRewardsJson.encodeToString(originalGift))
                c.economyUpdate("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,'berries',2,6)", active, seller.id)
                c.economyUpdate("""INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price,status,closed_at)
                    VALUES (?,?,'berries',2,6,'cancelled','2026-10-01T00:00:00Z')""", closed, seller.id)
                c.commit()
            }
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            val persisted = source.connection.use { readEconomyProfile(it, seller.id) }
            assertEquals(8L, persisted.revision)
            assertEquals(EconomyMoney.redenominate(old), persisted.state)
            source.connection.use { c ->
                assertEquals(Triple(-3L, 1L, 1), c.economyRows("SELECT coins,pearls,currency_scale FROM economy_ledger WHERE user_id=? AND source_key='historic'", seller.id) {
                    Triple(it.getLong(1), it.getLong(2), it.getInt(3)) }.single())
                assertEquals(economyJson.encodeToString(ordinary), c.economyRows("SELECT signature FROM economy_commands WHERE user_id=? AND request_id=?", seller.id, UUID.fromString(ordinary.requestId)) { it.getString(1) }.single())
                assertEquals(originalGift, c.economyRows("SELECT claim FROM game_reward_claims WHERE user_id=? AND request_id=?", seller.id, UUID.fromString(rewardRequest.requestId)) {
                    progressionRewardsJson.decodeFromString<ProgressionRewardReceipt>(it.getString(1)) }.single())
                assertEquals(60L to 10, c.economyRows("SELECT total_price,currency_scale FROM economy_market_listings WHERE id=?", active) { it.getLong(1) to it.getInt(2) }.single())
                assertEquals(6L to 1, c.economyRows("SELECT total_price,currency_scale FROM economy_market_listings WHERE id=?", closed) { it.getLong(1) to it.getInt(2) }.single())
            }
            val economy = JdbcEconomyRepository(source)
            val replay = economy.command(sellerToken.hash, ordinary)
            assertTrue(replay.replayed); assertEquals(7L, replay.acceptedRevision)
            assertEquals(EconomyWallet(1230, 40), replay.state.wallet)
            assertEquals(listOf(job.copy(cost = job.cost.copy(coins = 1500))), replay.state.jobs)
            assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
                economy.command(sellerToken.hash, ordinary.copy(requestId = UUID.randomUUID().toString())) }.code)
            val paid = JdbcProgressionRewardsRepository(source).claim(sellerToken.hash, rewardRequest)
            assertTrue(paid.replayed); assertEquals(7L, paid.acceptedRevision)
            assertEquals(originalGift.copy(reward = ProgressionReward(pearls = 10)), paid.claim)
            assertEquals(EconomyWallet(1230, 40), paid.economy.wallet)
            val market = JdbcEconomyMarketRepository(source)
            val visible = market.market(buyerToken.hash).listings.single()
            assertEquals(60L, visible.totalPrice)
            val bought = market.command(buyerToken.hash, EconomyCommand(UUID.randomUUID().toString(), buyer.publicId,
                economy.snapshot(buyerToken.hash).revision, "buy_listing", visible.id, 2, visible.totalPrice))
            assertEquals(940L, bought.state.wallet.coins)
            assertEquals(2L, bought.state.inventory["berries"])
            assertEquals(1290L, economy.snapshot(sellerToken.hash).wallet.coins)
        }
    }
}
