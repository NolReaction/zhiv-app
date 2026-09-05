
package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.recovery.CodeRecoveryRepository
import java.sql.Connection
import java.util.UUID
import javax.sql.DataSource

/** Raw recovery codes and retry secrets never cross this repository boundary. */
class JdbcCodeRecoveryRepository(private val source: DataSource) : CodeRecoveryRepository {
    private fun sessionUser(c: Connection, hash: ByteArray): UUID? =
        c.prepareStatement("""SELECT s.user_id FROM app_sessions s JOIN app_users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL""").use {
            it.setBytes(1, hash)
            it.executeQuery().use { r -> if (r.next()) r.getObject(1, UUID::class.java) else null }
        }

    private fun lockUser(c: Connection, id: UUID): Boolean =
        c.prepareStatement("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL FOR UPDATE").use {
            it.setObject(1,id); it.executeQuery().use { r -> r.next() }
        }

    private suspend fun <T> tx(block: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit=false
            try { val result=block(c); c.commit(); result }
            catch (failure: Throwable) { c.rollback(); throw failure }
        }
    }

    override suspend fun hasCode(sessionHash: ByteArray): Boolean? = tx { c ->
        val id=sessionUser(c,sessionHash) ?: return@tx null
        c.prepareStatement("SELECT 1 FROM account_recovery_codes WHERE user_id=? AND revoked_at IS NULL AND consumed_at IS NULL").use {
            it.setObject(1,id); it.executeQuery().use { r -> r.next() }
        }
    }

    override suspend fun activate(sessionHash: ByteArray, codeHash: ByteArray): Boolean = tx { c ->
        val id=sessionUser(c,sessionHash) ?: return@tx false
        if (!lockUser(c,id) || sessionUser(c,sessionHash)!=id) return@tx false
        val prior=c.prepareStatement("SELECT user_id, revoked_at IS NULL AND consumed_at IS NULL FROM account_recovery_codes WHERE code_hash=?").use {
            it.setBytes(1,codeHash); it.executeQuery().use { r ->
                if (r.next()) Pair(r.getObject(1,UUID::class.java),r.getBoolean(2)) else null
            }
        }
        if (prior!=null) return@tx prior.first==id && prior.second
        c.prepareStatement("UPDATE account_recovery_codes SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL AND consumed_at IS NULL").use {
            it.setObject(1,id); it.executeUpdate()
        }
        c.prepareStatement("INSERT INTO account_recovery_codes(code_hash,user_id) VALUES (?,?)").use {
            it.setBytes(1,codeHash); it.setObject(2,id); it.executeUpdate()
        }
        true
    }

    override suspend fun redeem(codeHash: ByteArray, retryHash: ByteArray, newSessionHash: ByteArray, sessionDays: Long): Boolean = tx { c ->
        val id=c.prepareStatement("SELECT user_id FROM account_recovery_codes WHERE code_hash=?").use {
            it.setBytes(1,codeHash); it.executeQuery().use { r -> if(r.next()) r.getObject(1,UUID::class.java) else null }
        } ?: return@tx false
        // Same lock order as all identity mutations: user, then session/code rows.
        if (!lockUser(c,id)) return@tx false
        val state=c.prepareStatement("""SELECT revoked_at IS NOT NULL, consumed_at IS NOT NULL FROM account_recovery_codes
            WHERE code_hash=? FOR UPDATE""").use {
            it.setBytes(1,codeHash); it.executeQuery().use { r -> check(r.next()); Pair(r.getBoolean(1),r.getBoolean(2)) }
        }
        if (state.first) return@tx false
        if (state.second) {
            // Lost HTTP response: retry only the SAME short-lived operation, never create another session.
            return@tx c.prepareStatement("""SELECT 1 FROM account_recovery_codes r JOIN app_sessions s ON s.id=r.recovery_session_id
                WHERE r.code_hash=? AND r.retry_hash=? AND r.consumed_at>clock_timestamp()-interval '10 minutes'
                AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()""").use {
                it.setBytes(1,codeHash); it.setBytes(2,retryHash); it.setBytes(3,newSessionHash)
                it.executeQuery().use { r -> r.next() }
            }
        }
        c.prepareStatement("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL").use {
            it.setObject(1,id); it.executeUpdate()
        }
        val sessionId=c.prepareStatement("""INSERT INTO app_sessions(user_id,token_hash,expires_at)
            VALUES (?,?,clock_timestamp()+ (? * interval '1 day')) RETURNING id""").use {
            it.setObject(1,id); it.setBytes(2,newSessionHash); it.setLong(3,sessionDays)
            it.executeQuery().use { r -> check(r.next()); r.getObject(1,UUID::class.java) }
        }
        c.prepareStatement("""UPDATE account_recovery_codes SET consumed_at=clock_timestamp(),recovery_session_id=?,retry_hash=?
            WHERE code_hash=?""").use {
            it.setObject(1,sessionId); it.setBytes(2,retryHash); it.setBytes(3,codeHash); check(it.executeUpdate()==1)
        }
        true
    }
}
