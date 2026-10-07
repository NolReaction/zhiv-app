package ru.zhiv.db

import ru.zhiv.auth.AuthFailure
import java.sql.Connection
import java.util.UUID

/** This digest is an allocation fence, never a credential or automatic login alias.
 * Existing ownership is checked separately. A survivor may explicitly restore its
 * discarded method; real deletion permits a new empty profile, banning does not. */
internal fun assertMergedIdentityAllocation(c: Connection, provider: String, subject: String, requestedUser: UUID? = null) {
    val blocked = c.prepareStatement("""
        SELECT 1 FROM account_identity_retirements r JOIN app_users u ON u.id=r.merged_into_user_id
        WHERE r.provider=? AND r.subject_hash=sha256(convert_to(?, 'UTF8'))
          AND u.deleted_at IS NULL AND (?::uuid IS NULL OR u.id<>?::uuid)
    """.trimIndent()).use { statement ->
        statement.setString(1, provider); statement.setString(2, subject)
        statement.setObject(3, requestedUser); statement.setObject(4, requestedUser)
        statement.executeQuery().use { it.next() }
    }
    if (blocked) throw AuthFailure("AUTH_IDENTITY_MERGED",
        "Этот способ входа уже участвовал в объединении. Его можно вернуть только в сохранённом профиле через «Способы входа».", 409)
}
