package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.sql.SQLException
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcNewPlayerRewardCourseMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c -> c.economyRows(sql) { it.getString(1) }.single() }

    @Test fun `V74 preserves accepted v5 v6 courses and tutorial states while only fresh profiles receive v7`() {
        DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("73").load().migrate()
            for (version in listOf(5, 6)) {
                val user = UUID.randomUUID()
                execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES(?,?,'Saved')", user, "0000-0000-000$version")
                execute(source, "INSERT INTO game_daily_rewards(user_id,next_step,reward_catalog_version) VALUES(?,3,?)", user, version)
                execute(source, "INSERT INTO economy_profiles(user_id,revision,state) VALUES(?,9,economy_v4_initial_state('{}',true))", user)
            }
            val profiles = scalar(source, "SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id)::text FROM economy_profiles p")
            val daily = scalar(source, "SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id)::text FROM game_daily_rewards p")
            DatabaseFactory.migrate(source)
            assertEquals(profiles, scalar(source, "SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id)::text FROM economy_profiles p"))
            assertEquals(daily, scalar(source, "SELECT jsonb_agg(to_jsonb(p)-'achievement_reward_version' ORDER BY user_id)::text FROM game_daily_rewards p"))
            assertEquals("2", scalar(source, "SELECT count(*)::text FROM game_daily_rewards WHERE achievement_reward_version=6"))
            val fresh = UUID.randomUUID()
            execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES(?,'0000-0000-0007','Fresh')", fresh)
            execute(source, "INSERT INTO game_daily_rewards(user_id) VALUES(?)", fresh)
            assertEquals("7", scalar(source, "SELECT reward_catalog_version::text FROM game_daily_rewards WHERE user_id='$fresh'"))
            assertEquals("7", scalar(source, "SELECT economy_v4_initial_state('{}',true)#>>'{tutorialOrder,rewardVersion}'"))
            assertEquals("23514", assertFailsWith<SQLException> { execute(source, "UPDATE game_daily_rewards SET reward_catalog_version=8 WHERE user_id=?", fresh) }.sqlState)
            DatabaseFactory.migrate(source)
            assertEquals(profiles, scalar(source, "SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id)::text FROM economy_profiles p"))
        }
    }
}
