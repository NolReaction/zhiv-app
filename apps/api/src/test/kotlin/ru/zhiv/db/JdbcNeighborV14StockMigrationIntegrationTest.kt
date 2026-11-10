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
class JdbcNeighborV14StockMigrationIntegrationTest {
    private val v75Stock = listOf("berries","wood","stone","ore","fiber","planks","rope","metal_parts","dried_berries","smoked_fish","clay","sand","charcoal","iron_ingot","bricks","glass","hardwood","resin","cloth","beams","tools","reinforced_parts","cut_stone","crumb_bait","worm_bait","glow_bait","firefly_bait","star_bait","grilled_fish","fish_soup","berry_fish","hearty_fish","epic_fish","legendary_fish","strawberries","berry_compote","trail_ration","research_gear","blueberries","currants","blackberries","cranberries","strawberry_compote","blueberry_compote","currant_jelly","blackberry_preserve","cranberry_glaze","spice_bait","dusk_bait","quartz","limestone","ceramic_jar","mortar","glass_bottle","lens","packed_berries","trade_crate","field_kit","stone_tile","bottled_compote","berry_gift","grilled_silverfin","smoked_bream","mooncarp_blueberries","pike_berry_sauce","eel_in_jar","festive_sturgeon")
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private val oldStock = listOf("berries", "wood", "stone", "ore", "fiber", "planks", "rope", "metal_parts",
        "dried_berries", "smoked_fish", "clay", "sand", "charcoal", "iron_ingot", "bricks", "glass", "hardwood",
        "resin", "cloth", "beams", "tools", "reinforced_parts", "cut_stone", "crumb_bait", "worm_bait", "glow_bait",
        "firefly_bait", "star_bait", "grilled_fish", "berry_fish", "hearty_fish", "epic_fish", "legendary_fish",
        "strawberries", "berry_compote", "trail_ration", "research_gear", "blueberries", "currants", "blackberries",
        "cranberries", "strawberry_compote", "blueberry_compote", "currant_jelly", "blackberry_preserve", "cranberry_glaze", "spice_bait", "dusk_bait")
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String) = source.connection.use { c -> c.economyRows(sql) { it.getString(1) }.single() }
    private fun legacy(test: (DataSource) -> Unit) = DatabaseFactory.create(
        AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")),
    ).use { source ->
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("74").load().migrate()
        test(source)
    }

    @Test fun `V75 expands exactly the previous standard pool while retaining other tuning and purchased cycles`() = legacy { source ->
        val settings = NeighborRules.defaults.copy(name = "Custom name", dailyBudgetCoins = 54321, allowedItemIds = oldStock.reversed())
        execute(source, "INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,12,?::jsonb)", economyJson.encodeToString(settings))
        val user = UUID.randomUUID()
        execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES(?,'0000-0000-0001','Saved')", user)
        execute(source, """INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers,purchased_items)
            VALUES(?,'2026-10-26','[{"itemId":"wood","quantity":1,"totalPrice":40,"purchased":true}]','["wood"]')""", user)
        val cycles = scalar(source, "SELECT to_jsonb(c)::text FROM neighbor_shop_cycles c")
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("75").load().migrate()
        assertEquals(settings.copy(allowedItemIds = v75Stock),
            economyJson.decodeFromString<NeighborSettings>(scalar(source, "SELECT settings::text FROM neighbor_settings")))
        assertEquals("13", scalar(source, "SELECT version::text FROM neighbor_settings"))
        assertEquals(cycles, scalar(source, "SELECT to_jsonb(c)::text FROM neighbor_shop_cycles c"))
        val after = scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s")
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("75").load().migrate()
        assertEquals(after, scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s"))
    }

    @Test fun `V75 leaves administrator restricted pools byte identical`() = legacy { source ->
        val settings = NeighborRules.defaults.copy(allowedItemIds = oldStock.dropLast(1))
        execute(source, "INSERT INTO neighbor_settings(singleton,version,settings) VALUES(true,12,?::jsonb)", economyJson.encodeToString(settings))
        val before = scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s")
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("75").load().migrate()
        assertEquals(before, scalar(source, "SELECT to_jsonb(s)::text FROM neighbor_settings s"))
    }
}
