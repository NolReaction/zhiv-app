package ru.zhiv.db

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.NeighborRules
import ru.zhiv.economy.NeighborSettings
import ru.zhiv.economy.economyJson
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcNeighborMarketSupportMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String) = source.connection.use { c -> c.economyRows(sql) { it.getString(1) }.single() }
    private fun legacy(test: (DataSource) -> Unit) = DatabaseFactory.create(
        AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")),
    ).use { source ->
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("75").load().migrate()
        test(source)
    }
    private fun previous() = NeighborRules.defaults.copy(sellPriceBps=12500,buyPriceBps=10000,
        dailyBudgetCoins=300,maxLotCoins=150,globalDailyBudgetCoins=10000)

    @Test fun `V76 upgrades the complete standard envelope and preserves issued stock and accumulated usage`() = legacy { source ->
        val before=previous().copy(name="Saved name",allowedItemIds=listOf("wood"))
        execute(source,"INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,12,?::jsonb)",economyJson.encodeToString(before))
        val user=UUID.randomUUID()
        execute(source,"INSERT INTO app_users(id,public_id,display_name) VALUES(?,'0000-0000-0001','Saved')",user)
        execute(source,"""INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers,purchased_items)
            VALUES(?,'2026-10-26','[{"itemId":"wood","quantity":1,"totalPrice":40,"purchased":true}]','["wood"]')""",user)
        execute(source,"INSERT INTO neighbor_daily_usage(user_id,trade_day,used_lots,spent_coins) VALUES(?,'2026-10-26',1,30)",user)
        val stock=scalar(source,"SELECT to_jsonb(c)::text FROM neighbor_shop_cycles c")
        val usage=scalar(source,"SELECT to_jsonb(c)::text FROM neighbor_daily_usage c")
        DatabaseFactory.migrate(source)
        val expected=NeighborRules.defaults.copy(name=before.name,allowedItemIds=before.allowedItemIds)
        assertEquals(expected,economyJson.decodeFromString<NeighborSettings>(scalar(source,"SELECT settings::text FROM neighbor_settings")))
        assertEquals("13",scalar(source,"SELECT version::text FROM neighbor_settings"))
        assertEquals(stock,scalar(source,"SELECT to_jsonb(c)::text FROM neighbor_shop_cycles c"))
        assertEquals(usage,scalar(source,"SELECT to_jsonb(c)::text FROM neighbor_daily_usage c"))
        val after=scalar(source,"SELECT to_jsonb(s)::text FROM neighbor_settings s")
        DatabaseFactory.migrate(source)
        assertEquals(after,scalar(source,"SELECT to_jsonb(s)::text FROM neighbor_settings s"))
    }

    @Test fun `V76 leaves partially tuned prices or budgets unchanged instead of producing a mixed envelope`() = legacy { source ->
        val before=previous().copy(dailyBudgetCoins=700)
        execute(source,"INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,12,?::jsonb)",economyJson.encodeToString(before))
        val saved=scalar(source,"SELECT to_jsonb(s)::text FROM neighbor_settings s")
        DatabaseFactory.migrate(source)
        assertEquals(saved,scalar(source,"SELECT to_jsonb(s)::text FROM neighbor_settings s"))
    }
}
