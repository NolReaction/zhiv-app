package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@Testcontainers(disabledWithoutDocker = true)
class JdbcAchievementCourseMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()

    @Test fun `V77 preserves paid history and every existing reward course including unopened accounts`() {
        DatabaseFactory.create(AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("75").load().migrate()
            val old=UUID.randomUUID(); val unopened=UUID.randomUUID(); val fresh=UUID.randomUUID()
            fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c -> c.economyRows(sql,*values) { it.getString(1) }.single() }
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0077','Old'),(?,'0000-0000-0078','Unopened')",old,unopened)
                c.economyUpdate("INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,12,economy_v4_initial_state('{}',true))",old)
                c.economyUpdate("INSERT INTO game_daily_rewards(user_id,next_step,reward_catalog_version) VALUES (?,3,6)",old)
                c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'first_path','2026-01-01T00:00:00Z')",old)
                c.economyUpdate("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'first_path',1,'2026-01-01T00:00:00Z')",old)
                c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'first_path',1,40,'2026-01-01T00:00:00Z')",old)
                c.commit()
            }
            val state=scalar("SELECT state::text FROM economy_profiles WHERE user_id=?",old)
            val daily=scalar("SELECT to_jsonb(r)::text FROM game_daily_rewards r WHERE user_id=?",old)
            val paid=scalar("SELECT to_jsonb(r)::text FROM game_achievement_reward_claims r WHERE user_id=?",old)
            DatabaseFactory.migrate(source)
            assertEquals(state,scalar("SELECT state::text FROM economy_profiles WHERE user_id=?",old))
            assertEquals(daily,scalar("SELECT (to_jsonb(r)-'achievement_reward_version')::text FROM game_daily_rewards r WHERE user_id=?",old))
            assertEquals(paid,scalar("SELECT to_jsonb(r)::text FROM game_achievement_reward_claims r WHERE user_id=?",old))
            for(id in listOf(old,unopened)) assertEquals("6",scalar("SELECT achievement_reward_version::text FROM game_daily_rewards WHERE user_id=?",id))
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0079','New')",fresh)
                c.economyUpdate("INSERT INTO game_daily_rewards(user_id) VALUES (?)",fresh)
                c.economyUpdate("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'master_recipes',4,clock_timestamp())",old)
                c.commit()
            }
            assertEquals("7",scalar("SELECT achievement_reward_version::text FROM game_daily_rewards WHERE user_id=?",fresh))
            assertEquals("7",scalar("SELECT reward_catalog_version::text FROM game_daily_rewards WHERE user_id=?",fresh))
            assertTrue(scalar("SELECT count(*)::text FROM game_achievement_tiers WHERE user_id=? AND achievement_id='master_recipes' AND level=4",old)=="1")
        }
    }
}
