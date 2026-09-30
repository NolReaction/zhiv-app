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
        scalar(source, "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM public.\"$table\" t")
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

    @Test fun `upgrade from populated V30 preserves accounts and feedback while initializing the new economy`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("30").cleanDisabled(true).load().migrate()
            val tokens = TokenCodec(); val token = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val player = identities.bootstrap("До памяти", tokens.issue().hash, token.hash, 365)
            identities.record(token.hash, UUID.randomUUID())
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
            assertEquals(before, legacyData(source, unchangedTables))
            assertEquals(beforeHistory, scalar(source, historySql))
            assertEquals("34", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory_receipts"))
            DatabaseFactory.migrate(source)
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
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("28").cleanDisabled(true).load().migrate()
            val token = TokenCodec().issue()
            val identity = JdbcZhivRepository(source)
            val player = identity.bootstrap("До обновления", TokenCodec().issue().hash, token.hash, 365)
            identity.record(token.hash, UUID.randomUUID())
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
            assertEquals(before, legacyData(source, unchangedTables), "Only the explicitly converted world profile may change")
            assertEquals(oldHistory, scalar(source, historySql), "Existing migration records/checksums must stay intact")
            assertEquals("34", scalar(source, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM player_feedback"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM player_feedback_actions"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM forest_memory_receipts"))
            assertEquals("true", scalar(source, """SELECT (count(*)=1 AND bool_and(m.singleton AND m.started_at=h.installed_on::timestamptz))::text
                FROM game_tap_collection_metadata m JOIN flyway_schema_history h ON h.version='28' AND h.success"""))
            val upgradedHistory = scalar(source, "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
            DatabaseFactory.migrate(source)
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
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("33").cleanDisabled(true).load().migrate()
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
            DatabaseFactory.migrate(source)
            val expected = state.copy(buildings = state.buildings + ("warehouse" to 1) + ("kiln" to 0))
            source.connection.use { c ->
                val row = readEconomyProfile(c, player.id)
                assertEquals(20L, row.revision)
                assertEquals(expected, row.state)
            }
            val view = JdbcEconomyRepository(source).snapshot(token.hash)
            assertEquals(EconomyStorage(200, 720, 30, 0, 550), view.storage)
            assertEquals(listOf(oldJob), view.jobs)
            assertEquals(before, legacyData(source, unchangedTables))
            DatabaseFactory.migrate(source)
            assertEquals(20L, JdbcEconomyRepository(source).snapshot(token.hash).revision)
            assertEquals(before, legacyData(source, unchangedTables))
            // The new wrapper preserves the original conversion and adds no second grant.
            val legacy = WorldState(resources = WorldResources(100, 81, 49), houseLevel = 4, workshop = true, workshopLevel = 2)
            source.connection.use { c ->
                val initialized = c.economyRows("SELECT economy_v2_initial_state(?::jsonb)", worldJson.encodeToString(legacy)) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1))
                }.single()
                assertEquals(EconomyRules.initial(100, 81, 49, 4, 2), initialized)
            }
        }
    }

}
