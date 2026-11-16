package ru.zhiv.db

import ru.zhiv.economy.EconomyRules
import ru.zhiv.game.FishingRecordLeader
import java.sql.Connection
import java.util.UUID

internal fun fishingRecordLeaders(c: Connection, user: UUID, scope: String): List<FishingRecordLeader> {
    val species = c.createArrayOf("text", checkNotNull(EconomyRules.catalog.boat).weights.keys.toTypedArray())
    try {
        // Scope the friendship query before ranking. For a world board the
        // species/weight index can stop once the first weight and its ties end.
        val friends = scope == "friends"
        val people = if (friends) "WITH people AS MATERIALIZED (SELECT ?::uuid AS user_id UNION SELECT user_id FROM active_direct_friend_ids(?))" else ""
        val filter = if (friends) "JOIN people USING (user_id)" else ""
        val query = """
            $people
            SELECT DISTINCT ON (s.fish_id) s.fish_id, leader.weight_grams, leader.display_name, leader.id=? AS is_me,
                   count(*) OVER (PARTITION BY s.fish_id) AS tied_count
            FROM unnest(?::text[]) s(fish_id)
            CROSS JOIN LATERAL (
                SELECT r.weight_grams, u.id, u.display_name, u.public_id
                FROM game_fishing_records r $filter
                JOIN app_users u ON u.id=r.user_id
                WHERE r.fish_id=s.fish_id AND u.deleted_at IS NULL AND u.banned_at IS NULL
                ORDER BY r.weight_grams DESC FETCH FIRST ROW WITH TIES
            ) leader
            ORDER BY s.fish_id, is_me DESC, leader.public_id
        """
        val args = if (friends) arrayOf(user, user, user, species) else arrayOf(user, species)
        return c.economyRows(query, *args) { row ->
            FishingRecordLeader(row.getString(1), row.getInt(2), row.getString(3), row.getBoolean(4), row.getLong(5))
        }
    } finally {
        species.free()
    }
}
