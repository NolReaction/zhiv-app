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
    private val accounts = JdbcAccountLifecycleRepository(source)
    override suspend fun recordAccountProof(flow: LoginFlow, subject: String) = accounts.recordAccountProof(flow, subject)
    override suspend fun lifecycle(sessionHash: ByteArray, browserHash: ByteArray) = accounts.lifecycle(sessionHash, browserHash)
    override suspend fun changeEmail(sessionHash: ByteArray, browserHash: ByteArray, requestHash: ByteArray) = accounts.changeEmail(sessionHash, browserHash, requestHash)
    override suspend fun previewMerge(sessionHash: ByteArray, browserHash: ByteArray, choices: MergeChoices, previewHash: ByteArray) = accounts.previewMerge(sessionHash, browserHash, choices, previewHash)
    override suspend fun confirmMerge(sessionHash: ByteArray, browserHash: ByteArray, previewHash: ByteArray) = accounts.confirmMerge(sessionHash, browserHash, previewHash)
    override suspend fun deleteAccount(sessionHash: ByteArray, browserHash: ByteArray, requestHash: ByteArray) = accounts.deleteAccount(sessionHash, browserHash, requestHash)

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
        if (flow.intent in setOf("link", "account")) lockSessionUser(c, flow.sessionHash ?: unauthorized())
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
            INSERT INTO account_login_flows(token_hash,browser_hash,provider,intent,session_hash,display_name,subject,verifier,nonce,code_hash,account_action,account_role)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """.trimIndent(), flow.tokenHash, flow.browserHash, flow.provider, flow.intent, flow.sessionHash, flow.displayName, flow.subject, flow.verifier, flow.nonce, flow.codeHash, flow.action, flow.role)
        Unit
    }

    private fun readFlow(c: Connection, hash: ByteArray, browser: ByteArray, provider: String): LoginFlow {
        val flow = c.query("SELECT * FROM account_login_flows WHERE token_hash=? AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 FOR UPDATE", hash) { r ->
            LoginFlow(r.getBytes("token_hash"), r.getBytes("browser_hash"), r.getString("provider"), r.getString("intent"), r.getBytes("session_hash"), r.getString("display_name"), r.getString("subject"), r.getString("verifier"), r.getString("nonce"), r.getBytes("code_hash"), r.getString("account_action"), r.getString("account_role"))
        } ?: invalid()
        if (flow.provider != provider || !MessageDigest.isEqual(flow.browserHash, browser)) invalid()
        return flow
    }
    override suspend fun takeTelegram(tokenHash: ByteArray, browserHash: ByteArray): LoginFlow = tx { c ->
        readFlow(c, tokenHash, browserHash, "telegram").also {
            c.update("UPDATE account_login_flows SET consumed_at=clock_timestamp(),verifier=NULL,nonce=NULL WHERE token_hash=?", tokenHash)
        }
    }
    override suspend fun takeVk(tokenHash: ByteArray, browserHash: ByteArray): LoginFlow = tx { c ->
        val consumedBrowser = c.query(
            "SELECT browser_hash FROM account_login_flows WHERE token_hash=? AND provider='vk' AND consumed_at IS NOT NULL",
            tokenHash,
        ) { it.getBytes("browser_hash") }
        if (consumedBrowser != null && MessageDigest.isEqual(consumedBrowser, browserHash)) {
            throw ConsumedVkFlow()
        }
        readFlow(c, tokenHash, browserHash, "vk").also {
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
        finishInTransaction(c, flow, subject, newSessionHash, sessionDays, label)
    }

    override suspend fun prepareRegistration(flow: LoginFlow, subject: String, ticketHash: ByteArray) = tx { c ->
        require(flow.intent == "login")
        lock(c,"identity:${flow.provider}:$subject")
        val owner=c.query("SELECT user_id FROM account_login_identities WHERE provider=? AND subject=?",flow.provider,subject){it.getObject(1,UUID::class.java)}
        if(owner!=null)c.query("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL FOR UPDATE",owner){true} ?: invalid()
        // Converting a verified login into a signup ticket must not reset proof age or jump over
        // a retirement that happened after the initial AUTH_NOT_LINKED result.
        val times=c.query("SELECT created_at,expires_at FROM account_login_flows WHERE token_hash=?",flow.tokenHash){it.getObject(1,OffsetDateTime::class.java) to it.getObject(2,OffsetDateTime::class.java)}
            ?: c.query("SELECT clock_timestamp(),clock_timestamp()+interval '10 minutes'"){it.getObject(1,OffsetDateTime::class.java) to it.getObject(2,OffsetDateTime::class.java)}!!
        if(c.query("SELECT ?::timestamptz>clock_timestamp()",times.second){it.getBoolean(1)}!=true)invalid()
        if(c.query("SELECT 1 FROM account_identity_retirements WHERE provider=? AND subject_hash=sha256(convert_to(?, 'UTF8')) AND retired_at>=?",flow.provider,subject,times.first){true}==true)invalid()
        c.update("DELETE FROM account_registration_tickets WHERE token_hash IN (SELECT token_hash FROM account_registration_tickets WHERE expires_at<clock_timestamp() LIMIT 100)")
        c.update("INSERT INTO account_registration_tickets(token_hash,browser_hash,provider,subject,created_at,expires_at) VALUES (?,?,?,?,?,?)", ticketHash, flow.browserHash, flow.provider, subject,times.first,times.second)
        Unit
    }

    override suspend fun hasRegistration(ticketHash: ByteArray, browserHash: ByteArray): Boolean = tx { c ->
        c.query("SELECT browser_hash FROM account_registration_tickets WHERE token_hash=? AND consumed_at IS NULL AND expires_at>clock_timestamp()", ticketHash) {
            MessageDigest.isEqual(it.getBytes(1), browserHash)
        } ?: false
    }

    override suspend fun completeRegistration(ticketHash: ByteArray, browserHash: ByteArray, displayName: String, newSessionHash: ByteArray, sessionDays: Long, label: String, timeZone: String): UUID = tx { c ->
        if (!c.acceptsTimeZone(timeZone)) throw AuthFailure("INVALID_TIME_ZONE", "Выберите часовой пояс из списка")
        val name = loginDisplayName(displayName) ?: throw AuthFailure("INVALID_DISPLAY_NAME", "Введите имя длиной до 50 символов")
        val pending = c.query("SELECT * FROM account_registration_tickets WHERE token_hash=? AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE", ticketHash) { r ->
            LoginFlow(ticketHash, r.getBytes("browser_hash"), r.getString("provider"), "register", null, name, r.getString("subject"), null, null, null)
        } ?: invalid()
        if (!MessageDigest.isEqual(pending.browserHash, browserHash)) invalid()
        // Identity lookup, optional creation, session and ticket consumption commit together.
        val user = finishInTransaction(c, pending, requireNotNull(pending.subject), newSessionHash, sessionDays, label, timeZone)
        c.update("UPDATE account_registration_tickets SET consumed_at=clock_timestamp() WHERE token_hash=?", ticketHash)
        user
    }

    private fun finishInTransaction(c: Connection, flow: LoginFlow, subject: String, newSessionHash: ByteArray, sessionDays: Long, label: String, registrationTimeZone: String = "Europe/Moscow"): UUID {
        if (flow.intent == "account") throw AuthFailure("INVALID_REQUEST", "Подтверждение требует отдельной операции")
        // Serialize initial registrations and linking for this exact verified identity.
        lock(c, "identity:${flow.provider}:$subject")
        fun requireUnchangedIdentity() {
            if (c.query("SELECT 1 FROM account_identity_retirements r WHERE provider=? AND subject_hash=sha256(convert_to(?, 'UTF8')) AND retired_at >= COALESCE((SELECT created_at FROM account_login_flows WHERE token_hash=?), (SELECT created_at FROM account_registration_tickets WHERE token_hash=?), clock_timestamp())", flow.provider, subject, flow.tokenHash, flow.tokenHash) { true } == true) invalid()
        }
        requireUnchangedIdentity()
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
                if (allocated == null) allocated = c.query("INSERT INTO app_users(public_id,display_name,timezone_id) VALUES (?,?,?) ON CONFLICT (public_id) DO NOTHING RETURNING id", publicIds.next(), name, registrationTimeZone) { it.getObject(1, UUID::class.java) }
            }
            allocated ?: error("Could not allocate public ID")
        }
        // A lifecycle transaction may have retired or moved this exact identity while this
        // login waited for its owner's row lock. Never mint access from the pre-lock lookup.
        requireUnchangedIdentity()
        val freshOwner=c.query("SELECT user_id FROM account_login_identities WHERE provider=? AND subject=?",flow.provider,subject){it.getObject(1,UUID::class.java)}
        if(freshOwner != owner) invalid()
        if (owner == null) {
            val inserted = c.update("INSERT INTO account_login_identities(provider,subject,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING", flow.provider, subject, userId)
            if (inserted != 1) throw AuthFailure("AUTH_ALREADY_LINKED", "В профиле уже привязан другой аккаунт этого сервиса", 409)
        }
        if (flow.intent != "link") {
            val count = c.query("SELECT count(*) FROM app_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp()", userId) { it.getInt(1) } ?: 0
            if (count >= 100) throw AuthFailure("AUTH_SESSION_LIMIT", "Закройте ненужные сеансы в разделе «Устройства»", 409)
            c.update("INSERT INTO app_sessions(user_id,token_hash,device_label,expires_at) VALUES (?,?,?,clock_timestamp()+(?*interval '1 day'))", userId, newSessionHash, label, sessionDays)
        }
        c.update("UPDATE account_login_flows SET display_name=NULL WHERE token_hash=?",flow.tokenHash)
        return userId
    }

    override suspend fun access(sessionHash: ByteArray): AccountAccess = tx { c ->
        val user = lockSessionUser(c, sessionHash)
        c.update("UPDATE app_sessions SET last_seen_at=clock_timestamp() WHERE token_hash=?", sessionHash)
        val methods = c.prepareStatement("SELECT provider,subject FROM account_login_identities WHERE user_id=? ORDER BY provider").use { s ->
            s.setObject(1, user); s.executeQuery().use { r -> buildList {
                while (r.next()) {
                    val provider = r.getString(1); val subject = r.getString(2)
                    add(LoginMethod(provider, when (provider) { "email" -> subject.take(1) + "•••@" + subject.substringAfter('@'); "vk" -> "ВКонтакте"; else -> "Telegram" }))
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
