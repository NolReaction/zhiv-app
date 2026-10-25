package ru.zhiv.db

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.EconomyRules
import ru.zhiv.economy.NeighborRules
import ru.zhiv.economy.economyJson
import java.sql.SQLException
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcNeighborConfigurationMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private val oldBuildings = mapOf("home" to 3, "workshop" to 2, "quarry" to 2, "warehouse" to 2,
        "garden" to 2, "kiln" to 1, "dryer" to 1, "woodlot" to 2, "bridge" to 1, "lighthouse" to 0)
    private val oldStock = listOf("wood", "stone", "fiber", "berries", "planks", "rope", "clay", "sand", "ore")
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.economyRows(sql) { it.getString(1) }.single()
    }
    private fun legacy(test: (DataSource) -> Unit) {
        DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("71").load().migrate()
            test(source)
        }
    }
    @Test fun `untouched world and stock defaults upgrade independently while custom settings and issued stock survive`() = legacy { source ->
        val settings = NeighborRules.defaults.copy(name = "Сосед с ручными ценами", buildings = oldBuildings,
            allowedItemIds = oldStock.reversed(), dailyBudgetCoins = 250, maxLotCoins = 100)
        execute(source, "INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,7,?::jsonb)", economyJson.encodeToString(settings))
        val user = UUID.randomUUID()
        execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES(?,'0000-0000-0001','Keeper')", user)
        val offer = """[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","itemId":"wood","quantity":1,"totalPrice":40,"purchased":true}]"""
        execute(source, "INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers,purchased_items) VALUES(?,'2026-10-25',?::jsonb,'[\"wood\"]')", user, offer)
        execute(source, "INSERT INTO neighbor_daily_usage(user_id,trade_day,used_lots,spent_coins) VALUES(?,'2026-10-25',1,20)", user)
        execute(source, "INSERT INTO neighbor_global_usage(trade_day,spent_coins) VALUES('2026-10-25',20)")
        execute(source, "INSERT INTO neighbor_receipts(user_id,request_id,signature,message,accepted_revision) VALUES(?,?,'paid-signature','paid',9)", user, UUID.randomUUID())
        val history = scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
        val issued = scalar(source, "SELECT to_jsonb(c)::text FROM neighbor_shop_cycles c")
        val receipt = scalar(source, "SELECT to_jsonb(r)::text FROM neighbor_receipts r")
        DatabaseFactory.migrate(source)
        val actual = economyJson.decodeFromString<ru.zhiv.economy.NeighborSettings>(scalar(source, "SELECT settings::text FROM neighbor_settings"))
        assertEquals(settings.copy(buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.maxOf { level -> level.level } },
            allowedItemIds = NeighborRules.defaults.allowedItemIds), actual)
        assertEquals("8", scalar(source, "SELECT version::text FROM neighbor_settings"))
        assertEquals(history, scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=71"))
        assertEquals(issued, scalar(source, "SELECT to_jsonb(c)::text FROM neighbor_shop_cycles c"))
        assertEquals(receipt, scalar(source, "SELECT to_jsonb(r)::text FROM neighbor_receipts r"))
        assertEquals("20", scalar(source, "SELECT spent_coins::text FROM neighbor_daily_usage"))
        assertEquals("20", scalar(source, "SELECT spent_coins::text FROM neighbor_global_usage"))
        val upgraded = scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s")
        DatabaseFactory.migrate(source)
        assertEquals(upgraded, scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s"), "Restart never rewrites configured defaults twice")
        val offers = "[" + List(4) { "{\"itemId\":\"wood\"}" }.joinToString(",") + "]"
        execute(source, "INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers) VALUES(?,'2026-10-26',?::jsonb)", user, offers)
        execute(source, "INSERT INTO neighbor_purchases(id,listing_id,user_id,item_id,quantity,total_price,proceeds_coins,source) VALUES(?,?,?,'wood',99,3000,2850,'manual')", UUID.randomUUID(), UUID.randomUUID(), user)
        execute(source, "UPDATE neighbor_daily_usage SET used_lots=10000000001,spent_coins=10000000001")
        execute(source, "UPDATE neighbor_global_usage SET spent_coins=10000000001")
        assertEquals("23514", assertFailsWith<SQLException> { execute(source, "UPDATE neighbor_global_usage SET spent_coins=9007199254740992") }.sqlState)
        assertEquals("23514", assertFailsWith<SQLException> { execute(source, "UPDATE neighbor_purchases SET total_price=10000000001") }.sqlState)
        assertEquals("0", scalar(source, "SELECT count(*)::text FROM pg_indexes WHERE indexname='neighbor_market_candidates' AND indexdef LIKE '%150%'"))
    }
    @Test fun `custom world and custom stock remain byte identical and keep their version`() = legacy { source ->
        val settings = NeighborRules.defaults.copy(buildings = oldBuildings + ("home" to 4), allowedItemIds = listOf("wood", "stone"))
        execute(source, "INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,12,?::jsonb)", economyJson.encodeToString(settings))
        val before = scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s")
        DatabaseFactory.migrate(source)
        assertEquals(before, scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s"))
    }
    private fun independentDefaults(customWorld: Boolean) = legacy { source ->
        val maximum = EconomyRules.catalog.buildings.associate { it.id to it.levels.maxOf { level -> level.level } }
        val settings = NeighborRules.defaults.copy(buildings = if (customWorld) oldBuildings + ("home" to 4) else oldBuildings,
            allowedItemIds = if (customWorld) oldStock else listOf("wood", "stone"))
        execute(source, "INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,7,?::jsonb)", economyJson.encodeToString(settings))
        DatabaseFactory.migrate(source)
        val actual = economyJson.decodeFromString<ru.zhiv.economy.NeighborSettings>(scalar(source, "SELECT settings::text FROM neighbor_settings"))
        assertEquals(settings.copy(buildings = if (customWorld) settings.buildings else maximum,
            allowedItemIds = if (customWorld) NeighborRules.defaults.allowedItemIds else settings.allowedItemIds), actual)
        assertEquals("8", scalar(source, "SELECT version::text FROM neighbor_settings"))
    }
    @Test fun `custom world survives while old default stock receives the full progression pool`() = independentDefaults(customWorld = true)
    @Test fun `custom stock survives while old default world receives maximum levels`() = independentDefaults(customWorld = false)

}
