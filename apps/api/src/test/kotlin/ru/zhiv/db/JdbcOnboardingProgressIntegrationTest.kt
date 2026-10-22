package ru.zhiv.db

import kotlinx.coroutines.*
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.onboarding.OnboardingDecision
import ru.zhiv.security.TokenCodec
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcOnboardingProgressIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    @Test fun `terminal decisions sync between sessions completion wins races and preferences cannot grant a reward`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val codec = TokenCodec(); val identities = JdbcZhivRepository(source)
            val a = codec.issue(); val b = codec.issue()
            val first = identities.bootstrap("Первый", codec.issue().hash, a.hash, 365)
            val second = identities.bootstrap("Второй", codec.issue().hash, b.hash, 365)
            val anotherDevice = codec.issue()
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')", first.id, anotherDevice.hash)
                c.commit()
            }
            val repository = JdbcOnboardingRepository(source)
            assertNull(repository.read(a.hash, first.publicId).world)
            coroutineScope {
                listOf("completed", "skipped", "completed", "skipped").map { status -> async {
                    repository.save(a.hash, OnboardingDecision(first.publicId, "world", status))
                } }.awaitAll()
            }
            assertEquals("completed", repository.read(a.hash, first.publicId).world)
            assertEquals("completed", repository.read(anotherDevice.hash, first.publicId).world)
            assertEquals("completed", repository.save(anotherDevice.hash, OnboardingDecision(first.publicId, "world", "skipped")).world)
            assertNull(repository.read(a.hash, first.publicId).app)
            assertNull(repository.read(b.hash, second.publicId).world)
            assertEquals("ONBOARDING_OWNER_CHANGED", assertFailsWith<AuthFailure> {
                repository.save(b.hash, OnboardingDecision(first.publicId, "app", "completed"))
            }.code)
            source.connection.use { c ->
                assertEquals(0L, c.economyRows("SELECT count(*) FROM game_reward_claims WHERE user_id=?", first.id) { it.getLong(1) }.single())
                // Account merge is monotonic and keeps the target's completed choice.
                repository.save(b.hash, OnboardingDecision(second.publicId, "app", "skipped"))
                mergeOnboardingProgress(c, first.id, second.id)
                c.commit()
            }
            assertEquals("skipped", repository.read(a.hash, first.publicId).app)
            assertEquals("completed", repository.read(a.hash, first.publicId).world)
        }
    }

    @Test fun `V69 backfills paid legacy courses but never invents completion or reward for a fresh account`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("68").load().migrate()
            val codec = TokenCodec(); val identities = JdbcZhivRepository(source)
            val paidToken = codec.issue(); val freshToken = codec.issue()
            val paid = identities.bootstrap("Прошёл", codec.issue().hash, paidToken.hash, 365)
            val fresh = identities.bootstrap("Новый", codec.issue().hash, freshToken.hash, 365)
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO game_daily_rewards(user_id,onboarding_claimed_at) VALUES (?,clock_timestamp())", paid.id)
                c.commit()
            }
            DatabaseFactory.migrate(source)
            val repository = JdbcOnboardingRepository(source)
            assertEquals("completed", repository.read(paidToken.hash, paid.publicId).world)
            assertEquals("completed", repository.read(paidToken.hash, paid.publicId).app)
            assertNull(repository.read(freshToken.hash, fresh.publicId).world)
            source.connection.use { c ->
                assertEquals(2L, c.economyRows("SELECT count(*) FROM onboarding_progress WHERE user_id=?", paid.id) { it.getLong(1) }.single())
                assertEquals(0L, c.economyRows("SELECT count(*) FROM onboarding_progress WHERE user_id=?", fresh.id) { it.getLong(1) }.single())
            }
        }
    }
}
