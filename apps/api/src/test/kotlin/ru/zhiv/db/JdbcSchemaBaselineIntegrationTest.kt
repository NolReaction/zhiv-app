package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.relationships.DirectRequestMutationSnapshot
import ru.zhiv.relationships.PeopleSnapshot
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.RequestAction
import ru.zhiv.security.TokenCodec
import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Compare the production bootstrap with the immutable historical migration chain. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcSchemaBaselineIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    private fun config(database: String? = null) = AppConfig(
        databaseUrl = database?.let { "jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$it" } ?: postgres.jdbcUrl,
        databaseUser = postgres.username,
        databasePassword = postgres.password,
        production = false,
        allowedOrigins = setOf("http://localhost"),
    )

    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.createStatement().use { statement -> statement.executeQuery(sql).use { row ->
            assertTrue(row.next()); row.getString(1)
        } }
    }

    private fun databaseTime(source: DataSource): OffsetDateTime = source.connection.use { c ->
        c.createStatement().use { statement -> statement.executeQuery("SELECT clock_timestamp()").use { row ->
            assertTrue(row.next()); row.getObject(1, OffsetDateTime::class.java)
        } }
    }

    private fun history(source: DataSource) = scalar(source,
        "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")

    private fun rows(source: DataSource, sql: String): Map<String, String> = source.connection.use { c ->
        c.createStatement().use { statement -> statement.executeQuery(sql).use { result ->
            buildMap { while (result.next()) put(result.getString(1), result.getString(2)) }
        } }
    }

    private fun tableData(source: DataSource): Map<String, String> {
        val tables = rows(source, """SELECT tablename, tablename FROM pg_tables
            WHERE schemaname='public' AND tablename<>'flyway_schema_history' ORDER BY tablename""")
        return tables.mapValues { (table, _) ->
            require(table.matches(Regex("[a-z_]+")))
            scalar(source, "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM public.\"$table\" t")
        }
    }

    private fun schema(source: DataSource): Map<String, Map<String, String>> = schemaQueries.mapValues { (category, sql) ->
        val definitions = rows(source, sql)
        when (category) {
            "constraints" -> definitions + canonicalChecks(source)
            "indexes" -> definitions + canonicalPartialIndexes(source)
            else -> definitions
        }
    }

    private fun canonicalExpression(c: Connection, table: String, expression: String): String {
        require(table.matches(Regex("[a-z_]+")))
        c.createStatement().use { it.execute("CREATE TEMP VIEW baseline_expression AS SELECT ($expression) AS satisfied FROM public.\"$table\"") }
        return try {
            c.createStatement().use { statement ->
                statement.executeQuery("SELECT pg_get_viewdef('pg_temp.baseline_expression'::regclass)").use { row ->
                    assertTrue(row.next()); row.getString(1)
                }
            }
        } finally {
            c.createStatement().use { it.execute("DROP VIEW pg_temp.baseline_expression") }
        }
    }

    private fun canonicalChecks(source: DataSource): Map<String, String> = source.connection.use { c ->
        // PostgreSQL can deparse a stored CHECK differently after pg_dump/reload
        // (notably varchar-array casts and nested ANDs). Parse both expressions
        // once in a temporary view; do not weaken or modify either real constraint.
        data class Check(val table: String, val name: String, val expression: String, val validated: Boolean)
        val checks = c.economyRows("""SELECT t.relname, con.conname, pg_get_expr(con.conbin,con.conrelid),con.convalidated
            FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE n.nspname='public' AND t.relname<>'flyway_schema_history' AND con.contype='c'""") {
            Check(it.getString(1), it.getString(2), it.getString(3), it.getBoolean(4))
        }
        checks.associate { check ->
            "${check.table}.${check.name}" to "${check.validated}:${canonicalExpression(c, check.table, check.expression)}"
        }
    }

    private fun canonicalPartialIndexes(source: DataSource): Map<String, String> = source.connection.use { c ->
        data class Index(val table: String, val name: String, val definition: String, val predicate: String)
        val indexes = c.economyRows("""SELECT t.relname,i.relname,pg_get_indexdef(x.indexrelid),pg_get_expr(x.indpred,x.indrelid)
            FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE n.nspname='public' AND t.relname<>'flyway_schema_history' AND x.indpred IS NOT NULL""") {
            Index(it.getString(1), it.getString(2), it.getString(3), it.getString(4))
        }
        indexes.associate { index ->
            // Keep index method, keys, order, uniqueness and INCLUDE exactly as emitted;
            // only its predicate needs the same parser round trip as CHECK expressions.
            assertTrue(index.definition.contains(" WHERE "))
            index.name to (index.definition.substringBefore(" WHERE ") + " WHERE " + canonicalExpression(c, index.table, index.predicate))
        }
    }

    @Test fun `fresh database executes baseline then V50 and V51 equivalent to the upgraded historical chain`() {
        DatabaseFactory.create(config()).use { legacy ->
            // Deliberately excludes the parent location: Flyway 12.8 applies the newest B
            // even when target is lower, so historical builds must resolve only V files.
            val historical = Flyway.configure().dataSource(legacy).locations("classpath:db/migration/history").load()
            historical.migrate()
            assertEquals("49", scalar(legacy, "SELECT count(*) FROM flyway_schema_history WHERE success AND type='SQL'"))
            assertEquals("49", scalar(legacy, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))
            assertEquals("0", scalar(legacy, "SELECT count(*) FROM flyway_schema_history WHERE type='SQL_BASELINE'"))
            DatabaseFactory.migrate(legacy)
            assertEquals("51", scalar(legacy, "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"))

            val database = "baseline_${UUID.randomUUID().toString().replace("-", "")}"
            legacy.connection.use { c ->
                c.autoCommit = true
                c.createStatement().use { it.executeUpdate("CREATE DATABASE $database") }
            }
            try {
                DatabaseFactory.create(config(database)).use { fresh ->
                    val started = databaseTime(fresh)
                    DatabaseFactory.migrate(fresh)
                    val finished = databaseTime(fresh)
                    assertEquals("3", scalar(fresh, "SELECT count(*) FROM flyway_schema_history"))
                    assertEquals("49:SQL_BASELINE:true", scalar(fresh,
                        "SELECT version || ':' || type || ':' || success::text FROM flyway_schema_history WHERE type='SQL_BASELINE'"))
                    val metadata = fresh.connection.use { c -> c.createStatement().use { statement ->
                        statement.executeQuery("SELECT started_at FROM game_tap_collection_metadata WHERE singleton").use { row ->
                            assertTrue(row.next())
                            row.getObject(1, OffsetDateTime::class.java).also { assertTrue(!row.next()) }
                        }
                    } }
                    assertTrue(!metadata.isBefore(started) && !metadata.isAfter(finished), "Fresh coverage begins during the baseline")
                    for ((table, data) in tableData(fresh).filterKeys { it != "game_tap_collection_metadata" })
                        assertEquals("[]", data, "The baseline must not seed player data into $table")

                    val expected = schema(legacy)
                    val actual = schema(fresh)
                    for ((category, definitions) in expected) {
                        assertEquals(definitions.keys, actual.getValue(category).keys, "$category object names differ")
                        for ((name, definition) in definitions)
                            assertEquals(definition, actual.getValue(category).getValue(name), "$category: $name differs from V1–V51")
                    }
                    val freshHistory = history(fresh)
                    val freshMetadata = scalar(fresh, "SELECT row_to_json(m)::text FROM game_tap_collection_metadata m")
                    DatabaseFactory.migrate(fresh)
                    assertEquals(freshHistory, history(fresh), "Repeated startup must not replay B49")
                    assertEquals(freshMetadata, scalar(fresh, "SELECT row_to_json(m)::text FROM game_tap_collection_metadata m"))
                    assertTrue(Flyway.configure().dataSource(fresh).locations("classpath:db/migration").load().info().pending().isEmpty())
                }
            } finally {
                legacy.connection.use { c ->
                    c.autoCommit = true
                    c.createStatement().use { it.executeUpdate("DROP DATABASE $database") }
                }
            }
            val legacyHistory = history(legacy)
            DatabaseFactory.migrate(legacy)
            assertEquals(legacyHistory, history(legacy), "A complete historical database must ignore B49")
        }
    }

    @Test fun `existing history upgrades without replacing accounts sessions or friends`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("48").load().migrate()
            val tokens = TokenCodec()
            val firstSession = tokens.issue().hash
            val secondSession = tokens.issue().hash
            val identities = JdbcZhivRepository(source)
            val first = identities.bootstrap("До baseline", tokens.issue().hash, firstSession, 365)
            val second = identities.bootstrap("Друг до baseline", tokens.issue().hash, secondSession, 365)
            val relationships = JdbcRelationshipRepository(source)
            val request = assertIs<RelationshipResult.Success<*>>(
                relationships.sendRequest(firstSession, second.publicId, UUID.randomUUID()),
            ).value as DirectRequestMutationSnapshot
            assertIs<RelationshipResult.Success<*>>(
                relationships.actOnRequest(secondSession, request.request.requestId, RequestAction.ACCEPTED),
            )
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email','baseline@example.test',?)", first.id)
                c.commit()
            }
            val data = tableData(source)
            val earlierHistory = history(source)
            DatabaseFactory.migrate(source)
            assertEquals(data, tableData(source), "Adding a baseline must not rewrite existing records")
            assertEquals(earlierHistory, scalar(source,
                "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=48"))
            assertEquals("51", scalar(source, "SELECT count(*) FROM flyway_schema_history WHERE success AND type='SQL'"))
            assertEquals("0", scalar(source, "SELECT count(*) FROM flyway_schema_history WHERE type='SQL_BASELINE'"))
            assertEquals(first.id, identities.findBySession(firstSession)?.id)
            assertEquals(second.id, identities.findBySession(secondSession)?.id)
            val people = assertIs<RelationshipResult.Success<*>>(relationships.listPeople(firstSession)).value as PeopleSnapshot
            assertEquals(second.publicId, people.people.single().user.publicId)
            val upgradedHistory = history(source)
            DatabaseFactory.migrate(source)
            assertEquals(upgradedHistory, history(source))
            assertEquals(data, tableData(source))
        }
    }

    companion object {
        // Compare logical definitions rather than generated OIDs, owners or dropped-column gaps.
        private val schemaQueries = linkedMapOf(
            "relations" to """SELECT c.relname, jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,
                'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,'options',c.reloptions)::text
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND c.relname<>'flyway_schema_history'""",
            "columns" to """SELECT c.relname || '.' || a.attname,
                jsonb_build_object('position',row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),
                    'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
                    'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
                    'collation',co.collname)::text
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
                LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
                LEFT JOIN pg_collation co ON co.oid=a.attcollation
                WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND c.relname<>'flyway_schema_history'
                    AND a.attnum>0 AND NOT a.attisdropped""",
            "constraints" to """SELECT c.relname || '.' || con.conname,
                jsonb_build_object('definition',pg_get_constraintdef(con.oid),'validated',con.convalidated)::text
                FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname<>'flyway_schema_history'""",
            "indexes" to """SELECT indexname, indexdef FROM pg_indexes
                WHERE schemaname='public' AND tablename<>'flyway_schema_history'""",
            "functions" to """SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
                FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.prokind IN ('f','p')""",
            "triggers" to """SELECT c.relname || '.' || t.tgname,
                jsonb_build_object('definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled)::text
                FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname<>'flyway_schema_history'""",
            "views" to """SELECT c.relname, pg_get_viewdef(c.oid)
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')""",
            "extensions" to "SELECT extname, extversion FROM pg_extension",
        )
    }
}
