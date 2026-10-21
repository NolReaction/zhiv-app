package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.notifications.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.Base64
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcNotificationMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()

    private fun scalar(source: DataSource, sql: String, vararg values: Any?): String = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }

    @Test fun `V50 materializes actionable garden jobs without reviving terminal sources or changing paid jobs and preferences`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("49").load().migrate()
            val codec = TokenCodec(); val token = codec.issue()
            val user = JdbcZhivRepository(source).bootstrap("Существующий урожай", codec.issue().hash, token.hash, 365)
            JdbcEconomyRepository(source).snapshot(token.hash)
            val notifications = JdbcNotificationRepository(source, WebPushConfig("test-public", "test-private", "mailto:test@example.test"))
            val preferences = NotificationPreferences(quietHoursEnabled = false, rateLimitsEnabled = false)
            notifications.preferences(token.hash, user.publicId, preferences)
            val encoder = Base64.getUrlEncoder().withoutPadding()
            notifications.subscribe(token.hash, user.publicId, BrowserPushSubscription(
                "https://fcm.googleapis.com/fcm/send/migration-${UUID.randomUUID()}",
                PushKeys(encoder.encodeToString(ByteArray(65).also { it[0] = 4 }), encoder.encodeToString(ByteArray(16))),
            ))
            val now = Instant.now()
            fun job(id: String, target: String = "garden", rewards: Map<String, Long> = mapOf("berries" to 20)) = EconomyJob(
                id, "production", target, startedAt = now.minusSeconds(600).toString(), finishesAt = now.minusSeconds(1).toString(), rewards = rewards,
            )
            val ripe = job("ripe").copy(collection = EconomyCollection("berry_harvest", 8, null, null))
            val fiber = job("fiber", rewards = mapOf("fiber" to 7)).copy(recipeId = "garden_fiber")
            val completed = job("delivered").copy(collection = EconomyCollection("berry_harvest", 8,
                now.minusSeconds(20).toString(), now.minusSeconds(12).toString()))
            val deferred = job("deferred", "workshop", mapOf("planks" to 11))
            source.connection.use { c ->
                val state = readEconomyProfile(c, user.id).state.copy(jobs = listOf(ripe, fiber, completed, deferred))
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), user.id)
                c.economyUpdate("UPDATE notification_events SET state='delivered',attempts=1 WHERE user_id=? AND source_key='job:delivered'", user.id)
                c.economyUpdate("UPDATE notification_events SET next_attempt_at=? WHERE user_id=? AND source_key='job:deferred'", now.plusSeconds(3600).notificationSqlTime(), user.id)
                c.commit()
            }
            assertEquals("0", scalar(source, "SELECT count(*) FROM notification_events WHERE user_id=? AND source_key IN ('job:ripe','job:fiber')", user.id))
            val profileBefore = scalar(source, "SELECT (state-'marketSlots'-'unlockedItems'-'itemUnlockVersion')::text FROM economy_profiles WHERE user_id=?", user.id)
            val preferencesBefore = scalar(source, "SELECT to_jsonb(p)::text FROM notification_preferences p WHERE user_id=?", user.id)
            val subscriptionBefore = scalar(source, "SELECT to_jsonb(s)::text FROM notification_subscriptions s WHERE user_id=?", user.id)
            val deferredBefore = scalar(source, "SELECT (to_jsonb(e)-'harvest_ready_at'-'waiting_for_actor'-'actor_wait_until')::text FROM notification_events e WHERE user_id=? AND source_key='job:deferred'", user.id)
            val terminalBefore = scalar(source, "SELECT (to_jsonb(e)-'harvest_ready_at'-'waiting_for_actor'-'actor_wait_until')::text FROM notification_events e WHERE user_id=? AND source_key='job:delivered'", user.id)

            DatabaseFactory.migrate(source)
            assertEquals(profileBefore, scalar(source, "SELECT (state-'marketSlots'-'unlockedItems'-'itemUnlockVersion')::text FROM economy_profiles WHERE user_id=?", user.id))
            assertEquals(preferencesBefore, scalar(source, "SELECT to_jsonb(p)::text FROM notification_preferences p WHERE user_id=?", user.id))
            assertEquals(subscriptionBefore, scalar(source, "SELECT to_jsonb(s)::text FROM notification_subscriptions s WHERE user_id=?", user.id))
            assertEquals(deferredBefore, scalar(source, "SELECT (to_jsonb(e)-'harvest_ready_at'-'waiting_for_actor'-'actor_wait_until')::text FROM notification_events e WHERE user_id=? AND source_key='job:deferred'", user.id))
            assertEquals(terminalBefore, scalar(source, "SELECT (to_jsonb(e)-'harvest_ready_at'-'waiting_for_actor'-'actor_wait_until')::text FROM notification_events e WHERE user_id=? AND source_key='job:delivered'", user.id))
            assertEquals("2", scalar(source, "SELECT count(*) FROM notification_events WHERE user_id=? AND source_key IN ('job:ripe','job:fiber') AND state='pending' AND attempts=0", user.id))
            DatabaseFactory.migrate(source)
            assertEquals("4", scalar(source, "SELECT count(*) FROM notification_events WHERE user_id=?", user.id))

            // The old completed harvest still owns the collector until claim,
            // but plain fiber is newly discoverable without opening the game.
            val sent = mutableListOf<PushPayload>()
            NotificationDispatcher(source, PushSender { _, payload -> sent.add(payload); PushResult.DELIVERED }, { now }).tick()
            assertEquals(1, sent.size); assertContains(sent.single().body, "7 пучков волокна")
            assertFalse(sent.single().body.contains("20 ягод"))
            assertEquals(terminalBefore, scalar(source, "SELECT (to_jsonb(e)-'harvest_ready_at'-'waiting_for_actor'-'actor_wait_until')::text FROM notification_events e WHERE user_id=? AND source_key='job:delivered'", user.id))
        }
    }
}
