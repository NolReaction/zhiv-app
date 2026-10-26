package ru.zhiv.db

import kotlinx.serialization.json.Json
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.EconomyFishInventory
import ru.zhiv.economy.EconomyRules
import ru.zhiv.economy.EconomyState
import ru.zhiv.economy.economyJson
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.assertEquals

@Testcontainers(disabledWithoutDocker = true)
class JdbcIntroOrderMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()

    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.economyRows(sql) { it.getString(1) }.single()
    }
    private fun retained(source: DataSource) = scalar(source, """SELECT jsonb_build_object(
        'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM economy_profiles p),
        'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY source_key) FROM economy_ledger l),
        'receipts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY request_id) FROM economy_commands c),
        'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank) FROM flyway_schema_history h WHERE version::int<=57)
    )::text""")

    private fun verify(historical: Boolean) {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            if (historical) Flyway.configure().dataSource(source).locations("classpath:db/migration/history").load().migrate()
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("57").load().migrate()
            val user = UUID.randomUUID()
            execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0058','Saved course')", user)
            execute(source, "INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,7,economy_v4_initial_state('{}',true))", user)
            execute(source, "INSERT INTO economy_ledger(user_id,source_key,kind,coins) VALUES (?,'saved-intro','complete_resident_order',30)", user)
            execute(source, "INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,'saved-signature','Saved receipt',7)",
                user, UUID.randomUUID())
            assertEquals("2", scalar(source, "SELECT state->'tutorialOrder'->>'version' FROM economy_profiles"))
            assertEquals("2", scalar(source, "SELECT state->'tutorialOrder'->'terms'->'items'->>'berries' FROM economy_profiles"))
            val before = retained(source)
            DatabaseFactory.migrate(source)
            assertEquals("75", scalar(source, "SELECT max(version::int)::text FROM flyway_schema_history"))
            assertEquals(before, retained(source), "V58 does not rewrite existing progress, wallet, receipts, timestamps or older history")
            source.connection.use { c ->
                for (include in listOf(true, false)) {
                    val initialized = c.economyRows("SELECT economy_v4_initial_state('{}',?)", include) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    val expected = EconomyRules.initial(includeStartingPack = include)
                    assertEquals(expected.copy(buildings = expected.buildings - setOf("bridge", "lighthouse")),
                        EconomyFishInventory.state(initialized), "SQL and Kotlin initial states agree with and without the starter pack")
                }
            }
            val function = scalar(source, "SELECT pg_get_functiondef('public.economy_v4_initial_state(jsonb,boolean)'::regprocedure)")
            DatabaseFactory.migrate(source)
            assertEquals(before, retained(source), "Restart preserves every earlier record")
            assertEquals(function, scalar(source, "SELECT pg_get_functiondef('public.economy_v4_initial_state(jsonb,boolean)'::regprocedure)"))
            assertEquals(Json.parseToJsonElement("{\"berries\":1}"), Json.parseToJsonElement(scalar(source,
                "SELECT economy_v4_initial_state('{}',true)->'tutorialOrder'->'terms'->'items'")))
            assertEquals("13", scalar(source, "SELECT economy_v4_initial_state('{}',true)->'tutorialOrder'->'terms'->>'coins'"))
        }
    }

    @Test fun `baseline upgrade changes only the future introductory order`() = verify(false)
    @Test fun `historical upgrade changes only the future introductory order`() = verify(true)
}
