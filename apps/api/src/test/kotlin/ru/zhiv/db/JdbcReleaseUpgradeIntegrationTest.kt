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
import ru.zhiv.economy.*
import ru.zhiv.notifications.NotificationPreferences
import java.time.Instant
import ru.zhiv.forest.*
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

/** Exercise upgrades from deployed schemas before memory and the replacement economy. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcReleaseUpgradeIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    private fun scalar(source: DataSource, sql: String): String = source.connection.use { connection ->
        connection.createStatement().use { statement -> statement.executeQuery(sql).use { row ->
            assertTrue(row.next()); row.getString(1)
        } }
    }

    private fun legacyData(source: DataSource, tables: List<String>): Map<String, String> = tables.associateWith { table ->
        require(table.matches(Regex("[a-z_]+")))
        // Compare historical data while separately checking V38/V50/V51/V55 metadata.
        val row = when (table) {
            "app_users" -> "(to_jsonb(t)-'security_signal_at')"
            "game_achievements" -> "(to_jsonb(t)-'reward_eligible')"
            "admin_actions" -> "(to_jsonb(t)-'accepted_revision')"
            "economy_profiles" -> "((to_jsonb(t)-'revision'-'updated_at') || jsonb_build_object('state',t.state-'marketSlots'-'unlockedItems'-'itemUnlockVersion'))"
            "notification_events" -> "(to_jsonb(t)-'harvest_ready_at'-'waiting_for_actor'-'actor_wait_until')"
            else -> "to_jsonb(t)"
        }
        scalar(source, "SELECT COALESCE(jsonb_agg($row ORDER BY ($row)::text),'[]'::jsonb)::text FROM public.\"$table\" t")
    }

    private fun seedLegacyWorld(source: DataSource, user: UUID, state: WorldState, revision: Long, command: WorldCommand) {
        source.connection.use { connection ->
            fun execute(sql: String, vararg values: Any?) = connection.prepareStatement(sql).use { statement ->
                values.forEachIndexed { index, value -> statement.setObject(index+1,value) }; statement.executeUpdate()
            }
            execute("INSERT INTO world_profiles(user_id,state,revision) VALUES (?,?::jsonb,?)",user,worldJson.encodeToString(state),revision)
            execute("INSERT INTO world_commands(user_id,request_id,signature,message) VALUES (?,?,?,?)",user,UUID.fromString(command.requestId),worldJson.encodeToString(command),"Мохлик отправился в путь")
            execute("INSERT INTO world_ledger(user_id,source_key,kind) VALUES (?,?,'start_journey')",user,"command:${command.requestId}")
            connection.commit()
        }
    }

    /** Seed the historical write directly: current achievement writers require V38. */
    private fun seedLegacyCheckIn(source: DataSource, user: UUID, tokenHash: ByteArray) = source.connection.use { c ->
        c.economyUpdate("""INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            SELECT u.id,s.id,?,statement_timestamp(),statement_timestamp()+interval '30 seconds',u.timezone_id,
                (statement_timestamp() AT TIME ZONE u.timezone_id)::date
            FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=?""", UUID.randomUUID(),user,tokenHash)
        c.economyUpdate("""UPDATE app_users SET last_check_in_at=(SELECT max(checked_at) FROM check_ins WHERE user_id=?),
            updated_at=clock_timestamp() WHERE id=?""",user,user)
        c.commit()
    }

    @Test fun `upgrade from populated V50 preserves immutable audit and reward receipts and permits economy grants`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("50").load().migrate()
            val tokens = TokenCodec(); val token = tokens.issue(); val playerToken = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val admin = identities.bootstrap("Администратор", tokens.issue().hash, token.hash, 365)
            val player = identities.bootstrap("До новой панели", tokens.issue().hash, playerToken.hash, 365)
            val repository = JdbcAdminRepository(source, ru.zhiv.admin.AdminConfig(setOf(admin.publicId)))
            val requestId = UUID.randomUUID()
            val reward = ru.zhiv.admin.AdminGrantRequest(requestId.toString(), player.publicId, "item", "flower", "Награда до обновления")
            val receipt = repository.grantReward(token.hash, player.publicId, requestId, reward)
            val moderation = ru.zhiv.admin.AdminPlayerCommand(UUID.randomUUID().toString(), player.publicId, "Проверка до обновления", "watch")
            repository.managePlayer(token.hash, player.publicId, UUID.fromString(moderation.requestId), moderation)
            JdbcEconomyRepository(source).snapshot(playerToken.hash)
            val tables = source.connection.use { c -> c.economyRows(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'flyway_schema_history' ORDER BY tablename") { it.getString(1) } }
            val before = legacyData(source, tables)
            val beforeEconomyRevision = scalar(source, "SELECT revision::text FROM economy_profiles WHERE user_id='${player.id}'").toLong()
            val oldHistorySql = "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=50"
            val oldHistory = scalar(source, oldHistorySql)
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, tables), "Existing audit, receipts, sessions and balances are unchanged")
            assertEquals((beforeEconomyRevision + 1).toString(), scalar(source,
                "SELECT revision::text FROM economy_profiles WHERE user_id='${player.id}'"), "V55 advances the profile fence exactly once")
            assertEquals("2", scalar(source, "SELECT count(*) FROM admin_actions WHERE accepted_revision IS NULL"))
            assertEquals(oldHistory, scalar(source, oldHistorySql))
            assertEquals("61", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals(receipt, repository.grantReward(token.hash, player.publicId, requestId, reward))
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, tables))
            val grant = ru.zhiv.admin.AdminEconomyGrantRequest(UUID.randomUUID().toString(), player.publicId, "Компенсация после обновления", coins = 25)
            assertTrue(repository.grantEconomy(token.hash, player.publicId, UUID.fromString(grant.requestId), grant).changed)
            assertEquals("1", scalar(source, "SELECT count(*) FROM admin_actions WHERE action='grant_economy' AND accepted_revision IS NOT NULL"))
        }
    }

    @Test fun `upgrade from populated V48 preserves notification settings and queue while keeping limits enabled`() = runBlocking<Unit> {
        val config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("48").load().migrate()
            val token=TokenCodec().issue(); val otherToken=TokenCodec().issue()
            val identities=JdbcZhivRepository(source)
            val legacy=identities.bootstrap("Прежние настройки",TokenCodec().issue().hash,token.hash,365)
            val explicit=identities.bootstrap("Явные настройки",TokenCodec().issue().hash,otherToken.hash,365)
            val preferences=NotificationPreferences(constructionCompleted=false,checkinReminder=true,quietStart="22:00",rateLimitsEnabled=true,maxPerDay=1,minIntervalMinutes=360)
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO notification_preferences(user_id,preferences) VALUES (?,?::jsonb-'rateLimitsEnabled')",
                    legacy.id,notificationJson.encodeToString(preferences))
                c.economyUpdate("INSERT INTO notification_preferences(user_id,preferences) VALUES (?,?::jsonb)",
                    explicit.id,notificationJson.encodeToString(preferences.copy(rateLimitsEnabled=false)))
                c.economyUpdate("""INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
                    VALUES (?,'job:existing','production',clock_timestamp(),clock_timestamp()+interval '2 hours')""",legacy.id)
                c.commit()
            }
            val preferenceSql="""SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('preferences',preferences-'rateLimitsEnabled') ORDER BY user_id)::text
                FROM notification_preferences p"""
            val beforePreferences=scalar(source,preferenceSql)
            val beforeQueue=legacyData(source,listOf("notification_events"))
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(beforePreferences,scalar(source,preferenceSql),"Existing choices, presence and timestamps are preserved")
            assertEquals(beforeQueue,legacyData(source,listOf("notification_events")),"Pending reminders keep their state and retry time")
            assertEquals("1",scalar(source,"""SELECT count(*) FROM notification_events
                WHERE harvest_ready_at IS NULL AND NOT waiting_for_actor AND actor_wait_until IS NULL"""),
                "Ordinary pending reminders do not acquire berry-collection metadata")
            val repository=JdbcNotificationRepository(source)
            assertEquals(preferences,repository.snapshot(token.hash,legacy.publicId).preferences)
            assertFalse(repository.snapshot(otherToken.hash,explicit.publicId).preferences.rateLimitsEnabled)
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(preferences,repository.snapshot(token.hash,legacy.publicId).preferences)
        }
    }

    @Test fun `upgrade from populated V44 adds presence without changing accounts balances or receipts`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("44").cleanDisabled(true).load().migrate()
            val token = TokenCodec().issue()
            val identity = JdbcZhivRepository(source)
            val player = identity.bootstrap("До активности", TokenCodec().issue().hash, token.hash, 365)
            // The historical fixture uses its deployed initializer, before V46 adds the new one.
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state) VALUES (?,economy_v3_initial_state('{}'::jsonb))", player.id)
                c.commit()
            }
            seedLegacyCheckIn(source, player.id, token.hash)
            val tables = source.connection.use { c -> c.economyRows(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'flyway_schema_history' ORDER BY tablename") { it.getString(1) } }
            val preservedTables = tables.filter { it != "economy_profiles" }
            val before = legacyData(source, preservedTables)
            val expectedProfile = scalar(source, """SELECT jsonb_build_object('state',state,
                'immutable',to_jsonb(e)-'state'-'revision'-'updated_at','revision',revision+1)::text
                FROM economy_profiles e WHERE user_id='${player.id}'""")
            val historySql = "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=44"
            val history = scalar(source, historySql)
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, preservedTables))
            assertEquals(expectedProfile, scalar(source, """SELECT jsonb_build_object(
                'state',state-'marketSlots'-'unlockedItems'-'itemUnlockVersion',
                'immutable',to_jsonb(e)-'state'-'revision'-'updated_at','revision',revision)::text
                FROM economy_profiles e WHERE user_id='${player.id}'"""), "V55 changes only knowledge metadata and its revision fence")
            assertEquals(history, scalar(source, historySql))
            assertEquals("61", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            for (table in listOf("game_presence_clients", "game_presence_accounts", "game_presence_daily"))
                assertEquals("0", scalar(source, "SELECT count(*) FROM $table"))
            val presence = JdbcPresenceRepository(source)
            val resumed = presence.update(token.hash, ru.zhiv.presence.PresenceRequest("resume", UUID.randomUUID().toString(), 0, true))
            assertEquals("active", resumed.status)
            assertEquals(0L, resumed.onlineTodaySeconds, "historical online time must never be invented")
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(player.publicId, identity.findBySession(token.hash)?.publicId)
        }
    }

    @Test fun `upgrade from populated V30 preserves accounts and feedback while initializing the new economy`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("30").cleanDisabled(true).load().migrate()
            val tokens = TokenCodec(); val token = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val player = identities.bootstrap("До памяти", tokens.issue().hash, token.hash, 365)
            seedLegacyCheckIn(source, player.id, token.hash)
            val world = JdbcWorldRepository(source)
            val travel = WorldCommand(UUID.randomUUID().toString(), player.publicId, 0, "start_journey", "first_path")
            val savedWorld = WorldRules.apply(WorldState(),travel,Instant.now()).first
            seedLegacyWorld(source,player.id,savedWorld,1,travel)
            source.connection.use { connection ->
                connection.prepareStatement("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email','v30-upgrade@example.invalid',?)").use { statement ->
                    statement.setObject(1, player.id); statement.executeUpdate()
                }
                connection.commit()
            }
            // Exercise the tables added in V29/V30, as well as populated legacy tables.
            JdbcFeedbackRepository(source, ru.zhiv.admin.AdminConfig(emptySet())).submit(token.hash, player.publicId, UUID.randomUUID(), "bug", "Проверка сохранности обратной связи")
            val tables = source.connection.use { connection -> connection.createStatement().use { statement ->
                statement.executeQuery("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'flyway_schema_history' ORDER BY tablename").use { rows ->
                    buildList { while (rows.next()) add(rows.getString(1)) }
                }
            } }
            val unchangedTables = tables.filterNot { it == "world_profiles" }
            val before = legacyData(source, unchangedTables)
            val historySql = "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=30"
            val beforeHistory = scalar(source, historySql)
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, unchangedTables))
            assertEquals(beforeHistory, scalar(source, historySql))
            assertEquals("61", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory_receipts"))
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, unchangedTables))
            assertEquals(player.publicId, identities.findBySession(token.hash)?.publicId)
            val memory = JdbcForestMemoryRepository(source)
            val acquire = ForestMemoryCommand(player.publicId, UUID.randomUUID().toString(), UUID.randomUUID().toString(), 0, "acquire")
            val leased = memory.command(token.hash, acquire).state
            val save = acquire.copy(requestId = UUID.randomUUID().toString(), expectedRevision = leased.revision,
                action = "save", leaseToken = leased.lease.token, snapshot = memoryFixture())
            val saved = memory.command(token.hash, save).state
            assertEquals(memoryFixture(), JdbcForestMemoryRepository(source).read(token.hash, player.publicId, UUID.fromString(acquire.clientId)).snapshot)
            assertEquals(2L, saved.revision)
            assertEquals(savedWorld, world.snapshot(token.hash).state)
            assertEquals(2L, world.snapshot(token.hash).revision)
            assertTrue(world.command(token.hash, travel).replayed)
        }
    }

    @Test fun `upgrade from deployed V28 preserves accounts authenticated sessions balances trips and receipts`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("28").cleanDisabled(true).load().migrate()
            val token = TokenCodec().issue()
            val identity = JdbcZhivRepository(source)
            val player = identity.bootstrap("До обновления", TokenCodec().issue().hash, token.hash, 365)
            seedLegacyCheckIn(source, player.id, token.hash)
            val travel = WorldCommand(UUID.randomUUID().toString(), player.publicId, 0, "start_journey", "first_path")
            val departed = WorldRules.apply(WorldState(),travel,Instant.now()).first
            val savedWorld = departed.copy(resources = WorldResources(120, 27, 13), houseLevel = 3,
                workshop = true, workshopLevel = 2, inventory = listOf("moss", "amber_scarf", "willow_rod"),
                equipment = WorldEquipment(neck = "amber_scarf", rod = "willow_rod"), collection = listOf("acorn"),
                completedJourneys = 7, hiddenGifts = listOf("flower"))
            seedLegacyWorld(source,player.id,savedWorld,8,travel)
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
            val unchangedTables = tables.filterNot { it == "world_profiles" }
            val before = legacyData(source, unchangedTables)
            val historySql = "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=28"
            val oldHistory = scalar(source, historySql)

            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, unchangedTables), "Only the explicitly converted world profile may change")
            assertEquals("true", scalar(source, "SELECT bool_and(reward_eligible)::text FROM game_achievements"), "Existing ownership keeps its finite reward eligibility")
            assertEquals(oldHistory, scalar(source, historySql), "Existing migration records/checksums must stay intact")
            assertEquals("61", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM player_feedback"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM player_feedback_actions"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory_receipts"))
            assertEquals("true", scalar(source, """SELECT (count(*)=1 AND bool_and(m.singleton AND m.started_at=h.installed_on::timestamptz))::text
                FROM game_tap_collection_metadata m JOIN flyway_schema_history h ON h.version='28' AND h.success"""))
            val upgradedHistory = scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(before, legacyData(source, unchangedTables), "Repeated startup must not reapply economy effects")
            assertEquals(upgradedHistory, scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h"))

            assertEquals(player.publicId, JdbcZhivRepository(source).findBySession(token.hash)?.publicId)
            assertEquals(12345L, JdbcGameRepository(source).progress(token.hash).lifetimeTaps)
            val restored = JdbcWorldRepository(source).snapshot(token.hash)
            assertEquals(9L, restored.revision)
            assertEquals(savedWorld.copy(resources=WorldResources()), restored.state)
            val economic=JdbcEconomyRepository(source).snapshot(token.hash)
            assertEquals(EconomyRules.legacyConversion(120,27,13).coinsGranted,economic.wallet.coins)
            assertEquals(mapOf("wood" to 5L,"stone" to 3L),economic.inventory)
            assertEquals(3,economic.buildings["home"])
            assertEquals(2,economic.buildings["workshop"])
            assertEquals("1",scalar(source,"SELECT count(*) FROM economy_conversion_audit WHERE user_id='${player.id}'"))
            assertEquals(listOf("flower"), restored.gifts)
            val replay = JdbcWorldRepository(source).command(token.hash, travel)
            assertTrue(replay.replayed, "A request acknowledged before deployment must remain idempotent")
            assertEquals(savedWorld.copy(resources=WorldResources()), replay.snapshot.state)
            assertEquals(9L, replay.snapshot.revision)
        }
    }

    @Test fun `V34 preserves overfull inventories old jobs and escrow and initializes storage only once`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("33").cleanDisabled(true).load().migrate()
            val tokens = TokenCodec()
            val token = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val player = identities.bootstrap("Хранитель склада", tokens.issue().hash, token.hash, 365)
            val oldJob = EconomyJob(UUID.randomUUID().toString(), "production", "workshop", "make_planks",
                startedAt = "2026-09-30T01:00:00Z", finishesAt = "2026-10-30T01:00:00Z",
                rewards = mapOf("planks" to 7L), cost = EconomyCost(3, mapOf("wood" to 9L)), catalogVersion = 1)
            val state = EconomyState(wallet = EconomyWallet(321, 0), inventory = mapOf("wood" to 600L, "planks" to 120L),
                buildings = mapOf("home" to 5, "garden" to 3, "woodlot" to 3, "quarry" to 2, "workshop" to 3, "dryer" to 2),
                jobs = listOf(oldJob), migration = EconomyMigration(coinsGranted = 321, woodGranted = 20, stoneGranted = 15), completedExplorations = 23)
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,19)", player.id, economyJson.encodeToString(state))
                c.economyUpdate("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?, 'berries',30,90)", UUID.randomUUID(), player.id)
                c.economyUpdate("INSERT INTO economy_conversion_audit(user_id,legacy_sparks,legacy_wood,legacy_stone,coins_granted,wood_granted,stone_granted) VALUES (?,10000,400,225,321,20,15)", player.id)
                c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins) VALUES (?,'conversion:v1','legacy_conversion',321)", player.id)
                c.commit()
            }
            val unchangedTables = listOf("economy_market_listings", "economy_market_receipts", "economy_conversion_audit", "economy_ledger", "economy_commands")
            val before = legacyData(source, unchangedTables)
            // This assertion isolates V34; V35 separately tests its new ledger column.
            val warehouseMigration = Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("34").load()
            warehouseMigration.migrate()
            val expected = state.copy(buildings = state.buildings + ("warehouse" to 1) + ("kiln" to 0))
            source.connection.use { c ->
                val row = readEconomyProfile(c, player.id)
                assertEquals(20L, row.revision)
                assertEquals(EconomyItemUnlocks.persist(expected, setOf("berries")).copy(wardrobe = expected.wardrobe.sorted()), row.state)
                assertEquals(expected, c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?", player.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(), "V34 changes only storage buildings")
            }
            // Isolate V34 with its own rows; the latest repository requires V39 barter tables.
            val preserved = source.connection.use { readEconomyProfile(it, player.id) }
            assertEquals(EconomyStorage(50, 720, 30, 0, 700), EconomyRules.storage(preserved.state, mapOf("berries" to 30L)))
            assertEquals(listOf(oldJob), preserved.state.jobs)
            assertEquals(before, legacyData(source, unchangedTables))
            warehouseMigration.migrate()
            assertEquals(20L, source.connection.use { readEconomyProfile(it, player.id).revision })
            assertEquals(before, legacyData(source, unchangedTables))
            // The new wrapper preserves the original conversion and adds no second grant.
            val legacy = WorldState(resources = WorldResources(100, 81, 49), houseLevel = 4, workshop = true, workshopLevel = 2)
            source.connection.use { c ->
                val initialized = c.economyRows("SELECT economy_v2_initial_state(?::jsonb)", worldJson.encodeToString(legacy)) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1))
                }.single()
                val expected = EconomyRules.initial(100, 81, 49, 4, 2, includeStartingPack = false)
                assertEquals(expected.copy(itemUnlockVersion = 0, buildings = expected.buildings - setOf("bridge", "lighthouse")),
                    EconomyMoney.redenominate(initialized), "Historical initializers predate the permanent-knowledge marker")
            }
            DatabaseFactory.migrate(source)
            assertEquals("0", scalar(source, "SELECT count(*) FROM app_users WHERE security_signal_at IS NOT NULL"), "V60 must not invent security flags for existing accounts")
            assertEquals(23L, source.connection.use { readEconomyProfile(it, player.id).revision }, "V40 and V41 convert once; V55 fences inherited knowledge once")
            val economy = JdbcEconomyRepository(source)
            val upgraded = economy.snapshot(token.hash)
            assertEquals(EconomyStorage(50, 720, 30, 0, 700), upgraded.storage)
            assertEquals(listOf(oldJob.copy(cost = oldJob.cost.copy(coins = 30))), upgraded.jobs)
            assertEquals(24L, upgraded.revision, "The first current read initializes the merchant stock once")
            assertEquals(upgraded.revision, economy.snapshot(token.hash).revision)
        }
    }

}
