package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.auth.AuthFailure
import ru.zhiv.auth.MobileAuthRepository
import ru.zhiv.auth.MobileAuthorization
import ru.zhiv.auth.MobileSessionGrant
import java.security.MessageDigest
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

class JdbcMobileAuthRepository(private val source: DataSource) : MobileAuthRepository {
    private suspend fun <T> tx(action: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { connection ->
            connection.autoCommit = false
            try { action(connection).also { connection.commit() } }
            catch (error: Exception) { connection.rollback(); throw error }
        }
    }

    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeUpdate()
    }

    private fun <T> Connection.query(sql: String, vararg values: Any?, map: (ResultSet) -> T): T? = prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeQuery().use { if (it.next()) map(it) else null }
    }

    private fun invalid(): Nothing = throw AuthFailure("AUTH_EXPIRED", "Запрос подключения недействителен. Начните вход заново.")
    private fun unauthorized(): Nothing = throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private fun lockUser(connection: Connection, user: UUID) {
        connection.query("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL AND banned_at IS NULL FOR UPDATE", user) { true }
            ?: unauthorized()
    }

    override suspend fun authorize(browserSessionHash: ByteArray, authorization: MobileAuthorization): Unit = tx { c ->
        val user = c.query("SELECT user_id FROM app_sessions WHERE token_hash=?", browserSessionHash) { it.getObject(1, UUID::class.java) }
            ?: unauthorized()
        // The same user-row lock is used by logout, account deletion and session minting.
        lockUser(c, user)
        val session = c.query("SELECT id FROM app_sessions WHERE token_hash=? AND user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp()", browserSessionHash, user) {
            it.getObject(1, UUID::class.java)
        } ?: unauthorized()
        val recent = c.query("SELECT count(*) FROM mobile_authorization_codes WHERE source_session_id=? AND created_at>clock_timestamp()-interval '10 minutes'", session) { it.getInt(1) } ?: 0
        if (recent >= 20) throw AuthFailure("AUTH_SEND_LIMIT", "Слишком много подключений. Попробуйте позже.", 429)
        c.update("DELETE FROM mobile_authorization_codes WHERE code_hash IN (SELECT code_hash FROM mobile_authorization_codes WHERE expires_at<clock_timestamp()-interval '1 day' LIMIT 100)")
        val inserted = c.update("""
            INSERT INTO mobile_authorization_codes(code_hash,source_session_id,user_id,challenge,state_hash,platform)
            VALUES (?,?,?,?,?,?) ON CONFLICT (source_session_id,state_hash) DO NOTHING
        """.trimIndent(), authorization.codeHash, session, user, authorization.challenge, authorization.stateHash, authorization.platform)
        if (inserted != 1) invalid()
    }

    override suspend fun exchange(authorization: MobileAuthorization, newSessionHash: ByteArray, sessionDays: Long): MobileSessionGrant = tx { c ->
        val user = c.query("SELECT user_id FROM mobile_authorization_codes WHERE code_hash=?", authorization.codeHash) {
            it.getObject(1, UUID::class.java)
        } ?: invalid()
        lockUser(c, user)
        val proof = c.query("""
            SELECT a.challenge,a.state_hash,a.platform,a.source_session_id
            FROM mobile_authorization_codes a
            WHERE a.code_hash=? AND a.consumed_at IS NULL AND a.expires_at>clock_timestamp()
            FOR UPDATE
        """.trimIndent(), authorization.codeHash) { result ->
            Proof(result.getString(1), result.getBytes(2), result.getString(3), result.getObject(4, UUID::class.java))
        } ?: invalid()
        if (!MessageDigest.isEqual(proof.challenge.toByteArray(Charsets.US_ASCII), authorization.challenge.toByteArray(Charsets.US_ASCII)) ||
            !MessageDigest.isEqual(proof.stateHash, authorization.stateHash) || proof.platform != authorization.platform) invalid()
        c.query("SELECT id FROM app_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp()", proof.sourceSessionId, user) { true }
            ?: invalid()
        val sessions = c.query("SELECT count(*) FROM app_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp()", user) { it.getInt(1) } ?: 0
        if (sessions >= 100) throw AuthFailure("AUTH_SESSION_LIMIT", "Закройте ненужные сеансы в разделе «Устройства»", 409)
        val label = if (authorization.platform == "ios") "Мохлик · iOS" else "Мохлик · Android"
        val expires = c.query("""
            INSERT INTO app_sessions(user_id,token_hash,device_label,expires_at)
            VALUES (?,?,?,clock_timestamp()+(?*interval '1 day')) RETURNING expires_at
        """.trimIndent(), user, newSessionHash, label, sessionDays) { it.getObject(1, OffsetDateTime::class.java).toInstant().toString() }
            ?: error("Mobile session insert failed")
        c.update("UPDATE mobile_authorization_codes SET consumed_at=clock_timestamp() WHERE code_hash=?", authorization.codeHash)
        MobileSessionGrant(user, expires)
    }

    private data class Proof(val challenge: String, val stateHash: ByteArray, val platform: String, val sourceSessionId: UUID)
}
