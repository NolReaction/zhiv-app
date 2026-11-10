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
class JdbcEconomyRewardPromisesMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String, vararg values: Any?): String = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }

    @Test fun `V73 preserves old mail and daily promises and affects only future tutorial states`() {
        val config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("70").load().migrate()
            val user=UUID.randomUUID()
            execute(source,"INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0071','Saved promises')",user)
            execute(source,"INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,7,economy_v4_initial_state('{}',true))",user)
            execute(source,"INSERT INTO game_daily_rewards(user_id,next_step,last_claim_at,last_claim_date) VALUES (?,3,'2026-10-25T12:00:00Z','2026-10-25')",user)
            execute(source,"INSERT INTO player_mail_messages(user_id,source_key,type,title,body,notify) VALUES (?,'welcome:v1','event','Welcome','100 pearls',false)",user)
            val before=scalar(source,"SELECT to_jsonb(p)::text FROM economy_profiles p WHERE user_id=?",user)
            DatabaseFactory.migrate(source)
            assertEquals(before,scalar(source,"SELECT to_jsonb(p)::text FROM economy_profiles p WHERE user_id=?",user))
            assertEquals("100",scalar(source,"SELECT welcome_pearls::text FROM player_mail_messages WHERE user_id=?",user))
            assertEquals("3:5",scalar(source,"SELECT next_step::text||':'||reward_catalog_version::text FROM game_daily_rewards WHERE user_id=?",user))
            assertEquals("7",scalar(source,"SELECT economy_v4_initial_state('{}',true)#>>'{tutorialOrder,rewardVersion}'"))
            assertEquals("13",scalar(source,"SELECT economy_v4_initial_state('{}',true)#>>'{tutorialOrder,terms,coins}'"))
            val fresh=UUID.randomUUID()
            execute(source,"INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0072','New gifts')",fresh)
            execute(source,"INSERT INTO game_daily_rewards(user_id) VALUES (?)",fresh)
            assertEquals("7",scalar(source,"SELECT reward_catalog_version::text FROM game_daily_rewards WHERE user_id=?",fresh))
            assertEquals("23514",assertFailsWith<SQLException> {
                execute(source,"UPDATE game_daily_rewards SET reward_catalog_version=99 WHERE user_id=?",fresh)
            }.sqlState)
            DatabaseFactory.migrate(source)
            assertEquals("100",scalar(source,"SELECT welcome_pearls::text FROM player_mail_messages WHERE user_id=?",user))
            assertEquals(before,scalar(source,"SELECT to_jsonb(p)::text FROM economy_profiles p WHERE user_id=?",user))
        }
    }
}
