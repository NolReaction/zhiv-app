package ru.zhiv.db

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.promo.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcPromoRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")
    private val gift = PromoDefinition("qa-gift-v1", "QA-GIFT", true, "Подарок", reward = PromoReward(500, 20, mapOf("wood" to 5)))
    private val catalog = PromoCatalog(1, listOf(gift, gift.copy(id = "qa-second-v1", code = "QA-SECOND")))
    private fun config() = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))

    @Test fun `migration preserves existing account and concurrent retries credit once even after code removal`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("47").load().migrate()
            val codec = TokenCodec(); val token = codec.issue()
            val player = JdbcZhivRepository(source).bootstrap("Подарок", codec.issue().hash, token.hash, 365)
            val economy = JdbcEconomyRepository(source); val before = economy.snapshot(token.hash)
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            assertEquals(before.wallet, economy.snapshot(token.hash).wallet)
            val request = PromoRequest(UUID.randomUUID().toString(), player.publicId, before.revision, " qa-gift ")
            val results = coroutineScope { List(3) { async(Dispatchers.IO) { JdbcPromoRepository(source, catalog).redeem(token.hash, request) } }.awaitAll() }
            assertEquals(1, results.count { !it.replayed })
            val after = economy.snapshot(token.hash)
            assertEquals(before.revision + 1, after.revision); assertEquals(before.wallet.coins + 500, after.wallet.coins)
            assertEquals(before.wallet.pearls + 40, after.wallet.pearls); assertEquals(before.inventory.getValue("wood") + 5, after.inventory.getValue("wood"))
            val replay = JdbcPromoRepository(source, PromoCatalog(1, emptyList())).redeem(token.hash, request)
            assertTrue(replay.replayed); assertEquals(results.first().reward, replay.reward)
            assertEquals("PROMO_ALREADY_USED", assertFailsWith<AuthFailure> { JdbcPromoRepository(source, catalog).redeem(token.hash, request.copy(requestId = UUID.randomUUID().toString(), expectedRevision = after.revision)) }.code)
            source.connection.use { c ->
                assertEquals(1L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='promo_code'", player.id) { it.getLong(1) }.single())
                c.economyUpdate("DELETE FROM economy_profiles WHERE user_id=?", player.id); c.commit()
            }
            val reset = economy.snapshot(token.hash)
            assertEquals("PROMO_ALREADY_USED", assertFailsWith<AuthFailure> { JdbcPromoRepository(source, catalog).redeem(token.hash, request.copy(requestId = UUID.randomUUID().toString(), expectedRevision = reset.revision)) }.code)
        }
    }
    @Test fun `full warehouse rolls back gift fence wallet revision and receipt`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val codec = TokenCodec(); val token = codec.issue()
            val player = JdbcZhivRepository(source).bootstrap("Кладовая", codec.issue().hash, token.hash, 365)
            val economy = JdbcEconomyRepository(source); economy.snapshot(token.hash)
            source.connection.use { c ->
                val state = readEconomyProfile(c, player.id).state.copy(inventory = mapOf("wood" to 200))
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), player.id); c.commit()
            }
            val before = economy.snapshot(token.hash); val request = PromoRequest(UUID.randomUUID().toString(), player.publicId, before.revision, "QA-GIFT")
            val promo = JdbcPromoRepository(source, catalog)
            assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { promo.redeem(token.hash, request) }.code)
            val failed = economy.snapshot(token.hash); assertEquals(before.revision, failed.revision); assertEquals(before.wallet, failed.wallet)
            source.connection.use { c ->
                assertEquals(0L, c.economyRows("SELECT count(*) FROM promo_redemptions WHERE user_id=?", player.id) { it.getLong(1) }.single())
                val state = readEconomyProfile(c, player.id).state.copy(inventory = emptyMap())
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), player.id); c.commit()
            }
            assertFalse(promo.redeem(token.hash, request).replayed)
        }
    }
    @Test fun `merging two different campaigns with the same request UUID preserves both fences without another reward`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val codec = TokenCodec(); val a = codec.issue(); val b = codec.issue()
            val users = JdbcZhivRepository(source)
            val target = users.bootstrap("Цель", codec.issue().hash, a.hash, 365); val origin = users.bootstrap("Источник", codec.issue().hash, b.hash, 365)
            val economy = JdbcEconomyRepository(source); val promo = JdbcPromoRepository(source, catalog); val sharedId = UUID.randomUUID().toString()
            promo.redeem(a.hash, PromoRequest(sharedId, target.publicId, economy.snapshot(a.hash).revision, "QA-GIFT"))
            promo.redeem(b.hash, PromoRequest(sharedId, origin.publicId, economy.snapshot(b.hash).revision, "QA-SECOND"))
            source.connection.use { c ->
                c.autoCommit = false
                c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE", target.id, origin.id) { true }
                mergePromoRedemptions(c, target.id, origin.id); mergeEconomyProfiles(c, target.id, origin.id); c.commit()
                assertEquals(2L, c.economyRows("SELECT count(*) FROM promo_redemptions WHERE user_id=?", target.id) { it.getLong(1) }.single())
            }
            val before = economy.snapshot(a.hash)
            for (code in listOf("QA-GIFT", "QA-SECOND")) assertEquals("PROMO_ALREADY_USED", assertFailsWith<AuthFailure> {
                promo.redeem(a.hash, PromoRequest(UUID.randomUUID().toString(), target.publicId, before.revision, code)) }.code)
            assertEquals(before.wallet, economy.snapshot(a.hash).wallet)
        }
    }
}
