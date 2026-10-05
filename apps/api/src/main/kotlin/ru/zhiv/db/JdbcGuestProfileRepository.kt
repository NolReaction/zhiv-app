package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import ru.zhiv.relationships.*
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

/** One SQL snapshot checks authorization and projects only the public game fields. Reads never create profiles or grant awards. */
class JdbcGuestProfileRepository(private val source: DataSource) : GuestProfileRepository {
    override suspend fun profile(sessionHash: ByteArray, circleId: UUID): GuestProfile = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.isReadOnly = true
            val signedIn = c.prepareStatement("""
                SELECT 1 FROM app_sessions s JOIN app_users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
                  AND u.deleted_at IS NULL AND u.banned_at IS NULL
            """.trimIndent()).use { s -> s.setBytes(1,sessionHash); s.executeQuery().use { it.next() } }
            if (!signedIn) throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
            c.prepareStatement("""
                SELECT viewer.public_id AS owner_public_id, other.public_id, other.display_name,
                       COALESCE((ep.state#>>'{buildings,home}')::integer,1) AS home_level,
                       COALESCE((ep.state->>'completedExplorations')::bigint,0) AS explorations,
                       COALESCE(ep.state#>'{progression,collections,finds}','[]'::jsonb)
                           || COALESCE(wp.state->'collection','[]'::jsonb) AS finds,
                       COALESCE(ep.state#>'{fishing,catches}','{}'::jsonb) AS catches,
                       COALESCE((SELECT jsonb_object_agg(a.achievement_id,COALESCE((
                           SELECT max(t.level) FROM game_achievement_tiers t
                           WHERE t.user_id=a.user_id AND t.achievement_id=a.achievement_id),1))
                           FROM game_achievements a WHERE a.user_id=other.id AND a.achievement_id=ANY(?::text[])),
                           '{}'::jsonb) AS achievements,
                       statement_timestamp() AS server_time
                FROM app_sessions s JOIN app_users viewer ON viewer.id=s.user_id
                JOIN circles circle ON circle.id=? AND circle.kind='DIRECT' AND circle.archived_at IS NULL
                    AND viewer.id IN(circle.direct_user_low_id,circle.direct_user_high_id)
                JOIN app_users other ON other.id=CASE WHEN viewer.id=circle.direct_user_low_id
                    THEN circle.direct_user_high_id ELSE circle.direct_user_low_id END
                CROSS JOIN LATERAL effective_recipient_sharing(other.id,viewer.id) privacy
                LEFT JOIN economy_profiles ep ON ep.user_id=other.id
                LEFT JOIN world_profiles wp ON wp.user_id=other.id
                WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
                    AND viewer.deleted_at IS NULL AND viewer.banned_at IS NULL
                    AND other.deleted_at IS NULL AND other.banned_at IS NULL AND privacy.sharing_mode<>'OFF'
            """.trimIndent()).use { s ->
                val ids = c.createArrayOf("text",GuestProfileRules.achievementIds.toTypedArray())
                try {
                    s.setArray(1,ids); s.setObject(2,circleId); s.setBytes(3,sessionHash)
                    s.executeQuery().use { r ->
                        if (!r.next()) throw AuthFailure("GUEST_PROFILE_UNAVAILABLE", "Профиль недоступен", 404)
                        GuestProfile(r.getString("owner_public_id"),circleId.toString(),
                            GuestProfileUser(r.getString("public_id"),r.getString("display_name")),
                            r.getInt("home_level").coerceIn(1,5),r.getLong("explorations").coerceAtLeast(0),
                            GuestProfileRules.achievements(Json.decodeFromString<Map<String,Int>>(r.getString("achievements"))),
                            GuestProfileRules.collections(Json.decodeFromString<List<String>>(r.getString("finds")),
                                Json.decodeFromString<Map<String,Long>>(r.getString("catches"))),
                            r.getObject("server_time",OffsetDateTime::class.java).toInstant().toString())
                    }
                } finally { ids.free() }
            }
        }
    }
}
