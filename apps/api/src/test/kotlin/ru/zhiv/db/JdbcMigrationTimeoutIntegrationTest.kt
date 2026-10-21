package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.nio.file.Files
import java.nio.file.Path
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@Testcontainers(disabledWithoutDocker = true)
class JdbcMigrationTimeoutIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")
    @TempDir lateinit var migrations: Path

    private fun config() = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.createStatement().use { statement -> statement.executeQuery(sql).use { row ->
            assertTrue(row.next()); row.getString(1)
        } }
    }

    @Test fun `maintenance migration can exceed API statement limit and its restart is a no-op`() {
        // A real Flyway transaction exercises the pool's actual PostgreSQL limits,
        // rather than only checking a copied configuration string.
        Files.writeString(migrations.resolve("V1__slow_backfill.sql"), """
            CREATE TABLE migration_budget_probe (id integer PRIMARY KEY);
            SELECT pg_sleep(9);
            INSERT INTO migration_budget_probe VALUES (1);
        """.trimIndent())
        DatabaseFactory.createForMigrations(config()).use { source ->
            val flyway = Flyway.configure().dataSource(source).locations("filesystem:$migrations").cleanDisabled(true).load()
            assertEquals(1, flyway.migrate().migrationsExecuted)
            assertEquals("1", scalar(source, "SELECT count(*) FROM migration_budget_probe"))
            assertEquals(0, flyway.migrate().migrationsExecuted)
            assertEquals("300000", scalar(source, "SELECT setting FROM pg_settings WHERE name='statement_timeout'"))
            assertEquals("15000", scalar(source, "SELECT setting FROM pg_settings WHERE name='lock_timeout'"))
            assertEquals("60000", scalar(source, "SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout'"))
            assertEquals("330", source.dataSourceProperties.getProperty("socketTimeout"))
        }
    }

    @Test fun `API timeouts stay short and runtime role cannot request migration pool`() {
        DatabaseFactory.create(config()).use { source ->
            assertEquals("8000", scalar(source, "SELECT setting FROM pg_settings WHERE name='statement_timeout'"))
            assertEquals("3000", scalar(source, "SELECT setting FROM pg_settings WHERE name='lock_timeout'"))
            assertEquals("10000", scalar(source, "SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout'"))
            assertEquals("10", source.dataSourceProperties.getProperty("socketTimeout"))
        }
        assertFailsWith<IllegalArgumentException> {
            DatabaseFactory.createForMigrations(config().copy(databaseUser = "zhiv_app"))
        }
    }
}
