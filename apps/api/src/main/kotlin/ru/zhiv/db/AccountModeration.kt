package ru.zhiv.db

import ru.zhiv.identity.PlayerTag
import ru.zhiv.auth.AuthFailure
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

internal fun requireUnbannedAccount(c: Connection, id: UUID) {
    val banned=c.prepareStatement("SELECT banned_at IS NOT NULL FROM app_users WHERE id=?").use { s ->
        s.setObject(1,id); s.executeQuery().use { r -> r.next() && r.getBoolean(1) }
    }
    if(banned) throw AuthFailure("ACCOUNT_BANNED","Аккаунт заблокирован администратором. Обратитесь к администратору приложения.",403)
}

internal fun ResultSet.playerTag(): PlayerTag? = getString("tag_text")?.let { PlayerTag(it,getString("tag_color")) }
