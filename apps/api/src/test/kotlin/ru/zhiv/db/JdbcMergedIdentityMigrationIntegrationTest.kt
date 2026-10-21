package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.LoginFlow
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.EconomyRules
import ru.zhiv.economy.EconomyState
import ru.zhiv.economy.EconomyWallet
import ru.zhiv.economy.economyJson
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@Testcontainers(disabledWithoutDocker = true)
class JdbcMergedIdentityMigrationIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres=Postgres("postgres:18-alpine")

    @Test fun `V42 preserves old retirement digests and economy without guessing historical merge targets`(): Unit=runBlocking {
        val config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("41").load().migrate()
            val tokens=TokenCodec();val session=tokens.issue().hash
            val existing=JdbcZhivRepository(source).bootstrap("До обновления",tokens.issue().hash,session,365)
            val oldIdentity="history-${UUID.randomUUID()}@example.com"
            val saved=EconomyRules.initial().copy(wallet=EconomyWallet(1230,450),inventory=mapOf("wood" to 3L))
            val state=economyJson.encodeToString(saved)
            val before=source.connection.use { c ->
                c.economyUpdate("INSERT INTO account_identity_retirements(provider,subject_hash,retired_at) VALUES ('email',sha256(convert_to(?, 'UTF8')),'2020-01-01T00:00:00Z')",oldIdentity)
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,7)",existing.id,state)
                val row=c.economyRows("SELECT provider,encode(subject_hash,'hex'),retired_at FROM account_identity_retirements") {
                    Triple(it.getString(1),it.getString(2),it.getObject(3,OffsetDateTime::class.java)) }.single()
                c.commit();row
            }
            repeat(2) {
                Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("42").load().migrate()
            }
            source.connection.use { c ->
                assertEquals(before,c.economyRows("SELECT provider,encode(subject_hash,'hex'),retired_at FROM account_identity_retirements") {
                    Triple(it.getString(1),it.getString(2),it.getObject(3,OffsetDateTime::class.java)) }.single())
                assertNull(c.economyRows("SELECT merged_into_user_id FROM account_identity_retirements") { it.getObject(1,UUID::class.java) }.single())
                assertEquals(7L,readEconomyProfile(c,existing.id).revision)
                assertEquals(EconomyWallet(1230,450),readEconomyProfile(c,existing.id).state.wallet)
                assertEquals(mapOf("wood" to 3L),readEconomyProfile(c,existing.id).state.inventory)
                assertEquals(saved,c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?",existing.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(),"V42 leaves the complete saved economy unchanged")
            }
            DatabaseFactory.migrate(source);DatabaseFactory.migrate(source)
            assertTrue(Flyway.configure().dataSource(source).locations("classpath:db/migration").load().info().pending().isEmpty(),
                "Repeated startup must apply every available migration")
            source.connection.use { c ->
                assertEquals(before,c.economyRows("SELECT provider,encode(subject_hash,'hex'),retired_at FROM account_identity_retirements") {
                    Triple(it.getString(1),it.getString(2),it.getObject(3,OffsetDateTime::class.java)) }.single())
                assertNull(c.economyRows("SELECT merged_into_user_id FROM account_identity_retirements") { it.getObject(1,UUID::class.java) }.single())
                assertEquals(8L,readEconomyProfile(c,existing.id).revision,"V55 fences item knowledge once")
                assertEquals(saved.copy(unlockedItems=listOf("wood")),c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?",existing.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(),"The current upgrade adds only confirmed item knowledge")
            }
            val fresh=JdbcAuthRepository(source).finish(LoginFlow(tokens.issue().hash,tokens.issue().hash,"email","register",null,
                "Новый профиль",oldIdentity,null,null,null),oldIdentity,tokens.issue().hash,365,"Fresh")
            assertNotEquals(existing.id,fresh,"an old retirement without a known merge target is not retroactively bound")
        }
    }
}
