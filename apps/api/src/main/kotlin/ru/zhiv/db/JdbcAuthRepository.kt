package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.auth.*
import ru.zhiv.identity.PublicIdGenerator
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

class JdbcAuthRepository(private val source: DataSource) : AuthRepository {
    private val publicIds = PublicIdGenerator()

    private suspend fun <T> tx(action: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit = false
            try { action(c).also { c.commit() } } catch (e: Exception) { c.rollback(); throw e }
        }
    }

    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, value -> s.setObject(i + 1, value) }; s.executeUpdate()
    }
    private fun <T> Connection.query(sql: String, vararg values: Any?, map: (ResultSet) -> T): T? = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, value -> s.setObject(i + 1, value) }
        s.executeQuery().use { if (it.next()) map(it) else null }
    }
    private fun lock(c: Connection, key: String) {
        val bytes = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
        c.query("SELECT pg_advisory_xact_lock(?)", ByteBuffer.wrap(bytes).long) { true }
    }
    private fun unauthorized(): Nothing = throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    private fun invalid(): Nothing = throw AuthFailure("AUTH_EXPIRED", "Код или запрос входа недействителен. Начните вход заново.")
    private fun sessionUser(c: Connection, hash: ByteArray): UUID? = c.query(
        "SELECT s.user_id FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL", hash,
    ) { it.getObject(1, UUID::class.java) }
    private fun lockSessionUser(c: Connection, hash: ByteArray): UUID {
        val id = sessionUser(c, hash) ?: unauthorized()
        c.query("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL FOR UPDATE", id) { true } ?: unauthorized()
        if (sessionUser(c, hash) != id) unauthorized()
        return id
    }

    override suspend fun create(flow: LoginFlow) = tx { c ->
        if (flow.intent == "link") lockSessionUser(c, flow.sessionHash ?: unauthorized())
        // This durable mailbox budget is shared by all API processes and IP addresses.
        if (flow.provider == "email") {
            lock(c, "email-send:${flow.subject}")
            val allowed = c.query("""
                SELECT count(*) FILTER (WHERE created_at > clock_timestamp()-interval '1 minute') = 0
                   AND count(*) < 5 AS allowed
                FROM account_login_flows WHERE provider='email' AND subject=?
                  AND created_at > clock_timestamp()-interval '1 hour'
            """.trimIndent(), flow.subject) { it.getBoolean(1) } ?: false
            if (!allowed) throw AuthFailure("AUTH_SEND_LIMIT", "Подождите перед отправкой нового кода. Не более пяти писем в час.", 429)
        }
        c.update("DELETE FROM account_login_flows WHERE token_hash IN (SELECT token_hash FROM account_login_flows WHERE created_at < clock_timestamp()-interval '1 day' LIMIT 100)")
        c.update("""
            INSERT INTO account_login_flows(token_hash,browser_hash,provider,intent,session_hash,display_name,subject,verifier,nonce,code_hash)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """.trimIndent(), flow.tokenHash, flow.browserHash, flow.provider, flow.intent, flow.sessionHash, flow.displayName, flow.subject, flow.verifier, flow.nonce, flow.codeHash)
        Unit
    }

    private fun readFlow(c: Connection, hash: ByteArray, browser: ByteArray, provider: String): LoginFlow {
        val flow = c.query("SELECT * FROM account_login_flows WHERE token_hash=? AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 FOR UPDATE", hash) { r ->
            LoginFlow(r.getBytes("token_hash"), r.getBytes("browser_hash"), r.getString("provider"), r.getString("intent"), r.getBytes("session_hash"), r.getString("display_name"), r.getString("subject"), r.getString("verifier"), r.getString("nonce"), r.getBytes("code_hash"))
        } ?: invalid()
        if (flow.provider != provider || !MessageDigest.isEqual(flow.browserHash, browser)) invalid()
        return flow
    }
    override suspend fun takeTelegram(tokenHash: ByteArray, browserHash: ByteArray): LoginFlow = tx { c ->
        readFlow(c, tokenHash, browserHash, "telegram").also {
            c.update("UPDATE account_login_flows SET consumed_at=clock_timestamp(),verifier=NULL,nonce=NULL WHERE token_hash=?", tokenHash)
        }
    }
    override suspend fun verifyEmail(tokenHash: ByteArray, browserHash: ByteArray, codeHash: ByteArray): LoginFlow {
        // A wrong code commits its attempt count; throwing inside the transaction would undo it.
        val flow = tx { c ->
            val candidate = readFlow(c, tokenHash, browserHash, "email")
            if (!MessageDigest.isEqual(candidate.codeHash, codeHash)) {
                c.update("UPDATE account_login_flows SET attempts=attempts+1 WHERE token_hash=?", tokenHash)
                null
            } else {
                c.update("UPDATE account_login_flows SET consumed_at=clock_timestamp(),code_hash=NULL WHERE token_hash=?", tokenHash)
                candidate
            }
        }
        return flow ?: throw AuthFailure("AUTH_CODE_INVALID", "Неверный код. Проверьте письмо и попробуйте ещё раз.")
    }

    override suspend fun finish(flow: LoginFlow, subject: String, newSessionHash: ByteArray, sessionDays: Long, label: String): UUID = tx { c ->
        // Serialize initial registrations and linking for this exact verified identity.
        lock(c, "identity:${flow.provider}:$subject")
        val owner = c.query("SELECT user_id FROM account_login_identities WHERE provider=? AND subject=?", flow.provider, subject) { it.getObject(1, UUID::class.java) }
        val userId = if (flow.intent == "link") {
            val current = lockSessionUser(c, flow.sessionHash ?: unauthorized())
            if (owner != null && owner != current) throw AuthFailure("AUTH_ALREADY_LINKED", "Этот способ входа уже связан с другим профилем", 409)
            current
        } else if (owner != null) {
            c.query("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL FOR UPDATE", owner) { true } ?: unauthorized()
            owner
        } else {
            if (flow.intent != "register") throw AuthFailure("AUTH_NOT_LINKED", "Этот способ входа пока не связан с профилем. Привяжите его в прежнем профиле или явно создайте новый.", 409)
            val name = loginDisplayName(flow.displayName) ?: throw AuthFailure("INVALID_DISPLAY_NAME", "Введите имя")
            var allocated: UUID? = null
            repeat(5) {
                if (allocated == null) allocated = c.query("INSERT INTO app_users(public_id,display_name) VALUES (?,?) ON CONFLICT (public_id) DO NOTHING RETURNING id", publicIds.next(), name) { it.getObject(1, UUID::class.java) }
            }
            allocated ?: error("Could not allocate public ID")
        }
        if (owner == null) {
            val inserted = c.update("INSERT INTO account_login_identities(provider,subject,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING", flow.provider, subject, userId)
            if (inserted != 1) throw AuthFailure("AUTH_ALREADY_LINKED", "В профиле уже привязан другой аккаунт этого сервиса", 409)
        }
        if (flow.intent != "link") {
            val count = c.query("SELECT count(*) FROM app_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp()", userId) { it.getInt(1) } ?: 0
            if (count >= 100) throw AuthFailure("AUTH_SESSION_LIMIT", "Закройте ненужные сеансы в разделе «Устройства»", 409)
            c.update("INSERT INTO app_sessions(user_id,token_hash,device_label,expires_at) VALUES (?,?,?,clock_timestamp()+(?*interval '1 day'))", userId, newSessionHash, label, sessionDays)
        }
        userId
    }

    override suspend fun access(sessionHash: ByteArray): AccountAccess = tx { c ->
        val user = lockSessionUser(c, sessionHash)
        c.update("UPDATE app_sessions SET last_seen_at=clock_timestamp() WHERE token_hash=?", sessionHash)
        val methods = c.prepareStatement("SELECT provider,subject FROM account_login_identities WHERE user_id=? ORDER BY provider").use { s ->
            s.setObject(1, user); s.executeQuery().use { r -> buildList {
                while (r.next()) {
                    val provider = r.getString(1); val subject = r.getString(2)
                    add(LoginMethod(provider, if (provider == "email") subject.take(1) + "•••@" + subject.substringAfter('@') else "Telegram"))
                }
            } }
        }
        val sessions = c.prepareStatement("SELECT * FROM app_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY last_seen_at DESC LIMIT 100").use { s ->
            s.setObject(1, user); s.executeQuery().use { r -> buildList {
                while (r.next()) add(LoginSession(r.getObject("id").toString(), r.getString("device_label") ?: "Браузер", r.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(), r.getObject("last_seen_at", OffsetDateTime::class.java).toInstant().toString(), MessageDigest.isEqual(r.getBytes("token_hash"), sessionHash)))
            } }
        }
        AccountAccess(methods, sessions)
    }

    override suspend fun revoke(sessionHash: ByteArray, target: UUID?, others: Boolean) = tx { c ->
        val user = lockSessionUser(c, sessionHash)
        when {
            others -> c.update("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND token_hash<>? AND revoked_at IS NULL", user, sessionHash)
            target != null -> {
                val changed = c.update("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND id=? AND revoked_at IS NULL", user, target)
                if (changed == 0) throw AuthFailure("SESSION_NOT_FOUND", "Сеанс не найден", 404)
            }
            else -> c.update("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND token_hash=? AND revoked_at IS NULL", user, sessionHash)
        }
        Unit
    }
}
