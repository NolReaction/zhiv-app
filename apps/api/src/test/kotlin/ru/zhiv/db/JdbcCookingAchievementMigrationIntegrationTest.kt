package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.sql.SQLException
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

@Testcontainers(disabledWithoutDocker = true)
class JdbcCookingAchievementMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()

    @Test fun `V79 admits three cooking variety tiers and preserves paid historic awards`() {
        DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("78").load().migrate()
            val user = UUID.randomUUID()
            fun scalar(sql: String): String = source.connection.use { c -> c.economyRows(sql, user) { it.getString(1) }.single() }
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0080','Cook')", user)
                c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'campfire_cook','2026-01-01T00:00:00Z')", user)
                c.economyUpdate("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'campfire_cook',4,'2026-01-01T00:00:00Z')", user)
                c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'campfire_cook',4,220,'2026-01-01T00:00:00Z')", user)
                c.commit()
            }
            val award = scalar("SELECT to_jsonb(r)::text FROM game_achievements r WHERE user_id=?")
            val tier = scalar("SELECT to_jsonb(r)::text FROM game_achievement_tiers r WHERE user_id=?")
            val paid = scalar("SELECT to_jsonb(r)::text FROM game_achievement_reward_claims r WHERE user_id=?")
            DatabaseFactory.migrate(source)
            assertEquals(award, scalar("SELECT to_jsonb(r)::text FROM game_achievements r WHERE user_id=?"))
            assertEquals(tier, scalar("SELECT to_jsonb(r)::text FROM game_achievement_tiers r WHERE user_id=?"))
            assertEquals(paid, scalar("SELECT to_jsonb(r)::text FROM game_achievement_reward_claims r WHERE user_id=?"))
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'forest_cuisine',clock_timestamp())", user)
                for ((index, pearls) in listOf(10L, 20L, 40L).withIndex()) {
                    c.economyUpdate("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'forest_cuisine',?,clock_timestamp())", user, index + 1)
                    c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'forest_cuisine',?,?,clock_timestamp())", user, index + 1, pearls)
                }
                c.commit()
                assertFailsWith<SQLException> {
                    c.economyUpdate("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'forest_cuisine',4,clock_timestamp())", user)
                }
                c.rollback()
                assertFailsWith<SQLException> {
                    c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'forest_cuisine',4,100,clock_timestamp())", user)
                }
                c.rollback()
                assertFailsWith<SQLException> {
                    c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'invented_cooking_medal',clock_timestamp())", user)
                }
                c.rollback()
            }
            assertEquals("3", scalar("SELECT count(*)::text FROM game_achievement_tiers WHERE user_id=? AND achievement_id='forest_cuisine'"))
            assertEquals("70", scalar("SELECT sum(pearls)::text FROM game_achievement_reward_claims WHERE user_id=? AND achievement_id='forest_cuisine'"))
        }
    }
}
