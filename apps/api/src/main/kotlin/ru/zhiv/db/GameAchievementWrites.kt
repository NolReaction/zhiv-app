package ru.zhiv.db

import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID

/** Called inside the qualifying write transaction while its user locks are held. */
internal fun recordGameAchievement(connection: Connection, userId: UUID, id: String, at: OffsetDateTime) {
    connection.prepareStatement("""
        INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,?,?)
        ON CONFLICT(user_id,achievement_id) DO NOTHING
    """.trimIndent()).use {
        it.setObject(1,userId); it.setString(2,id); it.setObject(3,at); it.executeUpdate()
    }
}

internal fun recordFriendAchievement(connection: Connection, userId: UUID, at: OffsetDateTime) {
    connection.prepareStatement("""
        INSERT INTO game_achievements(user_id,achievement_id,unlocked_at)
        SELECT ?, 'five_friends', ?::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM game_achievements WHERE user_id=? AND achievement_id='five_friends')
          AND (SELECT count(*) FROM (SELECT user_id FROM active_direct_friend_ids(?) LIMIT 5) friends)=5
        ON CONFLICT(user_id,achievement_id) DO NOTHING
    """.trimIndent()).use {
        it.setObject(1,userId); it.setObject(2,at); it.setObject(3,userId); it.setObject(4,userId); it.executeUpdate()
    }
}

/** A merge may cross a threshold even when neither source had unlocked it. */
internal fun recordMergedAchievements(connection: Connection, userId: UUID, at: OffsetDateTime) {
    connection.prepareStatement("""
        INSERT INTO game_achievements(user_id,achievement_id,unlocked_at)
        SELECT ?, 'seven_day_streak', ?::timestamptz
          WHERE (SELECT longest_days FROM rolling_check_in_streak(?,?))>=7
        UNION ALL
        SELECT ?, 'thousand_taps', ?::timestamptz
          WHERE (SELECT lifetime_taps FROM game_profiles WHERE user_id=?)>=1000
        ON CONFLICT(user_id,achievement_id) DO NOTHING
    """.trimIndent()).use {
        it.setObject(1,userId); it.setObject(2,at); it.setObject(3,userId); it.setObject(4,at)
        it.setObject(5,userId); it.setObject(6,at); it.setObject(7,userId); it.executeUpdate()
    }
    recordFriendAchievement(connection,userId,at)
}
