package ru.zhiv.db

import kotlinx.serialization.json.jsonObject
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import java.time.Instant
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcResidentActivityMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String, vararg values: Any?): String = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }

    @Test fun `V78 grants existing earned friendship one fixed grace without changing other saved promises`() {
        DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("77").load().migrate()
            val earned = UUID.randomUUID(); val empty = UUID.randomUUID()
            for ((id, publicId) in listOf(earned to "0000-0000-0078", empty to "0000-0000-0079")) {
                execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES(?,?,'Saved')", id, publicId)
                execute(source, "INSERT INTO economy_profiles(user_id,revision,state) VALUES(?,9,economy_v4_initial_state('{}',true))", id)
            }
            execute(source, """UPDATE economy_profiles SET state=jsonb_set(state,'{tradeRelations}',
                '{"version":1,"reputation":{"builder":1800,"plesk":600},"dailyCycle":1,"dailyOrderXp":{"builder":60},"completedWeekly":2}') WHERE user_id=?""", earned)
            val before = economyJson.parseToJsonElement(scalar(source, "SELECT state::text FROM economy_profiles WHERE user_id=?", earned)).jsonObject
            val emptyBefore = scalar(source, "SELECT to_jsonb(p)::text FROM economy_profiles p WHERE user_id=?", empty)
            val began = Instant.now()
            DatabaseFactory.migrate(source)
            val migrated = scalar(source, "SELECT state::text FROM economy_profiles WHERE user_id=?", earned)
            val after = economyJson.parseToJsonElement(migrated).jsonObject
            val relations = economyJson.decodeFromString<EconomyTradeRelationsState>(after.getValue("tradeRelations").toString())
            assertEquals(before - "tradeRelations", after - "tradeRelations")
            assertEquals(before.getValue("tradeRelations").jsonObject, after.getValue("tradeRelations").jsonObject - "activity")
            assertEquals(setOf("builder", "plesk"), relations.activity.keys)
            relations.activity.values.forEach { saved ->
                assertEquals(10000, saved.pointsBps)
                assertFalse(Instant.parse(saved.updatedAt).isBefore(began.minusSeconds(1)))
            }
            assertEquals(0, EconomyTradeRelations.activityBps(relations, "builder", began.plusSeconds(11 * 86400L)))
            assertEquals("9", scalar(source, "SELECT revision::text FROM economy_profiles WHERE user_id=?", earned))
            assertEquals(emptyBefore, scalar(source, "SELECT to_jsonb(p)::text FROM economy_profiles p WHERE user_id=?", empty))
            DatabaseFactory.migrate(source)
            assertEquals(migrated, scalar(source, "SELECT state::text FROM economy_profiles WHERE user_id=?", earned))
        }
    }
}
