package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.*
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

/** Both the reported deployed commit and pre-release master use the unchanged V1–V28 schema. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcReleaseUpgradeIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }

    private fun scalar(source: DataSource, sql: String): String = source.connection.use { connection ->
        connection.createStatement().use { statement -> statement.executeQuery(sql).use { row ->
            assertTrue(row.next()); row.getString(1)
        } }
    }

    private fun legacyData(source: DataSource, tables: List<String>): Map<String, String> = tables.associateWith { table ->
        require(table.matches(Regex("[a-z_]+")))
        scalar(source, "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM public.\"$table\" t")
    }

    @Test fun `upgrade from deployed V28 preserves accounts authenticated sessions balances trips and receipts`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("28").cleanDisabled(true).load().migrate()
            val token = TokenCodec().issue()
            val identity = JdbcZhivRepository(source)
            val player = identity.bootstrap("До обновления", TokenCodec().issue().hash, token.hash, 365)
            identity.record(token.hash, UUID.randomUUID())
            val world = JdbcWorldRepository(source)
            val initial = world.snapshot(token.hash)
            val travel = WorldCommand(UUID.randomUUID().toString(), player.publicId, initial.revision, "start_journey", "first_path")
            val departed = world.command(token.hash, travel).snapshot
            val savedWorld = departed.state.copy(resources = WorldResources(120, 27, 13), houseLevel = 3,
                workshop = true, workshopLevel = 2, inventory = listOf("moss", "amber_scarf", "willow_rod"),
                equipment = WorldEquipment(neck = "amber_scarf", rod = "willow_rod"), collection = listOf("acorn"),
                completedJourneys = 7, hiddenGifts = listOf("flower"))
            source.connection.use { connection ->
                fun execute(sql: String, vararg values: Any?) = connection.prepareStatement(sql).use { statement ->
                    values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }; statement.executeUpdate()
                }
                execute("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email','upgrade@example.invalid',?)", player.id)
                execute("INSERT INTO game_profiles(user_id,lifetime_taps,best_series,leaderboard_opt_in) VALUES (?,12345,678,true)", player.id)
                execute("INSERT INTO game_items(user_id,item_id) VALUES (?,'flower')", player.id)
                execute("INSERT INTO game_achievements(user_id,achievement_id) VALUES (?,'ten_thousand_taps')", player.id)
                execute("UPDATE world_profiles SET state=?::jsonb,revision=8,tap_sparks=17,tap_remainder=3 WHERE user_id=?", worldJson.encodeToString(savedWorld), player.id)
                execute("INSERT INTO game_tap_activity_minutes(user_id,bucket_at,received_taps,event_taps) VALUES (?,date_trunc('minute',clock_timestamp()),15,15)", player.id)
                connection.commit()
            }
            val tables = source.connection.use { connection -> connection.createStatement().use { statement ->
                statement.executeQuery("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'flyway_schema_history' ORDER BY tablename").use { rows ->
                    buildList { while (rows.next()) add(rows.getString(1)) }
                }
            } }
            assertEquals(42, tables.size)
            val before = legacyData(source, tables)
            val historySql = "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=28"
            val oldHistory = scalar(source, historySql)

            DatabaseFactory.migrate(source)
            assertEquals(before, legacyData(source, tables), "Upgrading must not rewrite any existing player table")
            assertEquals(oldHistory, scalar(source, historySql), "Existing migration records/checksums must stay intact")
            assertEquals("30", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM player_feedback"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM player_feedback_actions"))
            assertEquals("true", scalar(source, """SELECT (count(*)=1 AND bool_and(m.singleton AND m.started_at=h.installed_on::timestamptz))::text
                FROM game_tap_collection_metadata m JOIN flyway_schema_history h ON h.version='28' AND h.success"""))
            val upgradedHistory = scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
            DatabaseFactory.migrate(source)
            assertEquals(before, legacyData(source, tables), "Repeated startup must not reapply economy effects")
            assertEquals(upgradedHistory, scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h"))

            assertEquals(player.publicId, JdbcZhivRepository(source).findBySession(token.hash)?.publicId)
            assertEquals(12345L, JdbcGameRepository(source).progress(token.hash).lifetimeTaps)
            val restored = JdbcWorldRepository(source).snapshot(token.hash)
            assertEquals(8L, restored.revision)
            assertEquals(savedWorld, restored.state)
            assertEquals(listOf("flower"), restored.gifts)
            val replay = JdbcWorldRepository(source).command(token.hash, travel)
            assertTrue(replay.replayed, "A request acknowledged before deployment must remain idempotent")
            assertEquals(savedWorld, replay.snapshot.state)
            assertEquals(8L, replay.snapshot.revision)
        }
    }
}
