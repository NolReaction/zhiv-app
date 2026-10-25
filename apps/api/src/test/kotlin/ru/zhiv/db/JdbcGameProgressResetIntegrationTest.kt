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
import ru.zhiv.mail.WELCOME_MAIL_SOURCE
import ru.zhiv.forest.ForestMemoryCommand
import ru.zhiv.game.ProgressionRewardClaim
import ru.zhiv.world.WorldCommand
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
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

    private fun selectedRows(source: DataSource, query: String): String = source.connection.use { connection ->
        connection.createStatement().use { statement -> statement.executeQuery(query).use { rows ->
            check(rows.next()); rows.getString(1)
        } }
    }

    private fun reset(apply: Boolean? = null): org.testcontainers.containers.Container.ExecResult {
        val command = mutableListOf("psql", "-X", "-U", postgres.username, "-d", postgres.databaseName, "-v", "ON_ERROR_STOP=1")
        if (apply != null) command.addAll(listOf("-v", "apply_reset=${if (apply) "on" else "off"}"))
        command.addAll(listOf("-f", "/tmp/reset-game-progress.sql"))
        return postgres.execInContainer(*command.toTypedArray())
    }

    @Test fun `release reset keeps auth and friends clears history restarts rewards and is idempotent`(): Unit = runBlocking {
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
                INSERT INTO app_users(id,public_id,display_name)
                  SELECT ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
                    '0000-0000-' || lpad(n::text,4,'0'),'Friend ' || n FROM generate_series(3,6) n;
                UPDATE app_users SET last_check_in_at='2026-10-01T12:00:00Z'
                  WHERE id='10000000-0000-4000-8000-000000000001';
                INSERT INTO app_sessions(id,user_id,token_hash,expires_at)
                  VALUES ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
                    decode(repeat('12',32),'hex'),clock_timestamp()+interval '1 day');
                INSERT INTO account_login_identities(provider,subject,user_id)
                  VALUES ('email','reset-test@example.invalid','10000000-0000-4000-8000-000000000001');
                INSERT INTO account_recovery_codes(code_hash,user_id)
                  VALUES (decode(repeat('56',32),'hex'),'10000000-0000-4000-8000-000000000001');
                INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id)
                  SELECT ('40000000-0000-4000-8000-' || lpad((n+10)::text,12,'0'))::uuid,'DIRECT',
                    '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
                    ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid FROM generate_series(3,6) n;
                INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id)
                  VALUES ('40000000-0000-4000-8000-000000000004','DIRECT','10000000-0000-4000-8000-000000000001',
                    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
                INSERT INTO earth_sharing_settings(user_id,mode,revision,precision,sharing_until,publication_epoch,publisher_session_id)
                  VALUES ('10000000-0000-4000-8000-000000000001','SHARING',7,'APPROXIMATE',clock_timestamp()+interval '1 hour',
                    'e0000000-0000-4000-8000-00000000000e','30000000-0000-4000-8000-000000000003');
                INSERT INTO earth_sharing_recipients(owner_user_id,circle_id,recipient_user_id)
                  VALUES ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004',
                    '20000000-0000-4000-8000-000000000002');
                WITH moment AS (SELECT clock_timestamp() AS now)
                INSERT INTO earth_latest_locations(user_id,publication_epoch,publisher_session_id,latitude,longitude,accuracy_meters,precision,updated_at,expires_at,accepted_at)
                  SELECT '10000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-00000000000e','30000000-0000-4000-8000-000000000003',55.75,37.62,1500,
                    'APPROXIMATE',now,now+interval '120 seconds',now FROM moment;
                UPDATE earth_sharing_recipients SET frozen=true
                  WHERE owner_user_id='10000000-0000-4000-8000-000000000001';
                INSERT INTO earth_frozen_locations(owner_user_id,circle_id,publisher_session_id,latitude,longitude,
                    accuracy_meters,precision,updated_at,expires_at,accepted_at)
                  SELECT p.user_id,g.circle_id,p.publisher_session_id,p.latitude,p.longitude,p.accuracy_meters,
                    p.precision,p.updated_at,p.expires_at,p.accepted_at
                  FROM earth_latest_locations p JOIN earth_sharing_recipients g ON g.owner_user_id=p.user_id;
                INSERT INTO direct_requests(id,requester_user_id,recipient_user_id,idempotency_key)
                  VALUES ('80000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001',
                    '20000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000009');
                UPDATE direct_requests SET status='ACCEPTED',result_circle_id='40000000-0000-4000-8000-000000000004',
                  result_circle_kind='DIRECT',responded_at=clock_timestamp() WHERE id='80000000-0000-4000-8000-000000000008';
                INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode)
                  VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','LATEST_ONLY');
                WITH moment AS (SELECT clock_timestamp() AS now)
                INSERT INTO check_ins(id,user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
                  SELECT '51000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001',
                    '30000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000005',
                    now,now+interval '30 seconds','UTC',(now AT TIME ZONE 'UTC')::date FROM moment;
                INSERT INTO check_in_audiences(check_in_id,actor_user_id,circle_id,circle_kind,recipient_user_id)
                  VALUES ('51000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001',
                    '40000000-0000-4000-8000-000000000004','DIRECT','20000000-0000-4000-8000-000000000002');
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
                  VALUES ('10000000-0000-4000-8000-000000000001','thousand_taps'),
                    ('10000000-0000-4000-8000-000000000001','five_friends'),
                    ('10000000-0000-4000-8000-000000000001','linked_email'),
                    ('10000000-0000-4000-8000-000000000001','saved_recovery_code');
                INSERT INTO game_daily_rewards(user_id,next_step,last_claim_at,last_claim_date,completed)
                  VALUES ('10000000-0000-4000-8000-000000000001',7,'2026-10-01T00:00:00Z','2026-10-01',true);
                INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at)
                  VALUES ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
                    'd0000000-0000-4000-8000-00000000000d',
                    '{"requestId":"d0000000-0000-4000-8000-00000000000d","ownerPublicId":"0000-0000-0001","kind":"daily"}',
                    'daily','2026-10-01','{"kind":"daily","step":7,"reward":{"coins":80,"pearls":220,"items":{"ancient_core":1}},"claimedAt":"2026-10-01T00:00:00Z"}',
                    8,'2026-10-01T00:00:00Z');
                INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at)
                  VALUES ('10000000-0000-4000-8000-000000000001','thousand_taps',1,40,'2026-10-01T00:00:00Z'),
                    ('10000000-0000-4000-8000-000000000001','linked_email',1,40,'2026-10-01T00:00:00Z');
                INSERT INTO forest_memory(user_id,revision,snapshot,updated_at)
                  VALUES ('10000000-0000-4000-8000-000000000001',7,'{"oldScene":true}',clock_timestamp());
                INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price)
                  VALUES ('60000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','fish',5,100);
                INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price,status,closed_at,
                    seller_fee_bps,sale_owner_id,sale_proceeds_coins,sale_buyer_name,sale_buyer_character_id)
                  VALUES ('61000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001',
                    'berries',2,20,'sold',clock_timestamp(),500,'10000000-0000-4000-8000-000000000001',
                    19,'Берест · Персонаж мира','berest');
                INSERT INTO neighbor_settings(singleton,version,settings) VALUES (true,1,'{}');
                INSERT INTO neighbor_identity(user_id,first_buy_consumed)
                  VALUES ('10000000-0000-4000-8000-000000000001',true);
                INSERT INTO neighbor_shop_cycles(user_id,cycle_day,offers)
                  VALUES ('10000000-0000-4000-8000-000000000001',CURRENT_DATE,'[]');
                INSERT INTO neighbor_daily_usage(user_id,trade_day,used_lots,spent_coins)
                  VALUES ('10000000-0000-4000-8000-000000000001',CURRENT_DATE,2,40);
                INSERT INTO neighbor_global_usage(trade_day,spent_coins) VALUES (CURRENT_DATE,40);
                INSERT INTO neighbor_receipts(user_id,request_id,signature,message,accepted_revision)
                  VALUES ('10000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000006',
                    '{}','Историческая покупка',30);
                INSERT INTO neighbor_purchases(id,listing_id,user_id,item_id,quantity,total_price,proceeds_coins,source)
                  VALUES ('63000000-0000-4000-8000-000000000006','61000000-0000-4000-8000-000000000006',
                    '10000000-0000-4000-8000-000000000001','berries',2,20,19,'auto');
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
                INSERT INTO promo_redemptions(user_id,origin_user_id,promo_id,request_id,title,reward,accepted_revision)
                  VALUES ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','already-used',
                    '70000000-0000-4000-8000-000000000007','Test gift','{}',1);
                INSERT INTO game_presence_accounts(user_id,credited_until)
                  VALUES ('10000000-0000-4000-8000-000000000001',clock_timestamp());
                INSERT INTO game_presence_daily(user_id,day,online_millis)
                  VALUES ('10000000-0000-4000-8000-000000000001','2026-10-01',1000);
            """.trimIndent())
            val hash = ByteArray(32) { 0x12.toByte() }
            val mailbox = JdbcMailRepository(source)
            val welcome = mailbox.inbox(hash, "0000-0000-0001").messages.single { it.gift != null }
            val welcomeId = UUID.fromString(welcome.id)
            val gift = mailbox.claim(hash, "0000-0000-0001", welcomeId)
            assertTrue(gift.gift.claimedAt != null)
            // Wallet updates reconcile notification sources. Seed the operator's
            // retention fixtures after that update, so they exist before reset.
            execute(source, """
                INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at) VALUES
                  ('10000000-0000-4000-8000-000000000001','checkin:test','checkin',clock_timestamp(),clock_timestamp()),
                  ('10000000-0000-4000-8000-000000000001','mail:b0000000-0000-4000-8000-00000000000b','mail',clock_timestamp(),clock_timestamp()),
                  ('10000000-0000-4000-8000-000000000001','job:test','exploration',clock_timestamp(),clock_timestamp());
                INSERT INTO notification_batches(id,user_id,reserved_at,state,finished_at) VALUES
                  ('b1000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',clock_timestamp(),'delivered',clock_timestamp()),
                  ('b1000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',clock_timestamp(),'delivered',clock_timestamp());
                UPDATE notification_events SET state='delivered',batch_id='b1000000-0000-4000-8000-000000000001'
                  WHERE category='mail';
                UPDATE notification_events SET state='delivered',batch_id='b1000000-0000-4000-8000-000000000002'
                  WHERE category='checkin';
            """.trimIndent())
            val protectedProjections = listOf(
                "SELECT jsonb_agg(to_jsonb(u)-'last_check_in_at' ORDER BY id)::text FROM app_users u",
                "SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id,achievement_id)::text FROM game_achievements a WHERE achievement_id IN ('linked_email','saved_recovery_code')",
                "SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id,achievement_id)::text FROM game_achievement_reward_claims a WHERE achievement_id IN ('linked_email','saved_recovery_code')",
                "SELECT jsonb_agg(to_jsonb(m) ORDER BY id)::text FROM player_mail_messages m WHERE source_key<>'welcome:v1'",
                "SELECT jsonb_agg(to_jsonb(b) ORDER BY id)::text FROM notification_batches b WHERE id='b1000000-0000-4000-8000-000000000001'",
                "SELECT jsonb_agg(to_jsonb(l) ORDER BY id)::text FROM economy_market_listings l WHERE status='sold'",
            ).associateWith { selectedRows(source, it) }
            val before = snapshot(source)
            assertNotEquals("[]", before.getValue("earth_frozen_locations"), "The reset fixture includes a frozen recipient snapshot")
            source.connection.use { connection ->
                assertEquals(1L, connection.economyRows("SELECT count(*) FROM earth_sharing_recipients WHERE frozen") { it.getLong(1) }.single(),
                    "Recipient freeze choice is preserved separately from GPS rows")
            }
            val preview = reset()
            assertEquals(0, preview.exitCode, preview.stderr)
            assertEquals(before, snapshot(source), "No-argument SQL invocation must be read only")

            execute(source, "UPDATE flyway_schema_history SET version='73' WHERE version='72'")
            val unreviewed = snapshot(source)
            val wrongVersion = reset(true)
            assertNotEquals(0, wrongVersion.exitCode)
            assertTrue(wrongVersion.stderr.contains("Expected successfully applied migrations through V72"), wrongVersion.stderr)
            assertEquals(unreviewed, snapshot(source), "An unreviewed migration must fail before deletion")
            execute(source, "UPDATE flyway_schema_history SET version='72' WHERE version='73'")

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
            execute(source, "UPDATE economy_profiles SET revision=10")

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
            for ((query, rows) in protectedProjections) assertEquals(rows, selectedRows(source, query), "Only reviewed fields may change")
            val sql = Files.readString(script)
            fun tables(name: String): List<String> = Regex("$name text\\[\\] := ARRAY\\[([\\s\\S]*?)];")
                .find(sql)!!.groupValues[1].let { body -> Regex("'([a-z_]+)'").findAll(body).map { it.groupValues[1] }.toList() }
            for (table in tables("preserved_tables") + "flyway_schema_history")
                assertEquals(before.getValue(table), after.getValue(table), "Preserved full contents: $table")
            for (table in tables("cleared_tables")) assertEquals("[]", after.getValue(table), "Cleared: $table")
            assertTrue(after.getValue("economy_market_listings").contains("61000000-0000-4000-8000-000000000006"),
                "A confirmed neighbor purchase and its manually claimable proceeds survive the release reset")
            assertTrue(!after.getValue("economy_market_listings").contains("60000000-0000-4000-8000-000000000006"),
                "Active escrow from the discarded game is removed")
            assertEquals(before.getValue("neighbor_receipts"), after.getValue("economy_market_receipts"),
                "Persistent neighbor receipts must retain cross-endpoint request UUID fences after reset")
            assertTrue(!after.getValue("notification_events").contains("checkin:test"))
            assertTrue(after.getValue("notification_events").contains("mail:b0000000-0000-4000-8000-00000000000b"))
            assertTrue(!after.getValue("notification_events").contains("job:test"))
            assertTrue(!after.getValue("notification_batches").contains("b1000000-0000-4000-8000-000000000002"))

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
            val presence = JdbcPresenceRepository(source)
            assertEquals(1L, presence.currentGeneration())
            assertEquals("GAME_PROGRESS_RESET", assertFailsWith<AuthFailure> {
                presence.requireGeneration(hash, 0)
            }.code, "An old revisionless reward request must fail at the shared HTTP generation guard")
            assertEquals("MAIL_NOT_FOUND", assertFailsWith<AuthFailure> {
                mailbox.claim(hash, "0000-0000-0001", welcomeId)
            }.code, "The old welcome URL must never claim the new gift")
            for (oldRevision in listOf(0L, 9L, 10L, 40L)) {
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
            source.connection.use { connection ->
                assertEquals(0L, connection.economyRows("SELECT count(*) FROM app_users WHERE last_check_in_at IS NOT NULL") { it.getLong(1) }.single())
                assertEquals(setOf("linked_email", "saved_recovery_code"), connection.economyRows(
                    "SELECT achievement_id FROM game_achievements") { it.getString(1) }.toSet())
                assertEquals(listOf("linked_email"), connection.economyRows(
                    "SELECT achievement_id FROM game_achievement_reward_claims") { it.getString(1) })
                assertEquals(5L, connection.economyRows("SELECT count(*) FROM active_direct_friend_ids(?)", user) { it.getLong(1) }.single())
                assertEquals(0L, connection.economyRows("SELECT check_in_count FROM account_check_in_summary(?)", user) { it.getLong(1) }.single())
            }
            presence.requireGeneration(hash, 1)
            val rewards = JdbcProgressionRewardsRepository(source)
            val freshRewards = rewards.snapshot(hash)
            assertEquals(1, freshRewards.daily.step)
            assertTrue(freshRewards.daily.claimable && !freshRewards.daily.completed)
            assertNull(freshRewards.onboarding.claimedAt)
            assertTrue(freshRewards.achievementRewards.filter { it.earnedAt != null }
                .all { it.achievementId in setOf("linked_email", "saved_recovery_code") },
                "Preserved friends must not immediately recreate the old five-friends achievement")
            assertTrue(freshRewards.achievementRewards.single { it.achievementId == "linked_email" }.claimedAt != null)
            assertEquals("ONBOARDING_REWARD_UNAVAILABLE", assertFailsWith<AuthFailure> {
                rewards.claim(hash,ProgressionRewardClaim(UUID.randomUUID().toString(),"0000-0000-0001","onboarding"))
            }.code, "The old completed course cannot claim until a fresh tutorial order is fulfilled")
            val freshWelcome = mailbox.inbox(hash, "0000-0000-0001").messages.single { it.gift != null }
            assertNotEquals(welcome.id, freshWelcome.id)
            assertNull(freshWelcome.gift!!.claimedAt)
            val newWelcomeId = UUID.fromString(freshWelcome.id)
            val newGift = mailbox.claim(hash, "0000-0000-0001", newWelcomeId)
            val afterWelcome = snapshot(source)
            assertEquals(newGift.gift, mailbox.claim(hash, "0000-0000-0001", newWelcomeId).gift)
            assertEquals(afterWelcome, snapshot(source), "Fresh welcome is paid only once")
            val dailyRequest = ProgressionRewardClaim(UUID.randomUUID().toString(),"0000-0000-0001","daily")
            val daily = rewards.claim(hash,dailyRequest)
            assertEquals(1, daily.claim.step)
            assertEquals(2, daily.rewards.daily.step)
            assertTrue(rewards.claim(hash,dailyRequest).replayed)
            assertEquals("DAILY_REWARD_COOLDOWN", assertFailsWith<AuthFailure> {
                rewards.claim(hash,ProgressionRewardClaim(UUID.randomUUID().toString(),"0000-0000-0001","daily"))
            }.code)
            // Satisfy the server's existing tutorial-order predicate and verify
            // the new course reward has its own one-time receipt after the reset.
            execute(source, "UPDATE economy_profiles SET state=jsonb_set(state,'{tutorialOrder,step}','1')")
            val onboardingRequest = ProgressionRewardClaim(UUID.randomUUID().toString(),"0000-0000-0001","onboarding")
            assertEquals("onboarding", rewards.claim(hash,onboardingRequest).claim.kind)
            assertTrue(rewards.claim(hash,onboardingRequest).replayed)
            execute(source, "UPDATE game_profiles SET lifetime_taps=1000")
            val achievementRequest = ProgressionRewardClaim(UUID.randomUUID().toString(),"0000-0000-0001","achievement","thousand_taps",1)
            assertEquals("thousand_taps", rewards.claim(hash,achievementRequest).claim.achievementId)
            assertTrue(rewards.claim(hash,achievementRequest).replayed)
            val progressed = snapshot(source)
            val repeated = reset(true)
            assertEquals(0, repeated.exitCode, repeated.stderr)
            assertTrue(repeated.stderr.contains("already completed"), repeated.stderr)
            assertEquals(progressed, snapshot(source), "Repeating release 0.7.1 must preserve every new row and reward")
            assertEquals(1L, presence.currentGeneration(), "A repeated release does not advance generation")
        }
    }
}
