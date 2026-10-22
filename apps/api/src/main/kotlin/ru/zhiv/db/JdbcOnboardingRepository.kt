package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parsePublicId
import ru.zhiv.onboarding.*
import java.sql.Connection
import java.util.UUID
import javax.sql.DataSource

internal fun mergeOnboardingProgress(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""
        INSERT INTO onboarding_progress(user_id,course,status,updated_at)
        SELECT ?,course,status,updated_at FROM onboarding_progress WHERE user_id=?
        ON CONFLICT(user_id,course) DO UPDATE SET
            status=CASE WHEN onboarding_progress.status='completed' OR EXCLUDED.status='completed' THEN 'completed' ELSE 'skipped' END,
            updated_at=GREATEST(onboarding_progress.updated_at,EXCLUDED.updated_at)
    """.trimIndent(), target, source)
}

class JdbcOnboardingRepository(private val source: DataSource) : OnboardingRepository {
    private fun actor(c: Connection, hash: ByteArray): Pair<UUID, String> = c.economyRows("""
        SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """.trimIndent(), hash) { it.getObject(1, UUID::class.java) to it.getString(2) }.firstOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private suspend fun transaction(hash: ByteArray, owner: String, decision: OnboardingDecision? = null): OnboardingView = withContext(Dispatchers.IO) {
        if (parsePublicId(owner) != owner) invalidOnboarding()
        source.connection.use { c ->
            c.autoCommit = false
            try {
                val before = actor(c, hash)
                c.economyUpdate("SET LOCAL lock_timeout = '5s'")
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", before.first) { true }
                val current = actor(c, hash)
                if (before != current || current.second != owner) throw AuthFailure("ONBOARDING_OWNER_CHANGED", "Аккаунт изменился", 409)
                if (decision != null) c.economyUpdate("""
                    INSERT INTO onboarding_progress(user_id,course,status) VALUES (?,?,?)
                    ON CONFLICT(user_id,course) DO UPDATE SET status='completed', updated_at=clock_timestamp()
                    WHERE onboarding_progress.status='skipped' AND EXCLUDED.status='completed'
                """.trimIndent(), current.first, decision.course, decision.status)
                val states = c.economyRows("SELECT course,status FROM onboarding_progress WHERE user_id=?", current.first) { it.getString(1) to it.getString(2) }.toMap()
                // Old clients can still claim the existing reward after migration.
                val paid = c.economyRows("SELECT onboarding_claimed_at IS NOT NULL FROM game_daily_rewards WHERE user_id=?", current.first) { it.getBoolean(1) }.firstOrNull() == true
                val view = OnboardingView(owner, if (paid) "completed" else states["app"], if (paid) "completed" else states["world"])
                c.commit()
                view
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }
    override suspend fun read(hash: ByteArray, owner: String) = transaction(hash, owner)
    override suspend fun save(hash: ByteArray, decision: OnboardingDecision): OnboardingView {
        validateOnboarding(decision)
        return transaction(hash, decision.ownerPublicId, decision)
    }
}
