package ru.zhiv.db

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.sql.SQLException
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

@Testcontainers(disabledWithoutDocker = true)
class JdbcGardenLedgerMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()

    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.economyRows(sql) { it.getString(1) }.single()
    }
    private fun history(source: DataSource) = scalar(source,
        "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=56")

    private fun verify(historical: Boolean) {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            if (historical) Flyway.configure().dataSource(source).locations("classpath:db/migration/history").load().migrate()
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("56").load().migrate()
            val user = UUID.randomUUID()
            execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0001','Gardener')", user)
            fun insert(kind: String, context: JsonObject) = execute(source,
                "INSERT INTO economy_ledger(user_id,source_key,kind,coins,items,context) VALUES (?,?,?,0,'{}',?::jsonb)",
                user, "migration-test:${UUID.randomUUID()}", kind, context.toString())
            val legacy = JsonObject(mapOf("targetId" to JsonPrimitive("grow_berries"), "originAction" to JsonPrimitive("start_production")))
            insert("claim_job", legacy)
            val oldLedger = scalar(source, "SELECT jsonb_agg(to_jsonb(l) ORDER BY source_key)::text FROM economy_ledger l")
            val oldHistory = history(source)
            val ids = List(4) { UUID.randomUUID().toString() }
            val batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            fun basket(size: Int) = JsonObject(mapOf(
                "targetId" to JsonPrimitive("garden"), "originAction" to JsonPrimitive("start_production"),
                "batchId" to JsonPrimitive(batchId), "jobIds" to JsonPrimitive(ids.take(size).joinToString(",")),
                "recipeIds" to JsonPrimitive(List(size) { "grow_berries" }.joinToString(",")),
            ))
            assertEquals("23514", assertFailsWith<SQLException> { insert("start_garden_collection", basket(3)) }.sqlState)

            DatabaseFactory.migrate(source)
            assertEquals("57", scalar(source, "SELECT max(version::int)::text FROM flyway_schema_history"))
            assertEquals(oldHistory, history(source), "Earlier migration metadata remains byte-for-byte unchanged")
            assertEquals(oldLedger, scalar(source, "SELECT jsonb_agg(to_jsonb(l) ORDER BY source_key)::text FROM economy_ledger l"))
            for (kind in listOf("start_garden_collection", "claim_garden_collection"))
                for (size in 1..3) insert(kind, basket(size))
            insert("claim_job", legacy)
            insert("start_production", JsonObject(emptyMap()))

            val valid = basket(3)
            fun patch(key: String, value: String) = JsonObject(valid + (key to JsonPrimitive(value)))
            insert("claim_garden_collection", patch("recipeIds", List(3) { "x".repeat(80) }.joinToString(",")))
            val malformed = listOf(
                basket(0), basket(4), JsonObject(valid - "batchId"), JsonObject(valid - "jobIds"), JsonObject(valid - "recipeIds"),
                patch("targetId", "workshop"), patch("originAction", "start_exploration"),
                patch("batchId", "not-a-uuid"), patch("batchId", batchId.uppercase()),
                patch("jobIds", ids.take(2).joinToString(",")), patch("jobIds", "${ids[0]},"), patch("jobIds", "not-a-job"),
                patch("recipeIds", "grow_berries,unknown-recipe,grow_berries"), patch("recipeIds", "x".repeat(81)),
                patch("recipeIds", List(3) { "x".repeat(88) }.joinToString(",")),
                JsonObject(valid + ("jobIds" to JsonPrimitive(3))), JsonObject(valid + ("batchId" to JsonNull)),
                JsonObject(valid + ("privateRewards" to JsonPrimitive("ancient_core"))),
                JsonObject(mapOf("targetId" to JsonPrimitive("x".repeat(81)))),
                JsonObject(mapOf("originAction" to JsonPrimitive("invented_action"))),
            )
            for (context in malformed) assertEquals("23514", assertFailsWith<SQLException> {
                insert("start_garden_collection", context)
            }.sqlState, "Malformed garden metadata must remain rejected: $context")
            assertEquals("23514", assertFailsWith<SQLException> { insert("claim_job", valid) }.sqlState,
                "Batch metadata belongs only to the two garden actions")
            assertEquals("10", scalar(source, "SELECT count(*)::text FROM economy_ledger"), "Rejected writes leave no ledger entries")
            val completeHistory = scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
            DatabaseFactory.migrate(source)
            assertEquals(completeHistory, scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h"))
            assertEquals("true", scalar(source, "SELECT convalidated::text FROM pg_constraint WHERE conname='economy_ledger_context_ck'"))
        }
    }

    @Test fun `baseline upgrades retain old context and accept only bounded public garden basket metadata`() = verify(false)
    @Test fun `historical upgrades retain old context and accept only bounded public garden basket metadata`() = verify(true)
}
