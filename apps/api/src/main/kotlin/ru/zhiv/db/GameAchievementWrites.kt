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

internal fun recordStreakRewards(connection: Connection, userId: UUID, longestDays: Long, at: OffsetDateTime) {
    if (longestDays >= 7) recordGameAchievement(connection, userId, "seven_day_streak", at)
    ru.zhiv.game.GameRewards.items.filterValues { longestDays >= it }.keys.forEach { id ->
        connection.prepareStatement("INSERT INTO game_items(user_id,item_id,unlocked_at) VALUES (?,?,?) ON CONFLICT DO NOTHING").use {
            it.setObject(1,userId); it.setString(2,id); it.setObject(3,at); it.executeUpdate()
        }
    }
}

/** Reconcile verified totals after a merge or a rolling upgrade, preserving dates. */
internal fun recordMergedAchievements(connection: Connection, userId: UUID, at: OffsetDateTime) {
    connection.prepareStatement("SELECT longest_days FROM rolling_check_in_streak(?,?)").use {
        it.setObject(1,userId); it.setObject(2,at)
        it.executeQuery().use { r -> if (r.next()) recordStreakRewards(connection,userId,r.getLong(1),at) }
    }
    connection.prepareStatement("SELECT lifetime_taps,best_series FROM game_profiles WHERE user_id=?").use {
        it.setObject(1,userId)
        it.executeQuery().use { r -> if (r.next()) {
            if (r.getLong(1)>=1000) recordGameAchievement(connection,userId,"thousand_taps",at)
            if (r.getLong(2)>=10000) recordGameAchievement(connection,userId,"ten_thousand_series",at)
        } }
    }
    recordFriendAchievement(connection,userId,at)
    recordSecurityAchievements(connection,userId)
}

/** Only verified identities and activated code hashes qualify; never raw secrets. */
internal fun recordSecurityAchievements(connection: Connection, userId: UUID) {
    connection.prepareStatement("""
        INSERT INTO game_achievements(user_id,achievement_id,unlocked_at)
        SELECT ?, 'linked_email', clock_timestamp()
        WHERE EXISTS (SELECT 1 FROM account_login_identities WHERE user_id=? AND provider='email')
        UNION ALL
        SELECT ?, 'saved_recovery_code', clock_timestamp()
        WHERE EXISTS (SELECT 1 FROM account_recovery_codes WHERE user_id IN (SELECT user_id FROM account_history_user_ids(?)))
        ON CONFLICT(user_id,achievement_id) DO NOTHING
    """.trimIndent()).use {
        for (index in 1..4) it.setObject(index,userId)
        it.executeUpdate()
    }
}
