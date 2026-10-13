package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.*
import ru.zhiv.config.AppConfig
import ru.zhiv.promo.PromoCatalog
import ru.zhiv.promo.PromoDefinition
import ru.zhiv.promo.PromoRequest
import ru.zhiv.promo.PromoReward
import ru.zhiv.security.TokenCodec
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

/** Recreate the actual deployed branch, including Flyway's original checksums.
 * No repair or checksum replacement is used by the upgrade under test. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcAdminMigrationCompatibilityIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    @TempDir lateinit var legacyDirectory: Path
    private fun config() = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.economyRows(sql) { it.getString(1) }.single()
    }
    private fun execute(source: DataSource, sql: String) = source.connection.use { c ->
        c.economyUpdate(sql); c.commit()
    }
    private fun history(source: DataSource, extraWhere: String = "true"): String = scalar(source,
        "SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY installed_rank),'[]'::jsonb)::text FROM flyway_schema_history h WHERE $extraWhere")
    private fun installedAdminHistory(source: DataSource): String = scalar(source, """SELECT coalesce(
        jsonb_agg(to_jsonb(h)-'version'-'script' ORDER BY installed_rank),'[]'::jsonb)::text
        FROM flyway_schema_history h WHERE script LIKE '%admin_economy_grants.sql' OR script LIKE '%managed_promo_codes.sql'""")
    private fun population(source: DataSource): Map<String, String> = listOf(
        "app_users", "app_sessions", "economy_profiles", "economy_ledger", "admin_actions", "managed_promo_codes", "promo_redemptions",
    ).associateWith { table -> scalar(source,
        "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM $table t") }
    private fun legacy(source: DataSource, target: Int = 51) {
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("49").load().migrate()
        val scripts = source.connection.use { c ->
            c.economyRows("SELECT script FROM flyway_schema_history ORDER BY installed_rank") { it.getString(1) }
        }
        scripts.forEach { script ->
            checkNotNull(javaClass.getResourceAsStream("/db/migration/$script")).use {
                Files.copy(it, legacyDirectory.resolve(script))
            }
        }
        mapOf("V51__admin_economy_grants.sql" to "V50__admin_economy_grants.sql",
            "V52__managed_promo_codes.sql" to "V51__managed_promo_codes.sql").forEach { (canonical, original) ->
            checkNotNull(javaClass.getResourceAsStream("/db/migration/$canonical")).use {
                Files.copy(it, legacyDirectory.resolve(original))
            }
        }
        Flyway.configure().dataSource(source).locations("filesystem:$legacyDirectory")
            .target(target.toString()).cleanDisabled(true).load().migrate()
    }
    private suspend fun seed(source: DataSource) {
        val codec = TokenCodec(); val adminToken = codec.issue(); val playerToken = codec.issue()
        val users = JdbcZhivRepository(source)
        val admin = users.bootstrap("Сохранённый администратор", codec.issue().hash, adminToken.hash, 365)
        val player = users.bootstrap("Сохранённый игрок", codec.issue().hash, playerToken.hash, 365)
        val repository = JdbcAdminRepository(source, AdminConfig(setOf(admin.publicId)))
        val grant = AdminEconomyGrantRequest(UUID.randomUUID().toString(), player.publicId, "Выдача до объединения", coins = 15, pearls = 3)
        repository.grantEconomy(adminToken.hash, player.publicId, UUID.fromString(grant.requestId), grant)
        val gift = PromoDefinition("compat-gift", "COMPAT-GIFT", true, "Сохранённая акция", reward = PromoReward(30, 2))
        JdbcAdminPromoRepository(source, AdminConfig(setOf(admin.publicId)), PromoCatalog(1, emptyList())).manage(adminToken.hash,
            AdminPromoCommand(UUID.randomUUID().toString(), "create", gift.id, 0, "Акция до объединения", gift))
        val beforeClaim = JdbcEconomyRepository(source).snapshot(playerToken.hash)
        JdbcPromoRepository(source, PromoCatalog(1, emptyList())).redeem(playerToken.hash,
            PromoRequest(UUID.randomUUID().toString(), player.publicId, beforeClaim.revision, gift.code))
    }

    @Test fun `deployed admin V50 and V51 normalize metadata and apply notification V50 without changing player data`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            legacy(source); seed(source)
            assertEquals("1968638817", scalar(source, "SELECT checksum::text FROM flyway_schema_history WHERE version='50'"))
            assertEquals("1403371834", scalar(source, "SELECT checksum::text FROM flyway_schema_history WHERE version='51'"))
            val before = population(source); val base = history(source, "version::integer<=49")
            val adminHistory = installedAdminHistory(source)
            migrateWithLegacyAdminHistory(source)
            assertEquals(before, population(source)); assertEquals(base, history(source, "version::integer<=49"))
            assertEquals(adminHistory, installedAdminHistory(source), "Only version and script may change in historical admin rows")
            assertEquals("52", scalar(source, "SELECT max(version::integer)::text FROM flyway_schema_history"))
            assertEquals("V50__actionable_notification_sources.sql", scalar(source,
                "SELECT script FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("3", scalar(source, "SELECT count(*) FROM flyway_schema_history WHERE version IN ('50','51','52') AND success"))
            val after = history(source)
            DatabaseFactory.migrate(source)
            migrateWithLegacyAdminHistory(source)
            assertEquals(after, history(source)); assertEquals(before, population(source))
        }
    }

    @Test fun `interrupted upgrade resumes from committed V51 V52 normalization exactly once`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            legacy(source); seed(source)
            val before = population(source)
            assertTrue(normalizeLegacyAdminMigrationHistory(source))
            assertEquals("0", scalar(source, "SELECT count(*) FROM flyway_schema_history WHERE version='50'"))
            val normalized = history(source)
            assertTrue(normalizeLegacyAdminMigrationHistory(source))
            assertEquals(normalized, history(source), "A resumed normalization never rewrites already normalized rows")
            migrateWithLegacyAdminHistory(source)
            assertEquals(before, population(source))
            assertFalse(normalizeLegacyAdminMigrationHistory(source))
            assertEquals("1", scalar(source, "SELECT count(*) FROM flyway_schema_history WHERE version='50'"))
        }
    }

    @Test fun `partial old admin V50 upgrade resumes and adds both canonical V50 and V52`() {
        DatabaseFactory.create(config()).use { source ->
            legacy(source, 50)
            val adminHistory = installedAdminHistory(source)
            migrateWithLegacyAdminHistory(source)
            assertEquals(adminHistory, scalar(source, """SELECT
                jsonb_agg(to_jsonb(h)-'version'-'script' ORDER BY installed_rank)::text FROM flyway_schema_history h
                WHERE script='V51__admin_economy_grants.sql'"""))
            assertEquals("3", scalar(source, "SELECT count(*) FROM flyway_schema_history WHERE version IN ('50','51','52') AND success"))
        }
    }

    @Test fun `unknown checksum script type failure future or changed original history is rejected without any normalization`() {
        DatabaseFactory.create(config()).use { source ->
            legacy(source)
            val changes = listOf(
                "UPDATE flyway_schema_history SET checksum=checksum+1 WHERE version='50'" to "UPDATE flyway_schema_history SET checksum=1968638817 WHERE version='50'",
                "UPDATE flyway_schema_history SET script='V50__unknown.sql' WHERE version='50'" to "UPDATE flyway_schema_history SET script='V50__admin_economy_grants.sql' WHERE version='50'",
                "UPDATE flyway_schema_history SET type='JDBC' WHERE version='50'" to "UPDATE flyway_schema_history SET type='SQL' WHERE version='50'",
                "UPDATE flyway_schema_history SET success=false WHERE version='51'" to "UPDATE flyway_schema_history SET success=true WHERE version='51'",
                "UPDATE flyway_schema_history SET version='99' WHERE version='51'" to "UPDATE flyway_schema_history SET version='51' WHERE version='99'",
                "UPDATE flyway_schema_history SET checksum=checksum+1 WHERE version='49'" to "UPDATE flyway_schema_history SET checksum=checksum-1 WHERE version='49'",
            )
            changes.forEach { (change, restore) ->
                execute(source, change)
                val before = history(source)
                assertFailsWith<IllegalStateException> { normalizeLegacyAdminMigrationHistory(source) }
                assertEquals(before, history(source), "Rejected history must remain untouched")
                execute(source, restore)
            }
            assertTrue(normalizeLegacyAdminMigrationHistory(source))
        }
    }

    @Test fun `canonical notification V50 history is a no-op and migrates normally to V52`() {
        DatabaseFactory.create(config()).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("50").load().migrate()
            val before = history(source)
            assertFalse(normalizeLegacyAdminMigrationHistory(source)); assertEquals(before, history(source))
            migrateWithLegacyAdminHistory(source)
            assertEquals("52", scalar(source, "SELECT max(version::integer)::text FROM flyway_schema_history"))
            val after = history(source)
            assertFalse(normalizeLegacyAdminMigrationHistory(source)); assertEquals(after, history(source))
        }
    }

    @Test fun `ordinary migration never normalizes legacy history and runtime role is refused`() {
        DatabaseFactory.create(config()).use { source ->
            legacy(source)
            val before = history(source)
            assertFails { DatabaseFactory.migrate(source) }
            assertEquals(before, history(source))
            execute(source, "CREATE ROLE zhiv_app")
            // Use a separate data source role, so no pooled migration connection
            // can regain privileges while the explicit role guard is checked.
            val rolePassword = UUID.randomUUID().toString()
            execute(source, "ALTER ROLE zhiv_app LOGIN PASSWORD '$rolePassword'")
            val appConfig = config().copy(databaseUser = "zhiv_app", databasePassword = rolePassword)
            DatabaseFactory.create(appConfig).use { app ->
                assertFailsWith<IllegalStateException> { normalizeLegacyAdminMigrationHistory(app) }
            }
            assertEquals(before, history(source))
        }
    }
}
