package ru.zhiv.db

import kotlinx.coroutines.*
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.promo.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcAdminPromoRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")
    private fun config() = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
    private val gift = PromoDefinition("managed-qa-gift", "MANAGED-QA", true, "Подарок", reward = PromoReward(500, 20))
    private fun command(definition: PromoDefinition = gift, action: String = "create", version: Long = 0) =
        AdminPromoCommand(UUID.randomUUID().toString(), action, definition.id, version, "Проверка промокода", definition.takeUnless { action == "delete" })

    @Test fun `filled database upgrade and live create edit delete preserve claims and replay receipts`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("49").load().migrate()
            val codec = TokenCodec(); val adminToken = codec.issue(); val userToken = codec.issue()
            val users = JdbcZhivRepository(source)
            val admin = users.bootstrap("Админ", codec.issue().hash, adminToken.hash, 365)
            val user = users.bootstrap("Игрок", codec.issue().hash, userToken.hash, 365)
            val economy = JdbcEconomyRepository(source); val before = economy.snapshot(userToken.hash)
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            assertEquals(before.wallet, economy.snapshot(userToken.hash).wallet)
            val manager = JdbcAdminPromoRepository(source, AdminConfig(setOf(admin.publicId)), PromoCatalog(1, emptyList()))
            val redeemer = JdbcPromoRepository(source, PromoCatalog(1, emptyList())) // same running instance sees changes
            assertEquals("ADMIN_FORBIDDEN", assertFailsWith<AuthFailure> { manager.list(userToken.hash) }.code)
            assertEquals("ADMIN_FORBIDDEN", assertFailsWith<AuthFailure> { manager.manage(userToken.hash, command()) }.code)
            val create = command()
            val receipts = coroutineScope { List(3) { async(Dispatchers.IO) { manager.manage(adminToken.hash, create) } }.awaitAll() }
            assertEquals(1, receipts.count { !it.replayed }); assertEquals(1L, receipts.first().version)
            assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
                manager.manage(adminToken.hash, create.copy(definition = gift.copy(title = "Другое название")))
            }.code)
            val redemption = PromoRequest(UUID.randomUUID().toString(), user.publicId, economy.snapshot(userToken.hash).revision, gift.code)
            val result = redeemer.redeem(userToken.hash, redemption)
            assertEquals(before.wallet.coins + 500, result.state.wallet.coins)
            assertEquals(before.wallet.pearls + 40, result.state.wallet.pearls)
            assertEquals(1L, manager.list(adminToken.hash).codes.single().redemptions)
            val disable = command(gift.copy(enabled = false), "update", 1)
            manager.manage(adminToken.hash, disable)
            assertEquals("ADMIN_PROMO_VERSION_CONFLICT", assertFailsWith<AuthFailure> {
                manager.manage(adminToken.hash, command(gift.copy(title = "Устаревшее изменение"), "update", 1))
            }.code)
            assertEquals("PROMO_NOT_FOUND", assertFailsWith<AuthFailure> {
                redeemer.redeem(adminToken.hash, PromoRequest(UUID.randomUUID().toString(), admin.publicId, economy.snapshot(adminToken.hash).revision, gift.code))
            }.code)
            val deletion = command(action = "delete", version = 2)
            assertEquals(3L, manager.manage(adminToken.hash, deletion).version)
            assertTrue(manager.list(adminToken.hash).codes.isEmpty())
            assertTrue(manager.manage(adminToken.hash, deletion).replayed)
            assertTrue(manager.manage(adminToken.hash, create).replayed)
            assertTrue(redeemer.redeem(userToken.hash, redemption).replayed)
            assertEquals("ADMIN_PROMO_EXISTS", assertFailsWith<AuthFailure> { manager.manage(adminToken.hash, command()) }.code)
            assertEquals("ADMIN_PROMO_CODE_EXISTS", assertFailsWith<AuthFailure> {
                manager.manage(adminToken.hash, command(gift.copy(id = "different-campaign")))
            }.code)
            source.connection.use { c ->
                assertEquals(3L, c.economyRows("SELECT count(*) FROM admin_actions WHERE actor_user_id=?", admin.id) { it.getLong(1) }.single())
                assertEquals(1L, c.economyRows("SELECT count(*) FROM promo_redemptions WHERE user_id=?", user.id) { it.getLong(1) }.single())
                assertEquals(1L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='promo_code'", user.id) { it.getLong(1) }.single())
            }
        }
    }

    @Test fun `legacy edits shadow JSON permanently and deadlines use server time`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val codec = TokenCodec(); val token = codec.issue()
            val user = JdbcZhivRepository(source).bootstrap("Админ", codec.issue().hash, token.hash, 365)
            val legacy = gift.copy(id = "legacy-qa", code = "LEGACY-QA")
            val catalog = PromoCatalog(1, listOf(legacy))
            val manager = JdbcAdminPromoRepository(source, AdminConfig(setOf(user.publicId)), catalog)
            val redeemer = JdbcPromoRepository(source, catalog); val economy = JdbcEconomyRepository(source)
            assertEquals(0L, manager.list(token.hash).codes.single { it.definition.id == legacy.id }.version)
            manager.manage(token.hash, command(legacy.copy(endsAt = "2000-01-01T00:00:00Z"), "update"))
            val request = PromoRequest(UUID.randomUUID().toString(), user.publicId, economy.snapshot(token.hash).revision, legacy.code)
            assertEquals("PROMO_EXPIRED", assertFailsWith<AuthFailure> { redeemer.redeem(token.hash, request) }.code)
            manager.manage(token.hash, command(legacy.copy(startsAt = "2999-01-01T00:00:00Z"), "update", 1))
            assertEquals("PROMO_NOT_STARTED", assertFailsWith<AuthFailure> { redeemer.redeem(token.hash, request) }.code)
            manager.manage(token.hash, command(legacy.copy(code = "LEGACY-RENAMED"), "update", 2))
            assertEquals("PROMO_NOT_FOUND", assertFailsWith<AuthFailure> { redeemer.redeem(token.hash, request) }.code)
            assertFalse(redeemer.redeem(token.hash, request.copy(code = "LEGACY-RENAMED")).replayed)
            manager.manage(token.hash, command(legacy.copy(code = "LEGACY-RENAMED"), "delete", 3))
            assertEquals("PROMO_NOT_FOUND", assertFailsWith<AuthFailure> {
                redeemer.redeem(token.hash, request.copy(requestId = UUID.randomUUID().toString()))
            }.code)
            assertFalse(manager.list(token.hash).codes.any { it.definition.id == legacy.id })
        }
    }

    @Test fun `optimistic concurrent edits accept exactly one revision and revoked admin cannot replay`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val codec = TokenCodec(); val token = codec.issue()
            val user = JdbcZhivRepository(source).bootstrap("Админ", codec.issue().hash, token.hash, 365)
            val manager = JdbcAdminPromoRepository(source, AdminConfig(setOf(user.publicId)), PromoCatalog(1, emptyList()))
            val unique = gift.copy(id = "concurrent-qa", code = "CONCURRENT-QA")
            val create = command(unique); manager.manage(token.hash, create)
            val results = coroutineScope { List(2) { index -> async(Dispatchers.IO) {
                runCatching { manager.manage(token.hash, command(unique.copy(title = "Название $index"), "update", 1)) }
            } }.awaitAll() }
            assertEquals(1, results.count { it.isSuccess })
            assertEquals("ADMIN_PROMO_VERSION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
            source.connection.use { c -> c.economyUpdate("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", token.hash); c.commit() }
            assertEquals("UNAUTHORIZED", assertFailsWith<AuthFailure> { manager.manage(token.hash, create) }.code)
        }
    }
}
