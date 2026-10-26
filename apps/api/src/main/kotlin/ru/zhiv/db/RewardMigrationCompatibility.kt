package ru.zhiv.db

import java.sql.Connection
import javax.sql.DataSource

private const val rewardPromiseChecksum = -1099169862
private const val originalRewardScript = "V71__economy_reward_promises.sql"
private const val canonicalRewardScript = "V73__economy_reward_promises.sql"

private data class RewardHistoryRow(
    val rank: Int, val version: String?, val script: String, val checksum: Int?, val type: String, val success: Boolean,
)

private fun requireRewardPromiseSchema(c: Connection) {
    val shape = c.economyRows("""SELECT
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='player_mail_messages' AND column_name='welcome_pearls' AND data_type='bigint'),
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='game_daily_rewards' AND column_name='reward_catalog_version'
            AND data_type='integer' AND is_nullable='NO' AND column_default='6'),
        EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.player_mail_messages'::regclass
            AND conname='player_mail_welcome_pearls_check' AND convalidated),
        EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.game_daily_rewards'::regclass
            AND conname='game_daily_rewards_catalog_version_check' AND convalidated),
        public.economy_v4_initial_state('{}'::jsonb,true)#>>'{tutorialOrder,rewardVersion}' = '6'
    """) { listOf(it.getBoolean(1), it.getBoolean(2), it.getBoolean(3), it.getBoolean(4), it.getBoolean(5)) }.single()
    check(shape.all { it }) { "Reward branch schema differs from the known V71; no history was changed" }
}

/** A published development branch used V71 for reward promises while the
 * neighbor branch had already used V71/V72. Preserve the reward SQL bytes and
 * checksum under V73. Only exact recognized history is relabeled; application
 * data, checksums, installed ranks and timestamps are never rewritten.
 *
 * Called by the one-shot migration command under stopped writers, never by the
 * runtime API. True permits only the known missing neighbor tail to run out of
 * order. An interrupted relabel or V71 application is safe to resume. */
internal fun normalizeLegacyRewardPromiseHistory(source: DataSource): Boolean = source.connection.use { c ->
    c.autoCommit = false
    try {
        check(c.economyRows("SELECT current_user") { it.getString(1) }.single() != "zhiv_app") {
            "Runtime role must not normalize migration history"
        }
        if (!c.economyRows("SELECT to_regclass('public.flyway_schema_history') IS NOT NULL") { it.getBoolean(1) }.single()) {
            c.commit(); return@use false
        }
        c.economyUpdate("LOCK TABLE public.flyway_schema_history IN EXCLUSIVE MODE")
        val rows = c.economyRows("""SELECT installed_rank,version,script,checksum,type,success
            FROM public.flyway_schema_history ORDER BY installed_rank""") {
            RewardHistoryRow(it.getInt(1), it.getString(2), it.getString(3),
                it.getObject(4)?.let { value -> (value as Number).toInt() }, it.getString(5), it.getBoolean(6))
        }
        val original = rows.singleOrNull { it.script == originalRewardScript }
        val resumed = rows.singleOrNull { it.script == canonicalRewardScript && it.version == "73" }
        val hasCompleteNeighborTail = rows.any { it.version == "71" && it.script == canonicalTailScripts[71] } &&
            rows.any { it.version == "72" && it.script == canonicalTailScripts[72] }
        if (original == null && (resumed == null || hasCompleteNeighborTail)) {
            c.commit(); return@use false // Canonical/other histories follow the ordinary strict validator.
        }
        check(original == null || resumed == null) { "Duplicate reward branch migration history" }
        val reward = checkNotNull(original ?: resumed)
        check(reward.version == (if (original != null) "71" else "73") && reward.type == "SQL" &&
            reward.success && reward.checksum == rewardPromiseChecksum &&
            migrationChecksum(canonicalRewardScript) == rewardPromiseChecksum) {
            "Unknown reward branch migration fingerprint; no history was changed"
        }
        val base = rows.filter { it != reward }
        val versions = base.map { it.version?.toIntOrNull() ?: error("Unknown reward branch migration version") }
        check(versions.distinct().size == versions.size) { "Duplicate reward branch migration versions" }
        val baseline = base.singleOrNull { it.type == "SQL_BASELINE" }
        val first = if (baseline != null) 49 else 1
        val tail = if (original == null && 71 in versions) 71 else 70
        check(versions.sorted() == (first..tail).toList() && base.all { it.success }) {
            "Reward branch compatibility requires the complete known prefix without future migrations"
        }
        base.forEach { row ->
            val version = checkNotNull(row.version).toInt()
            val expected = when {
                row == baseline -> "B49__current_schema.sql"
                version >= 50 -> canonicalTailScripts[version]
                else -> row.script.takeIf { it.matches(Regex("V${version}__[A-Za-z0-9_]+\\.sql")) }
            }
            check(expected != null && row.script == expected && row.checksum == migrationChecksum(expected) &&
                row.type == if (row == baseline) "SQL_BASELINE" else "SQL") {
                "Unknown original migration in reward branch history; no history was changed"
            }
        }
        requireRewardPromiseSchema(c)
        if (original != null) {
            check(c.economyUpdate("""UPDATE public.flyway_schema_history SET version='73',script=?
                WHERE installed_rank=? AND version='71' AND script=? AND checksum=? AND type='SQL' AND success""",
                canonicalRewardScript, reward.rank, originalRewardScript, rewardPromiseChecksum) == 1)
        }
        c.commit()
        true
    } catch (error: Exception) { c.rollback(); throw error }
}
