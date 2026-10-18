package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.MountableFile
import ru.zhiv.config.AppConfig
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.EconomyCommand
import ru.zhiv.economy.EconomyRules
import ru.zhiv.forest.ForestMemoryCommand
import ru.zhiv.world.WorldCommand
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** Exercises the operator's actual psql script, not a rewritten reset query. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcGameProgressResetIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    private fun execute(source: DataSource, sql: String) = source.connection.use { connection ->
        connection.createStatement().use { it.execute(sql) }
        connection.commit()
    }

    private fun snapshot(source: DataSource): Map<String, String> = source.connection.use { connection ->
        val tables = connection.createStatement().use { statement ->
            statement.executeQuery("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").use { rows ->
                buildList { while (rows.next()) add(rows.getString(1)) }
            }
        }
        tables.associateWith { table ->
            connection.createStatement().use { statement ->
                statement.executeQuery("""SELECT coalesce(jsonb_agg(entry ORDER BY entry::text),'[]'::jsonb)::text
                    FROM (SELECT to_jsonb(t) AS entry FROM public."$table" t) entries""").use { rows ->
                    check(rows.next()); rows.getString(1)
                }
            }
        }
    }

    private fun reset(apply: Boolean? = null): org.testcontainers.containers.Container.ExecResult {
        val command = mutableListOf("psql", "-X", "-U", postgres.username, "-d", postgres.databaseName, "-v", "ON_ERROR_STOP=1")
        if (apply != null) command.addAll(listOf("-v", "apply_reset=${if (apply) "on" else "off"}"))
        command.addAll(listOf("-f", "/tmp/reset-game-progress.sql"))
        return postgres.execInContainer(*command.toTypedArray())
    }

    @Test fun `game reset preserves full identities friends and service rows and rejects pre-reset commands`(): Unit = runBlocking {
        val script = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .map { it.resolve("scripts/reset-game-progress.sql") }.first { Files.exists(it) }
        postgres.copyFileToContainer(MountableFile.forHostPath(script), "/tmp/reset-game-progress.sql")
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            execute(source, """
                INSERT INTO app_users(id,public_id,display_name) VALUES
                  ('10000000-0000-4000-8000-000000000001','0000-0000-0001','First'),
                  ('20000000-0000-4000-8000-000000000002','0000-0000-0002','Friend');
                INSERT INTO app_sessions(id,user_id,token_hash,expires_at)
                  VALUES ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
                    decode(repeat('12',32),'hex'),clock_timestamp()+interval '1 day');
                INSERT INTO account_login_identities(provider,subject,user_id)
                  VALUES ('email','reset-test@example.invalid','10000000-0000-4000-8000-000000000001');
                INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id)
                  VALUES ('40000000-0000-4000-8000-000000000004','DIRECT','10000000-0000-4000-8000-000000000001',
                    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
                INSERT INTO direct_requests(id,requester_user_id,recipient_user_id,idempotency_key)
                  VALUES ('80000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001',
                    '20000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000009');
                UPDATE direct_requests SET status='ACCEPTED',result_circle_id='40000000-0000-4000-8000-000000000004',
                  result_circle_kind='DIRECT',responded_at=clock_timestamp() WHERE id='80000000-0000-4000-8000-000000000008';
                INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
                  VALUES ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003',
                    '50000000-0000-4000-8000-000000000005','2026-10-01T12:00:00Z','2026-10-01T12:00:30Z','UTC','2026-10-01');
                INSERT INTO world_profiles(user_id,revision,state)
                  VALUES ('10000000-0000-4000-8000-000000000001',11,
                    '{"schemaVersion":1,"resources":{"sparks":100,"wood":20,"stone":10},"houseLevel":3}');
                INSERT INTO economy_profiles(user_id,revision,state)
                  SELECT user_id,9,economy_v4_initial_state(state) FROM world_profiles;
                INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision)
                  VALUES ('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a',
                    '{"expectedRevision":39}','Old receipt predating an individual reset',40);
                INSERT INTO game_profiles(user_id,lifetime_taps,best_series)
                  VALUES ('10000000-0000-4000-8000-000000000001',5000,100);
                INSERT INTO game_items(user_id,item_id) VALUES ('10000000-0000-4000-8000-000000000001','flower');
                INSERT INTO game_achievements(user_id,achievement_id)
                  VALUES ('10000000-0000-4000-8000-000000000001','thousand_taps');
                INSERT INTO forest_memory(user_id,revision,snapshot,updated_at)
                  VALUES ('10000000-0000-4000-8000-000000000001',7,'{"oldScene":true}',clock_timestamp());
                INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price)
                  VALUES ('60000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','fish',5,100);
                INSERT INTO notification_preferences(user_id,preferences)
                  VALUES ('10000000-0000-4000-8000-000000000001','{"rateLimitsEnabled":true}');
                INSERT INTO notification_subscriptions(endpoint_hash,user_id,session_id,endpoint,p256dh,auth)
                  VALUES (decode(repeat('34',32),'hex'),'10000000-0000-4000-8000-000000000001',
                    '30000000-0000-4000-8000-000000000003','https://example.invalid/push/reset-test','key','auth');
                INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,
                    action,reason,affected_sessions,payload,changed)
                  VALUES ('c0000000-0000-4000-8000-00000000000c','10000000-0000-4000-8000-000000000001',
                    '10000000-0000-4000-8000-000000000001','0000-0000-0001','0000-0000-0001',
                    'mail_broadcast','Gameplay reset retention test',0,'{}',true);
                INSERT INTO admin_mail_broadcasts(request_id,title,body,audience,notify,recipient_count,created_at)
                  VALUES ('c0000000-0000-4000-8000-00000000000c','Service letter','Keep this letter','players',true,1,clock_timestamp());
                INSERT INTO player_mail_messages(id,user_id,source_key,type,title,body,notify)
                  VALUES ('b0000000-0000-4000-8000-00000000000b','10000000-0000-4000-8000-000000000001',
                    'broadcast:c0000000-0000-4000-8000-00000000000c','admin_notice','Service letter','Keep this letter',true);
                INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at) VALUES
                  ('10000000-0000-4000-8000-000000000001','checkin:test','checkin',clock_timestamp(),clock_timestamp()),
                  ('10000000-0000-4000-8000-000000000001','mail:b0000000-0000-4000-8000-00000000000b','mail',clock_timestamp(),clock_timestamp()),
                  ('10000000-0000-4000-8000-000000000001','job:test','exploration',clock_timestamp(),clock_timestamp());
                INSERT INTO promo_redemptions(user_id,origin_user_id,promo_id,request_id,title,reward,accepted_revision)
                  VALUES ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','already-used',
                    '70000000-0000-4000-8000-000000000007','Test gift','{}',1);
                INSERT INTO game_presence_daily(user_id,day,online_millis)
                  VALUES ('10000000-0000-4000-8000-000000000001','2026-10-01',1000);
            """.trimIndent())
            val before = snapshot(source)
            val preview = reset()
            assertEquals(0, preview.exitCode, preview.stderr)
            assertEquals(before, snapshot(source), "No-argument SQL invocation must be read only")

            execute(source, "UPDATE flyway_schema_history SET version='62' WHERE version='61'")
            val unreviewed = snapshot(source)
            val wrongVersion = reset(true)
            assertNotEquals(0, wrongVersion.exitCode)
            assertTrue(wrongVersion.stderr.contains("Expected successfully applied migrations through V61"), wrongVersion.stderr)
            assertEquals(unreviewed, snapshot(source), "An unreviewed migration must fail before deletion")
            execute(source, "UPDATE flyway_schema_history SET version='61' WHERE version='62'")

            execute(source, "CREATE TABLE ci_unreviewed_game_reset_guard(value text)")
            val unexpected = snapshot(source)
            assertNotEquals(0, reset(true).exitCode)
            assertEquals(unexpected, snapshot(source), "Unknown tables must fail before deletion")
            execute(source, "DROP TABLE ci_unreviewed_game_reset_guard")

            execute(source, "UPDATE economy_profiles SET revision=9007199254740990")
            val exhausted = snapshot(source)
            val overflow = reset(true)
            assertNotEquals(0, overflow.exitCode)
            assertTrue(overflow.stderr.contains("exhausted revision fence"), overflow.stderr)
            assertEquals(exhausted, snapshot(source))
            execute(source, "UPDATE economy_profiles SET revision=9")

            // A trigger silently modifying a kept row must cause a full rollback.
            execute(source, """
                CREATE FUNCTION ci_reset_preservation_probe() RETURNS trigger LANGUAGE plpgsql AS ${'$'}${'$'}
                BEGIN UPDATE app_users SET display_name='Changed unexpectedly'; RETURN NULL; END ${'$'}${'$'};
                CREATE TRIGGER ci_reset_preservation_probe AFTER TRUNCATE ON world_profiles
                  FOR EACH STATEMENT EXECUTE FUNCTION ci_reset_preservation_probe();
            """.trimIndent())
            val refused = reset(true)
            assertNotEquals(0, refused.exitCode)
            assertTrue(refused.stderr.contains("Preserved table app_users changed"), refused.stderr)
            assertEquals(before, snapshot(source), "Preservation failure must roll back both deletion and trigger writes")
            execute(source, "DROP TRIGGER ci_reset_preservation_probe ON world_profiles; DROP FUNCTION ci_reset_preservation_probe()")

            val applied = reset(true)
            assertEquals(0, applied.exitCode, applied.stderr)
            val after = snapshot(source)
            val sql = Files.readString(script)
            fun tables(name: String): List<String> = Regex("$name text\\[\\] := ARRAY\\[([\\s\\S]*?)];")
                .find(sql)!!.groupValues[1].let { body -> Regex("'([a-z_]+)'").findAll(body).map { it.groupValues[1] }.toList() }
            for (table in tables("preserved_tables") + "flyway_schema_history")
                assertEquals(before.getValue(table), after.getValue(table), "Preserved full contents: $table")
            for (table in tables("cleared_tables")) assertEquals("[]", after.getValue(table), "Cleared: $table")
            assertTrue(after.getValue("notification_events").contains("checkin:test"))
            assertTrue(after.getValue("notification_events").contains("mail:b0000000-0000-4000-8000-00000000000b"))
            assertTrue(!after.getValue("notification_events").contains("job:test"))

            val user = UUID.fromString("10000000-0000-4000-8000-000000000001")
            source.connection.use { connection ->
                val fresh = readEconomyProfile(connection, user)
                assertEquals(41L, fresh.revision, "Fence includes receipts newer than the current profile")
                assertEquals(EconomyRules.initial().wallet, fresh.state.wallet)
                assertEquals(EconomyRules.initial().inventory, fresh.state.inventory)
                assertEquals(EconomyRules.initial().tutorialOrder, fresh.state.tutorialOrder)
                assertTrue(fresh.state.jobs.isEmpty())
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT state::text,revision FROM world_profiles").use { rows ->
                        assertTrue(rows.next())
                        assertEquals(WorldState(), worldJson.decodeFromString<WorldState>(rows.getString(1)))
                        assertEquals(41L, rows.getLong(2))
                    }
                }
            }
            val hash = ByteArray(32) { 0x12.toByte() }
            for (oldRevision in listOf(0L, 9L, 40L)) {
                val old = EconomyCommand(UUID.randomUUID().toString(), "0000-0000-0001", oldRevision, "sell", "wood")
                assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
                    JdbcEconomyRepository(source).command(hash, old)
                }.code)
            }
            assertEquals("WORLD_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
                JdbcWorldRepository(source).command(hash, WorldCommand(UUID.randomUUID().toString(),
                    "0000-0000-0001", 11, "equip", "remove_head"))
            }.code)
            assertEquals("FOREST_MEMORY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
                JdbcForestMemoryRepository(source).command(hash, ForestMemoryCommand("0000-0000-0001",
                    UUID.randomUUID().toString(), UUID.randomUUID().toString(), 7, "acquire"))
            }.code)
            assertEquals("GAME_VISIBILITY_CONFLICT", assertFailsWith<AuthFailure> {
                JdbcGameRepository(source).setVisibility(hash, true, 0, "0000-0000-0001")
            }.code)
            assertEquals(after, snapshot(source), "Rejected stale retries must not change any fresh or preserved data")
        }
    }
}
