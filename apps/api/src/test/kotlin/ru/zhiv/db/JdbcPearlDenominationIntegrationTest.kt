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
import ru.zhiv.game.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

/** Exercise a populated V40 snapshot, including both earlier historical units. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcPearlDenominationIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    @Test fun `V41 changes only pearl units and projects old receipts without recrediting`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("40").load().migrate()
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Жемчуг", tokens.issue().hash, token.hash, 365)
            val state = EconomyRules.initial().copy(currencyScale = 10, pearlScale = null,
                wallet = EconomyWallet(1230, 10_000_000_000L), inventory = mapOf("wood" to 5L))
            val command = ProgressionRewardClaim(UUID.randomUUID().toString(), player.publicId, "achievement", "thousand_taps", 1)
            val gift = ProgressionRewardReceipt("achievement", ProgressionReward(pearls = 20),
                "2026-10-01T00:00:00Z", achievementId = "thousand_taps", level = 1)
            val signature = progressionRewardsJson.encodeToString(command)
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,7)", player.id, economyJson.encodeToString(state))
                c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,currency_scale) VALUES (?,'v39','sell',3,2,1),(?,'v40','sell',30,20,10)", player.id, player.id)
                c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'thousand_taps','2026-10-01T00:00:00Z')", player.id)
                c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'thousand_taps',1,20,'2026-10-01T00:00:00Z')", player.id)
                c.economyUpdate("""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,claim,accepted_revision,claimed_at)
                    VALUES (?,?,?,?,'achievement',?::jsonb,7,'2026-10-01T00:00:00Z')""", player.id, player.id, UUID.fromString(command.requestId),
                    signature, progressionRewardsJson.encodeToString(gift))
                c.commit()
            }
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            source.connection.use { c ->
                val current = readEconomyProfile(c, player.id)
                assertEquals(8L, current.revision)
                assertEquals(EconomyMoney.redenominate(state), current.state)
                assertEquals(EconomyWallet(1230, 50_000_000_000L), current.state.wallet)
                assertEquals(listOf(1 to 1, 10 to 10), c.economyRows("SELECT currency_scale,pearl_scale FROM economy_ledger WHERE user_id=? ORDER BY source_key", player.id) { it.getInt(1) to it.getInt(2) })
                assertEquals(listOf(100L, 100L), c.economyRows("SELECT pearls,pearl_scale FROM economy_ledger WHERE user_id=? ORDER BY source_key", player.id) { EconomyMoney.pearls(it.getLong(1), it.getInt(2)) })
                assertEquals(signature, c.economyRows("SELECT signature FROM game_reward_claims WHERE user_id=?", player.id) { it.getString(1) }.single())
                assertEquals(gift, c.economyRows("SELECT claim FROM game_reward_claims WHERE user_id=?", player.id) { progressionRewardsJson.decodeFromString<ProgressionRewardReceipt>(it.getString(1)) }.single())
                val fresh = c.economyRows("SELECT economy_v3_initial_state('{}'::jsonb)") { economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                assertEquals(10, fresh.currencyScale); assertEquals(50, fresh.pearlScale)
            }
            val rewards = JdbcProgressionRewardsRepository(source)
            val replay = rewards.claim(token.hash, command)
            assertTrue(replay.replayed); assertEquals(7L, replay.acceptedRevision)
            assertEquals(gift.copy(reward = gift.reward.copy(pearls = 100)), replay.claim)
            assertEquals(EconomyWallet(1230, 50_000_000_000L), replay.economy.wallet)
            assertEquals(replay.economy.wallet, rewards.claim(token.hash, command).economy.wallet)
        }
    }
}
