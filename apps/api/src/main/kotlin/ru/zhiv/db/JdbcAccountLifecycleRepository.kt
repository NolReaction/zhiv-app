package ru.zhiv.db

import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import ru.zhiv.auth.*
import java.security.MessageDigest
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

/** Destructive account changes deliberately keep immutable event/audience rows under a retired ID.
 * No event actor, recipient, membership epoch, or circle endpoint is ever rewritten. */
class JdbcAccountLifecycleRepository(private val source: DataSource) : AccountLifecycleRepository {
    private val json = Json
    private fun fail(code: String, message: String, status: Int = 409): Nothing = throw AuthFailure(code, message, status)
    private fun proofRequired(): Nothing = fail("ACCOUNT_PROOF_REQUIRED", "Подтвердите доступ заново в этом браузере")
    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, v -> s.setObject(i + 1, v) }; s.executeUpdate()
    }
    private fun <T> Connection.rows(sql: String, vararg values: Any?, map: (ResultSet) -> T): List<T> = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, v -> s.setObject(i + 1, v) }; s.executeQuery().use { r -> buildList { while (r.next()) add(map(r)) } }
    }
    private fun <T> Connection.one(sql: String, vararg values: Any?, map: (ResultSet) -> T): T? = rows(sql, *values, map = map).firstOrNull()
    private class GraphChanged : RuntimeException()
    private suspend fun <T> tx(block: (Connection) -> T): T = withContext(Dispatchers.IO) {
        var result: T? = null
        for (attempt in 0..2) {
            try {
                source.connection.use { c ->
                    c.autoCommit = false
                    try { result = block(c); c.commit() } catch (e: Exception) { c.rollback(); throw e }
                }
                @Suppress("UNCHECKED_CAST") return@withContext result as T
            } catch (_: GraphChanged) {
                if (attempt == 2) fail("ACCOUNT_BUSY", "Состав связей меняется. Повторите проверку.")
            } catch (e: SQLException) {
                if (e.sqlState !in setOf("40P01", "40001", "55P03")) throw e
                if (attempt == 2) throw AuthFailure("ACCOUNT_BUSY", "Профиль меняется в другом сеансе. Повторите проверку.", 409, e)
            }
        }
        error("unreachable")
    }
    private fun receipt(c: Connection,action: String,key: ByteArray,session: ByteArray,browser: ByteArray): Boolean {
        // Serialize retries before user locks: equal request keys can never consume a newer proof.
        c.one("SELECT pg_advisory_xact_lock(?)", java.nio.ByteBuffer.wrap(key).long) { true }
        return c.one("SELECT action,session_hash,browser_hash,expires_at>clock_timestamp() FROM account_operation_receipts WHERE token_hash=?",key) {
            if(it.getString(1)!=action || !MessageDigest.isEqual(it.getBytes(2),session) || !MessageDigest.isEqual(it.getBytes(3),browser))
                fail("ACCOUNT_REQUEST_CONFLICT","Запрос уже использован в другом контексте")
            if(!it.getBoolean(4)) fail("ACCOUNT_REQUEST_CONFLICT","Срок повторного ответа истёк. Проверьте состояние профиля.")
            true
        } ?: false
    }
    private fun saveReceipt(c: Connection,action: String,key: ByteArray,id: UUID,session: ByteArray,browser: ByteArray) {
        c.update("INSERT INTO account_operation_receipts(token_hash,action,user_id,session_hash,browser_hash) VALUES (?,?,?,?,?)",key,action,id,session,browser)
    }
    private fun user(c: Connection, session: ByteArray): UUID = c.one("""
        SELECT u.id FROM app_sessions s JOIN app_users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL
    """.trimIndent(), session) { it.getObject(1, UUID::class.java) }
        ?: fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private fun graphUsers(c: Connection,id: UUID,extra: UUID?): List<UUID> = c.rows("""
        WITH roots AS (
            SELECT ?::uuid AS id UNION SELECT ?::uuid WHERE ?::uuid IS NOT NULL
            UNION SELECT proved_user_id FROM account_action_proofs
              WHERE user_id=? AND proved_user_id IS NOT NULL AND expires_at>clock_timestamp()
        ), related_circles AS (
            SELECT c.id FROM circles c WHERE c.created_by_user_id IN (SELECT id FROM roots)
              OR c.direct_user_low_id IN (SELECT id FROM roots) OR c.direct_user_high_id IN (SELECT id FROM roots)
              OR c.id IN (SELECT circle_id FROM circle_memberships WHERE user_id IN (SELECT id FROM roots))
        ), participants AS (
            SELECT id FROM roots
            UNION SELECT user_id FROM circle_memberships WHERE circle_id IN (SELECT id FROM related_circles) AND left_at IS NULL
            UNION SELECT created_by_user_id FROM circles WHERE id IN (SELECT id FROM related_circles)
            UNION SELECT direct_user_low_id FROM circles WHERE id IN (SELECT id FROM related_circles)
            UNION SELECT direct_user_high_id FROM circles WHERE id IN (SELECT id FROM related_circles)
            UNION SELECT requester_user_id FROM direct_requests WHERE status='PENDING' AND recipient_user_id IN (SELECT id FROM roots)
            UNION SELECT recipient_user_id FROM direct_requests WHERE status='PENDING' AND requester_user_id IN (SELECT id FROM roots)
            UNION SELECT inviter_user_id FROM circle_invites WHERE status='PENDING' AND (circle_id IN (SELECT id FROM related_circles) OR invitee_user_id IN (SELECT id FROM roots))
            UNION SELECT invitee_user_id FROM circle_invites WHERE status='PENDING' AND (circle_id IN (SELECT id FROM related_circles) OR inviter_user_id IN (SELECT id FROM roots))
            UNION SELECT viewer_user_id FROM private_person_nicknames WHERE subject_user_id IN (SELECT id FROM roots)
            UNION SELECT subject_user_id FROM private_person_nicknames WHERE viewer_user_id IN (SELECT id FROM roots)
        ) SELECT id FROM app_users WHERE id IN (SELECT id FROM participants) ORDER BY id
    """.trimIndent(),id,extra,extra,id){it.getObject(1,UUID::class.java)}

    /** Match social writers' user-before-child lock order, including peers, group owners/members
     * and pending invite participants. If membership/proof discovery changed while acquiring the
     * ordered set, restart instead of appending out-of-order locks or using an incomplete graph. */
    private fun lockAccountGraph(c: Connection, session: ByteArray, extra: UUID? = null): UUID {
        val id=user(c,session)
        c.update("SET LOCAL lock_timeout = '5s'")
        val ids=graphUsers(c,id,extra)
        val marks=ids.joinToString(","){"?"}
        c.rows("SELECT id FROM app_users WHERE id IN ($marks) ORDER BY id FOR NO KEY UPDATE",*ids.toTypedArray()){it.getObject(1)}
        if(graphUsers(c,id,extra)!=ids)throw GraphChanged()
        return user(c,session)
    }
    private data class Proof(val hash: ByteArray, val subject: String, val provider: String, val target: UUID?, val expires: OffsetDateTime)
    private fun proof(c: Connection, id: UUID, session: ByteArray, browser: ByteArray, action: String, role: String): Proof? = c.one("""
        SELECT p.* FROM account_action_proofs p JOIN app_sessions s ON s.token_hash=p.session_hash
        WHERE p.user_id=? AND p.session_hash=? AND p.browser_hash=? AND p.action=? AND p.role=?
          AND p.expires_at>clock_timestamp() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND (p.proved_user_id IS NULL OR EXISTS(SELECT 1 FROM account_login_identities i JOIN app_users u ON u.id=i.user_id
               WHERE i.provider=p.provider AND i.subject=p.subject AND i.user_id=p.proved_user_id AND u.deleted_at IS NULL))
        ORDER BY p.created_at DESC LIMIT 1
    """.trimIndent(), id, session, browser, action, role) {
        Proof(it.getBytes("flow_hash"), it.getString("subject"), it.getString("provider"), it.getObject("proved_user_id", UUID::class.java), it.getObject("expires_at", OffsetDateTime::class.java))
    }
    private fun profile(c: Connection, id: UUID): AccountProfile = c.one("""
        SELECT public_id,display_name,CASE WHEN status_expires_at IS NULL OR status_expires_at>clock_timestamp() THEN status_text END AS status
        FROM app_users WHERE id=? AND deleted_at IS NULL
    """.trimIndent(), id) { AccountProfile(it.getString(1), it.getString(2), it.getString(3)) } ?: proofRequired()
    private fun label(provider: String, subject: String): String = when (provider) {
        "email" -> subject.take(1) + "•••@" + subject.substringAfter('@')
        "vk" -> "ВКонтакте · …" + subject.takeLast(4)
        else -> "Telegram · …" + subject.takeLast(4)
    }
    override suspend fun recordAccountProof(flow: LoginFlow, subject: String): Unit = tx { c ->
        val session = flow.sessionHash ?: proofRequired()
        val initialOwner=c.one("SELECT user_id FROM account_login_identities WHERE provider=? AND subject=?",flow.provider,subject){it.getObject(1,UUID::class.java)}
        val id = lockAccountGraph(c, session, initialOwner)
        if (flow.intent != "account" || flow.provider !in setOf("email", "vk")) proofRequired()
        if(c.one("SELECT 1 FROM account_identity_retirements r JOIN account_login_flows f ON f.token_hash=? WHERE r.provider=? AND r.subject_hash=sha256(convert_to(?, 'UTF8')) AND r.retired_at>=f.created_at",flow.tokenHash,flow.provider,subject){true}==true) proofRequired()
        // The verifier consumes the challenge first; this separate marker prevents proof replay,
        // including after the capability itself has been deleted by another account operation.
        if (c.update("""
            UPDATE account_login_flows SET account_proved_at=clock_timestamp()
            WHERE token_hash=? AND session_hash=? AND browser_hash=? AND intent='account'
              AND account_action=? AND account_role=? AND provider=? AND consumed_at IS NOT NULL
              AND account_proved_at IS NULL AND expires_at>clock_timestamp()
        """.trimIndent(), flow.tokenHash, session, flow.browserHash, flow.action, flow.role, flow.provider) != 1) proofRequired()
        if (flow.provider == "email" && flow.subject != subject) proofRequired()
        val owner = c.one("SELECT i.user_id FROM account_login_identities i JOIN app_users u ON u.id=i.user_id WHERE provider=? AND subject=? AND u.deleted_at IS NULL", flow.provider, subject) { it.getObject(1, UUID::class.java) }
        when (flow.role) {
            "current" -> if (owner != id) fail("ACCOUNT_WRONG_PROFILE", "Этот способ входа не связан с открытым профилем")
            "other" -> if (flow.action != "merge" || owner == null || owner == id) fail("ACCOUNT_OTHER_PROFILE_REQUIRED", "Подтвердите вход во второй существующий профиль")
            "new-email" -> {
                if (flow.action != "email" || flow.provider != "email") proofRequired()
                if (owner != null) fail("ACCOUNT_EMAIL_IN_USE", "Эта почта уже связана с профилем. Для двух профилей используйте объединение.")
            }
            else -> proofRequired()
        }
        c.update("DELETE FROM account_action_proofs WHERE user_id=? AND session_hash=? AND browser_hash=? AND action=? AND role=?", id, session, flow.browserHash, flow.action, flow.role)
        c.update("""INSERT INTO account_action_proofs(flow_hash,user_id,session_hash,browser_hash,action,role,provider,subject,proved_user_id)
            VALUES (?,?,?,?,?,?,?,?,?)""", flow.tokenHash, id, session, flow.browserHash, flow.action, flow.role, flow.provider, subject, owner)
        Unit
    }
    override suspend fun lifecycle(sessionHash: ByteArray, browserHash: ByteArray): AccountLifecycleState = tx { c ->
        val id = user(c, sessionHash)
        AccountLifecycleState(
            proof(c,id,sessionHash,browserHash,"email","current") != null,
            proof(c,id,sessionHash,browserHash,"merge","current") != null,
            proof(c,id,sessionHash,browserHash,"delete","current") != null,
            proof(c,id,sessionHash,browserHash,"merge","other")?.target?.let { profile(c,it) },
            proof(c,id,sessionHash,browserHash,"email","new-email")?.let { label("email",it.subject) },
        )
    }
    private fun retireIdentity(c: Connection, provider: String, subject: String) {
        c.update("""INSERT INTO account_identity_retirements(provider,subject_hash) VALUES (?,sha256(convert_to(?, 'UTF8')))
            ON CONFLICT(provider,subject_hash) DO UPDATE SET retired_at=clock_timestamp()""", provider,subject)
        c.update("UPDATE account_registration_tickets SET consumed_at=clock_timestamp(),subject='retired' WHERE provider=? AND subject=?",provider,subject)
        c.update("UPDATE account_login_flows SET consumed_at=COALESCE(consumed_at,clock_timestamp()),account_proved_at=COALESCE(account_proved_at,clock_timestamp()),subject=NULL,display_name=NULL,verifier=NULL,nonce=NULL,code_hash=NULL WHERE provider=? AND subject=?",provider,subject)
    }
    private fun clearCapabilities(c: Connection, id: UUID, keepSession: ByteArray? = null) {
        c.update("DELETE FROM game_sessions WHERE user_id=?", id)
        // Before removing identity strings, invalidate verified tickets and in-flight callbacks.
        c.rows("SELECT provider,subject FROM account_login_identities WHERE user_id=?",id) { it.getString(1) to it.getString(2) }.forEach { retireIdentity(c,it.first,it.second) }
        c.update("UPDATE app_sessions SET revoked_at=clock_timestamp(),device_label=NULL WHERE user_id=? AND revoked_at IS NULL AND (?::bytea IS NULL OR token_hash<>?)",id,keepSession,keepSession)
        c.update("UPDATE app_sessions SET device_label=NULL WHERE user_id=?",id)
        c.update("UPDATE account_recovery_contacts SET revoked_at=clock_timestamp() WHERE (owner_user_id=? OR trustee_user_id=?) AND revoked_at IS NULL",id,id)
        c.update("UPDATE account_recovery_attempts SET status='CANCELLED',terminal_at=clock_timestamp() WHERE status IN ('PENDING','APPROVED') AND (initiating_user_id=? OR target_user_id=? OR approved_by_user_id=?)",id,id,id)
        c.update("UPDATE account_recovery_codes SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=?",id)
        c.update("UPDATE account_login_flows SET consumed_at=COALESCE(consumed_at,clock_timestamp()),account_proved_at=COALESCE(account_proved_at,clock_timestamp()),subject=NULL,verifier=NULL,nonce=NULL,code_hash=NULL,display_name=NULL WHERE session_hash IN (SELECT token_hash FROM app_sessions WHERE user_id=?)",id)
        c.update("DELETE FROM account_action_proofs WHERE user_id=? OR proved_user_id=?",id,id)
        c.update("DELETE FROM account_merge_previews WHERE user_id=? OR other_user_id=?",id,id)
        c.update("UPDATE direct_invite_links SET status='REVOKED',revoked_at=clock_timestamp() WHERE inviter_user_id=? AND status='PENDING'",id)
        c.update("UPDATE direct_requests SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'CANCELLED' END,responded_at=clock_timestamp() WHERE (requester_user_id=? OR recipient_user_id=?) AND status='PENDING'",id,id)
        c.update("UPDATE circle_invites SET status='REVOKED',revoked_at=clock_timestamp() WHERE status='PENDING' AND (inviter_user_id=? OR invitee_user_id=? OR circle_id IN (SELECT id FROM circles WHERE kind='GROUP' AND created_by_user_id=?))",id,id,id)
    }
    override suspend fun changeEmail(sessionHash: ByteArray, browserHash: ByteArray, requestHash: ByteArray): Unit = tx { c ->
        if (receipt(c,"email",requestHash,sessionHash,browserHash)) return@tx
        val id=lockAccountGraph(c,sessionHash)
        proof(c,id,sessionHash,browserHash,"email","current") ?: proofRequired()
        val newEmail=proof(c,id,sessionHash,browserHash,"email","new-email") ?: proofRequired()
        if (c.one("SELECT 1 FROM account_login_identities WHERE provider='email' AND subject=?",newEmail.subject) { true } == true) fail("ACCOUNT_EMAIL_IN_USE","Эта почта уже связана с профилем")
        clearCapabilities(c,id,sessionHash)
        c.update("DELETE FROM account_login_identities WHERE user_id=? AND provider='email'",id)
        c.update("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email',?,?)",newEmail.subject,id)
        recordSecurityAchievements(c,id)
        saveReceipt(c,"email",requestHash,id,sessionHash,browserHash)
        Unit
    }
    private data class MergeState(val current: UUID,val other: UUID,val currentProof: Proof,val otherProof: Proof)
    private fun mergeState(c: Connection,id: UUID,session: ByteArray,browser: ByteArray): MergeState {
        val a=proof(c,id,session,browser,"merge","current") ?: proofRequired()
        val b=proof(c,id,session,browser,"merge","other") ?: proofRequired()
        return MergeState(id,b.target ?: proofRequired(),a,b)
    }
    private fun validate(choices: MergeChoices) {
        if (choices.displayNameSource !in setOf("current","other") || choices.statusSource !in setOf("current","other") ||
            choices.providerChoices.any { (k,v)-> k !in setOf("email","vk","telegram") || v !in setOf("current","other") }) fail("INVALID_REQUEST","Выберите данные сохраняемого профиля",400)
    }
    private fun identities(c: Connection,id: UUID): Map<String,String> = c.rows("SELECT provider,subject FROM account_login_identities WHERE user_id=? ORDER BY provider",id) { it.getString(1) to it.getString(2) }.toMap()
    private fun mergePreview(c: Connection,s: MergeState,choices: MergeChoices): MergePreview {
        validate(choices)
        val a=profile(c,s.current); val b=profile(c,s.other)
        val ai=identities(c,s.current); val bi=identities(c,s.other)
        val providers=ai.keys.intersect(bi.keys).map { MergeProviderConflict(it,label(it,ai.getValue(it)),label(it,bi.getValue(it))) }
        val worlds=c.rows("SELECT state::text FROM world_profiles WHERE user_id IN (?,?)",s.current,s.other) {
            worldJson.decodeFromString<WorldState>(it.getString(1))
        }
        val worldJourneys=worlds.flatMap { it.journeys }.distinctBy { it.id }
        val conflicts=buildList {
            if(worlds.count { it.settlement != null } > 1) add("В обоих профилях уже есть поляны. Их объединение пока не поддерживается; обе сохранятся без изменений.")
            if(worldJourneys.size>32) add("Сначала завершите часть путешествий: после объединения их будет больше 32.")
            providers.filter { it.provider !in choices.providerChoices }.forEach { add("Выберите сохраняемый способ входа: ${it.provider}") }

        }
        val direct=c.one("SELECT count(*) FROM circles WHERE kind='DIRECT' AND archived_at IS NULL AND ? IN (direct_user_low_id,direct_user_high_id)",s.other) { it.getInt(1) } ?: 0
        val groups=c.one("SELECT count(*) FROM circle_memberships m JOIN circles c ON c.id=m.circle_id WHERE m.user_id=? AND m.left_at IS NULL AND c.archived_at IS NULL",s.other) { it.getInt(1) } ?: 0
        return MergePreview("",a,b,if(choices.displayNameSource=="current")a.displayName else b.displayName,if(choices.statusSource=="current")a.status else b.status,
            listOf("Ресурсы мира сложатся; сохранятся лучшие улучшения построек, вещи и находки обоих профилей. Одежда останется как в открытом мире; если его ещё нет, перенесётся одежда второго профиля. Путешествия сохранятся: ${worldJourneys.size}. Дневной лимит искр не обновится.",
                "Поляна с постройками и запасами перенесётся целиком, если она есть только в одном профиле. Две обустроенные поляны пока объединить нельзя.",
                "Сохранится открытый профиль ${a.publicId}; прежний ID ${b.publicId} перестанет работать.",
                "Личная история, число отметок, время последней отметки и серия объединятся. Совпадающие по времени отметки сохранятся; в серии они считаются одним моментом. Исторические аудитории других людей не расширятся.",
                "Связей второго профиля: $direct; участий в группах: $groups. Новые связи и новые участия начнутся без показа отметок в обе стороны; совпадающие связи сохранят существующие настройки, запрет любой стороны сохранится.",
                "Ваши группы сохранятся, права владельца второго профиля перейдут сохраняемому профилю. Новые участия начнутся с текущего момента: чужие отметки за время до нового вступления не откроются.",
                "Останется только этот сеанс. Другие сеансы обоих профилей, коды восстановления и приглашения будут отозваны.",
                "Для совпадающих сервисов входа останется явно выбранный аккаунт. Не выбранный аккаунт больше не сможет открыть этот профиль.",
                "Личные заметки и избранное второго профиля удалятся. Его имя и статус будут очищены.",
                "Сетевые игровые тапы сложатся, сохранится лучший рекорд серии. Для каждого месяца сохранится больший счёт двух профилей: очки рейтинга не складываются. Публичность рейтинга останется как в открытом профиле."),conflicts,providers)
    }
    /** Include all rows that determine effects, choices, sharing or capabilities. Session heartbeat
     * timestamps are omitted so ordinary polling does not invalidate a review. */
    private fun stateHash(c: Connection,s: MergeState): ByteArray {
        val queries=listOf(
            "SELECT to_jsonb(t)::text FROM app_users t WHERE id IN (?,?) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM account_login_identities t WHERE user_id IN (?,?) ORDER BY provider,subject",
            "SELECT jsonb_build_array(id,user_id,revoked_at,expires_at)::text FROM app_sessions WHERE user_id IN (?,?) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM circles t WHERE created_by_user_id IN (?,?) OR direct_user_low_id IN (?,?) OR direct_user_high_id IN (?,?) OR id IN (SELECT circle_id FROM circle_memberships WHERE user_id IN (?,?)) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM circle_memberships t WHERE circle_id IN (SELECT circle_id FROM circle_memberships WHERE user_id IN (?,?)) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM recipient_sharing_preferences t WHERE actor_user_id IN (?,?) OR recipient_user_id IN (?,?) ORDER BY actor_user_id,recipient_user_id",
            "SELECT to_jsonb(t)::text FROM circle_sharing_preferences t WHERE circle_id IN (SELECT id FROM circles WHERE direct_user_low_id IN (?,?) OR direct_user_high_id IN (?,?) UNION SELECT circle_id FROM circle_memberships WHERE user_id IN (?,?)) ORDER BY circle_id,user_id",
            "SELECT to_jsonb(t)::text FROM direct_requests t WHERE requester_user_id IN (?,?) OR recipient_user_id IN (?,?) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM circle_invites t WHERE inviter_user_id IN (?,?) OR invitee_user_id IN (?,?) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM direct_invite_links t WHERE inviter_user_id IN (?,?) ORDER BY id",
            "SELECT to_jsonb(t)::text FROM direct_invite_redemptions t WHERE recipient_user_id IN (?,?) OR invite_id IN (SELECT id FROM direct_invite_links WHERE inviter_user_id IN (?,?)) ORDER BY invite_id,recipient_user_id",
            "SELECT to_jsonb(t)::text FROM account_recovery_codes t WHERE user_id IN (?,?) ORDER BY code_hash",
            "SELECT to_jsonb(t)::text FROM private_person_nicknames t WHERE viewer_user_id IN (?,?) OR subject_user_id IN (?,?) ORDER BY viewer_user_id,subject_user_id",
            "SELECT to_jsonb(t)::text FROM direct_person_favorites t WHERE user_id IN (?,?) ORDER BY user_id,circle_id",
            "SELECT to_jsonb(t)::text FROM user_status_write_keys t WHERE user_id IN (?,?) ORDER BY user_id,idempotency_key",
            "SELECT to_jsonb(t)::text FROM user_timezone_write_keys t WHERE user_id IN (?,?) ORDER BY user_id,idempotency_key",
            "SELECT jsonb_build_array(user_id,lifetime_taps,best_series,leaderboard_opt_in,visibility_version)::text FROM game_profiles WHERE user_id IN (?,?) ORDER BY user_id",
            "SELECT to_jsonb(t)::text FROM game_monthly_scores t WHERE user_id IN (?,?) ORDER BY user_id,month",
            "SELECT to_jsonb(t)::text FROM world_profiles t WHERE user_id IN (?,?) ORDER BY user_id",
            "SELECT to_jsonb(t)::text FROM game_items t WHERE user_id IN (?,?) ORDER BY user_id,item_id",
            "SELECT to_jsonb(t)::text FROM game_achievements t WHERE user_id IN (?,?) ORDER BY user_id,achievement_id",
            "SELECT to_jsonb(t)::text FROM account_merge_sources t WHERE target_user_id IN (?,?) ORDER BY source_user_id"
        )
        val digest=MessageDigest.getInstance("SHA-256")
        queries.forEach { sql ->
            val params=Array<Any?>(sql.count{it=='?'}){ if(it%2==0)s.current else s.other }
            c.rows(sql,*params){it.getString(1)}.forEach { digest.update(it.toByteArray(Charsets.UTF_8));digest.update(0.toByte()) }
            digest.update(1.toByte())
        }
        return digest.digest()
    }
    override suspend fun previewMerge(sessionHash: ByteArray,browserHash: ByteArray,choices: MergeChoices,previewHash: ByteArray): MergePreview = tx { c ->
        val id=lockAccountGraph(c,sessionHash);val s=mergeState(c,id,sessionHash,browserHash)
        val preview=mergePreview(c,s,choices)
        c.update("DELETE FROM account_merge_previews WHERE session_hash=? OR expires_at<clock_timestamp()",sessionHash)
        c.update("""INSERT INTO account_merge_previews(token_hash,user_id,other_user_id,session_hash,browser_hash,current_proof_hash,other_proof_hash,state_hash,choices_json,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,LEAST(?,?))""",previewHash,id,s.other,sessionHash,browserHash,s.currentProof.hash,s.otherProof.hash,stateHash(c,s),json.encodeToString(choices),s.currentProof.expires,s.otherProof.expires)
        preview.copy(expiresInSeconds=maxOf(0,java.time.Duration.between(OffsetDateTime.now(),minOf(s.currentProof.expires,s.otherProof.expires)).seconds.toInt()))
    }
    private fun deny(c: Connection,a: UUID,b: UUID) {
        if(a==b)return
        c.update("INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode) VALUES (?,?,'OFF') ON CONFLICT(actor_user_id,recipient_user_id) DO UPDATE SET sharing_mode='OFF'",a,b)
    }
    private fun closeSocial(c: Connection,id: UUID,archiveOwnedGroups: Boolean) {
        c.update("UPDATE circle_sharing_preferences p SET sharing_mode='OFF' FROM circles c WHERE p.circle_id=c.id AND p.user_id=? AND c.archived_at IS NULL AND (c.kind='DIRECT' OR EXISTS(SELECT 1 FROM circle_memberships m WHERE m.circle_id=c.id AND m.user_id=? AND m.left_at IS NULL))",id,id)
        c.update("UPDATE recipient_sharing_preferences SET sharing_mode='OFF' WHERE actor_user_id=? OR recipient_user_id=?",id,id)
        c.update("UPDATE circles SET archived_at=clock_timestamp() WHERE archived_at IS NULL AND ((kind='DIRECT' AND ? IN (direct_user_low_id,direct_user_high_id)) OR (kind='GROUP' AND created_by_user_id=? AND ?))",id,id,archiveOwnedGroups)
        c.update("UPDATE circle_memberships SET left_at=clock_timestamp() WHERE left_at IS NULL AND (user_id=? OR circle_id IN (SELECT id FROM circles WHERE kind='GROUP' AND created_by_user_id=? AND archived_at IS NOT NULL))",id,id)
        c.update("DELETE FROM direct_person_favorites WHERE user_id=? OR circle_id IN (SELECT id FROM circles WHERE archived_at IS NOT NULL AND (created_by_user_id=? OR ? IN (direct_user_low_id,direct_user_high_id)))",id,id,id)
        c.update("DELETE FROM private_person_nicknames WHERE viewer_user_id=? OR subject_user_id=?",id,id)
        c.update("DELETE FROM user_status_write_keys WHERE user_id=?",id)
        c.update("DELETE FROM user_timezone_write_keys WHERE user_id=?",id)
    }
    private fun mergeGameProgress(c: Connection, target: UUID, source: UUID) {
        // Lifetime is personal history. Competitive monthly scores use MAX to prevent
        // parallel accounts from adding their separate per-user rate budgets together.
        c.update("""
            INSERT INTO game_profiles(user_id,lifetime_taps,best_series,bucket_tokens)
            SELECT ?,lifetime_taps,best_series,0 FROM game_profiles WHERE user_id=?
            ON CONFLICT(user_id) DO UPDATE SET
                lifetime_taps=LEAST(9007199254740991,game_profiles.lifetime_taps+EXCLUDED.lifetime_taps),
                best_series=GREATEST(game_profiles.best_series,EXCLUDED.best_series)
        """.trimIndent(),target,source)
        c.update("""
            INSERT INTO game_monthly_scores(user_id,month,taps,updated_at)
            SELECT ?,month,taps,clock_timestamp() FROM game_monthly_scores WHERE user_id=?
            ON CONFLICT(user_id,month) DO UPDATE SET taps=GREATEST(game_monthly_scores.taps,EXCLUDED.taps),
                updated_at=CASE WHEN EXCLUDED.taps>game_monthly_scores.taps THEN EXCLUDED.updated_at ELSE game_monthly_scores.updated_at END
        """.trimIndent(),target,source)
        // Never inherit source opt-in. Invalidate stale settings writes and spend the
        // burst allowance so repeatedly merging empty accounts cannot refill it.
        c.update("""
            UPDATE game_profiles SET bucket_tokens=0,bucket_updated_at=clock_timestamp(),
                visibility_version=LEAST(9007199254740991,visibility_version+1),updated_at=clock_timestamp()
            WHERE user_id=?
        """.trimIndent(),target)
    }
    private fun tombstone(c: Connection,id: UUID) {
        c.update("DELETE FROM user_incidents WHERE user_id=?",id)
        c.update("DELETE FROM world_commands WHERE user_id=?",id)
        c.update("DELETE FROM world_ledger WHERE user_id=?",id)
        c.update("DELETE FROM world_profiles WHERE user_id=?",id)
        c.update("DELETE FROM game_items WHERE user_id=?",id)
        c.update("DELETE FROM game_achievements WHERE user_id=?",id)
        c.update("DELETE FROM game_sessions WHERE user_id=?",id)
        c.update("DELETE FROM game_monthly_scores WHERE user_id=?",id)
        c.update("DELETE FROM game_profiles WHERE user_id=?",id)
        c.update("DELETE FROM account_login_identities WHERE user_id=?",id)
        c.update("UPDATE app_users SET display_name='Удалённый профиль',status_text=NULL,status_updated_at=NULL,status_expires_at=NULL,last_check_in_at=NULL,avatar_storage_key=NULL,avatar_updated_at=NULL,display_name_changed_at=NULL,display_name_change_key=NULL,updated_at=clock_timestamp(),deleted_at=clock_timestamp() WHERE id=?",id)
    }
    override suspend fun confirmMerge(sessionHash: ByteArray,browserHash: ByteArray,previewHash: ByteArray): Unit = tx { c ->
        if (receipt(c,"merge",previewHash,sessionHash,browserHash)) return@tx
        val id=lockAccountGraph(c,sessionHash);val s=mergeState(c,id,sessionHash,browserHash)
        data class Saved(val choices: MergeChoices,val hash: ByteArray,val a: ByteArray,val b: ByteArray)
        val saved=c.one("SELECT * FROM account_merge_previews WHERE token_hash=? AND user_id=? AND other_user_id=? AND session_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",previewHash,id,s.other,sessionHash,browserHash) {
            Saved(json.decodeFromString<MergeChoices>(it.getString("choices_json")),it.getBytes("state_hash"),it.getBytes("current_proof_hash"),it.getBytes("other_proof_hash"))
        } ?: fail("ACCOUNT_PREVIEW_EXPIRED","Откройте проверку объединения заново")
        if(!MessageDigest.isEqual(saved.hash,stateHash(c,s)) || !MessageDigest.isEqual(saved.a,s.currentProof.hash) || !MessageDigest.isEqual(saved.b,s.otherProof.hash)) fail("ACCOUNT_PREVIEW_STALE","Данные профилей изменились. Проверьте объединение заново.")
        val preview=mergePreview(c,s,saved.choices)
        if(preview.conflicts.isNotEmpty())fail("ACCOUNT_MERGE_CONFLICT",preview.conflicts.joinToString(" "))
        val ai=identities(c,id);val bi=identities(c,s.other)
        val peers=c.rows("SELECT CASE WHEN direct_user_low_id=? THEN direct_user_high_id ELSE direct_user_low_id END FROM circles WHERE kind='DIRECT' AND archived_at IS NULL AND ? IN (direct_user_low_id,direct_user_high_id)",s.other,s.other){it.getObject(1,UUID::class.java)}.filter{it!=id}
        val groups=c.rows("SELECT m.circle_id,m.role FROM circle_memberships m JOIN circles c ON c.id=m.circle_id WHERE m.user_id=? AND m.left_at IS NULL AND c.archived_at IS NULL ORDER BY m.circle_id",s.other){it.getObject(1,UUID::class.java) to it.getString(2)}
        // Preserve an explicit deny from either profile on duplicates before closing source paths.
        val denies=c.rows("SELECT actor_user_id,recipient_user_id FROM active_recipient_sharing_paths p CROSS JOIN LATERAL effective_recipient_sharing(p.actor_user_id,p.recipient_user_id) e WHERE ? IN (p.actor_user_id,p.recipient_user_id) AND e.sharing_mode='OFF'",s.other){it.getObject(1,UUID::class.java) to it.getObject(2,UUID::class.java)}
        val freshOwnedGroups=groups.filter { it.second=="OWNER" }.mapNotNull { (group,_) ->
            val fresh=c.one("SELECT account_transfer_group_owner(?,?,?,?,?,?)",group,s.other,id,previewHash,sessionHash,browserHash){it.getBoolean(1)} ?: false
            group.takeIf{fresh}
        }.toSet()
        clearCapabilities(c,id,sessionHash);clearCapabilities(c,s.other)
        closeSocial(c,s.other,false)
        peers.forEach { peer ->
            val existing=c.one("SELECT id FROM circles WHERE kind='DIRECT' AND archived_at IS NULL AND direct_user_low_id=LEAST(?::uuid,?::uuid) AND direct_user_high_id=GREATEST(?::uuid,?::uuid)",id,peer,id,peer){it.getObject(1,UUID::class.java)}
            if(existing==null) {
                val circle=c.one("INSERT INTO circles(kind,created_by_user_id,direct_user_low_id,direct_user_high_id) VALUES ('DIRECT',?,LEAST(?::uuid,?::uuid),GREATEST(?::uuid,?::uuid)) RETURNING id",id,id,peer,id,peer){it.getObject(1,UUID::class.java)}!!
                listOf(id,peer).forEach { c.update("INSERT INTO circle_sharing_preferences(circle_id,user_id,sharing_mode,enabled_since) VALUES (?,?,'OFF',NULL)",circle,it) }
                deny(c,id,peer);deny(c,peer,id)
            }
        }
        groups.forEach { (circle,role) ->
            val existing=c.one("SELECT 1 FROM circle_memberships WHERE circle_id=? AND user_id=? AND left_at IS NULL",circle,id){true}==true
            if(existing && role=="ADMIN")c.update("UPDATE circle_memberships SET role='ADMIN' WHERE circle_id=? AND user_id=? AND left_at IS NULL AND role='MEMBER'",circle,id)
            if(!existing || circle in freshOwnedGroups) {
                if(!existing)c.update("INSERT INTO circle_memberships(circle_id,user_id,role,share_latest,history_visibility) VALUES (?,?,?,false,'FROM_JOIN')",circle,id,role)
                c.update("INSERT INTO circle_sharing_preferences(circle_id,user_id,sharing_mode,enabled_since) VALUES (?,?,'OFF',NULL) ON CONFLICT(circle_id,user_id) DO UPDATE SET sharing_mode='OFF'",circle,id)
                c.rows("SELECT user_id FROM circle_memberships WHERE circle_id=? AND left_at IS NULL AND user_id<>?",circle,id){it.getObject(1,UUID::class.java)}.forEach{deny(c,id,it);deny(c,it,id)}
            }
        }
        denies.forEach { (a,b)->deny(c,if(a==s.other)id else a,if(b==s.other)id else b) }
        // Remove loser identities first to satisfy per-provider and provider-subject uniqueness.
        c.update("DELETE FROM account_login_identities WHERE user_id=?",s.other)
        bi.forEach { (provider,subject) ->
            if(provider !in ai || saved.choices.providerChoices[provider]=="other") {
                c.update("DELETE FROM account_login_identities WHERE user_id=? AND provider=?",id,provider)
                c.update("INSERT INTO account_login_identities(provider,subject,user_id) VALUES (?,?,?)",provider,subject,id)
            }
        }
        // Both fields must share a timestamp: assignment evaluation order is not guaranteed.
        if(saved.choices.displayNameSource=="other") c.update("UPDATE app_users SET display_name=?,display_name_changed_at=statement_timestamp(),display_name_change_key=uuidv7(),updated_at=statement_timestamp() WHERE id=?",preview.displayName,id)
        if(saved.choices.statusSource=="other") {
            // Preserve original status timestamp/expiry, so selecting it cannot reset its lifetime.
            c.update("UPDATE app_users a SET status_text=b.status_text,status_updated_at=b.status_updated_at,status_expires_at=b.status_expires_at,updated_at=clock_timestamp() FROM app_users b WHERE a.id=? AND b.id=?",id,s.other)
        }
        c.update("UPDATE account_merge_sources SET target_user_id=? WHERE target_user_id=?",id,s.other)
        c.update("INSERT INTO account_merge_sources(source_user_id,target_user_id) VALUES (?,?)",s.other,id)
        c.update("UPDATE app_users SET last_check_in_at=(SELECT last_check_in_at FROM account_check_in_summary(?)),updated_at=clock_timestamp() WHERE id=?",id,id)
        mergeWorldProfiles(c,id,s.other)
        mergeGameProgress(c,id,s.other)
        c.update("""
            INSERT INTO game_achievements(user_id,achievement_id,unlocked_at)
            SELECT ?,achievement_id,unlocked_at FROM game_achievements WHERE user_id=?
            ON CONFLICT(user_id,achievement_id) DO UPDATE
                SET unlocked_at=LEAST(game_achievements.unlocked_at,EXCLUDED.unlocked_at)
        """.trimIndent(),id,s.other)
        val awardTime=c.one("SELECT clock_timestamp()") { it.getObject(1,OffsetDateTime::class.java) }!!
        c.update("""
            INSERT INTO game_items(user_id,item_id,unlocked_at)
            SELECT ?,item_id,unlocked_at FROM game_items WHERE user_id=?
            ON CONFLICT(user_id,item_id) DO UPDATE SET unlocked_at=LEAST(game_items.unlocked_at,EXCLUDED.unlocked_at)
        """,id,s.other)
        recordMergedAchievements(c,id,awardTime)
        tombstone(c,s.other)
        saveReceipt(c,"merge",previewHash,id,sessionHash,browserHash)
        Unit
    }
    override suspend fun deleteAccount(sessionHash: ByteArray,browserHash: ByteArray,requestHash: ByteArray): Unit = tx { c ->
        if (receipt(c,"delete",requestHash,sessionHash,browserHash)) return@tx
        val id=lockAccountGraph(c,sessionHash)
        proof(c,id,sessionHash,browserHash,"delete","current") ?: proofRequired()
        clearCapabilities(c,id);closeSocial(c,id,true);tombstone(c,id)
        saveReceipt(c,"delete",requestHash,id,sessionHash,browserHash)
        Unit
    }
}
