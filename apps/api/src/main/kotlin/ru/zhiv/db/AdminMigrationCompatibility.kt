package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.slf4j.LoggerFactory
import java.sql.Connection
import java.util.zip.CRC32
import javax.sql.DataSource

private const val legacyGrantChecksum = 1968638817
private const val legacyPromoChecksum = 1403371834
private const val grantScript = "V51__admin_economy_grants.sql"
private const val promoScript = "V52__managed_promo_codes.sql"
private const val notificationScript = "V50__actionable_notification_sources.sql"
private const val baselineScript = "B49__current_schema.sql"
private val canonicalTailScripts = mapOf(
    50 to notificationScript,
    51 to grantScript,
    52 to promoScript,
    53 to "V53__first_stage_economy.sql",
    54 to "V54__independent_mining_jobs.sql",
    55 to "V55__market_capacity_and_item_knowledge.sql",
    56 to "V56__independent_miner_notification_readiness.sql",
    57 to "V57__garden_collection_ledger_context.sql",
    58 to "V58__single_intro_order_initial_state.sql",
    59 to "V59__onboarding_completion_reward.sql",
    60 to "V60__bounded_player_security_observations.sql",
)

private data class AdminMigrationHistoryRow(
    val rank: Int, val version: String?, val script: String, val checksum: Int?, val type: String, val success: Boolean,
)

/** Flyway's SQL checksum excludes line separators and the leading UTF-8 BOM.
 * Check both the packaged bytes and the recorded checksum; never repair an
 * unknown script, failed installation or unrelated future schema. */
private fun migrationChecksum(script: String): Int {
    val stream = checkNotNull(DatabaseFactory::class.java.getResourceAsStream("/db/migration/$script")
        ?: DatabaseFactory::class.java.getResourceAsStream("/db/migration/history/$script")) {
        "Unknown migration script in admin compatibility history"
    }
    val crc = CRC32()
    stream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.forEachIndexed { index, line ->
            crc.update((if (index == 0) line.removePrefix("\uFEFF") else line).toByteArray(Charsets.UTF_8))
        }
    }
    return crc.value.toInt()
}

private fun validRow(row: AdminMigrationHistoryRow, version: String, script: String, checksum: Int): Boolean =
    row.version == version && row.script == script && row.checksum == checksum && row.type == "SQL" && row.success

private fun requireAdminSchema(c: Connection, promoApplied: Boolean) {
    val shape = c.economyRows("""SELECT
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='admin_actions' AND column_name='accepted_revision' AND data_type='bigint'),
        to_regclass('public.managed_promo_codes') IS NOT NULL,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='notification_events' AND column_name IN ('harvest_ready_at','waiting_for_actor','actor_wait_until'))
    """) { Triple(it.getBoolean(1), it.getBoolean(2), it.getBoolean(3)) }.single()
    check(shape.first && shape.second == promoApplied && !shape.third) {
        "Legacy admin migration schema does not match its known history; no history was changed"
    }
}

/** Used only by the explicit migration process after the deployment backup and
 * stopped application. It changes only version/script in known admin history
 * rows. Ranks, checksums, timestamps and all application data remain intact.
 * Returns true solely when the canonical notification V50 still needs applying.
 */
internal fun normalizeLegacyAdminMigrationHistory(source: DataSource): Boolean = source.connection.use { c ->
    c.autoCommit = false
    try {
        check(c.economyRows("SELECT current_user") { it.getString(1) }.single() != "zhiv_app") {
            "Runtime role must not normalize migration history"
        }
        val exists = c.economyRows("SELECT to_regclass('public.flyway_schema_history') IS NOT NULL") { it.getBoolean(1) }.single()
        if (!exists) { c.commit(); return@use false }
        c.economyUpdate("LOCK TABLE public.flyway_schema_history IN EXCLUSIVE MODE")
        val rows = c.economyRows("""SELECT installed_rank,version,script,checksum,type,success
            FROM public.flyway_schema_history ORDER BY installed_rank""") {
            AdminMigrationHistoryRow(it.getInt(1), it.getString(2), it.getString(3),
                it.getObject(4)?.let { value -> (value as Number).toInt() }, it.getString(5), it.getBoolean(6))
        }
        check(rows.all { it.success && it.type in setOf("SQL", "SQL_BASELINE") && it.version?.matches(Regex("[1-9][0-9]*")) == true }) {
            "Admin compatibility refuses failed, non-SQL or unknown migration history"
        }
        val versions = rows.map { checkNotNull(it.version).toIntOrNull() ?: error("Unknown migration version") }
        check(versions.distinct().size == versions.size && versions.all { it in 1..canonicalTailScripts.keys.max() }) {
            "Admin compatibility refuses duplicate or future migration versions"
        }
        val baselines = rows.filter { it.type == "SQL_BASELINE" }
        if (baselines.isNotEmpty()) {
            val baseline = baselines.singleOrNull()
            check(baseline != null && baseline.version == "49" && baseline.script == baselineScript &&
                baseline.checksum == migrationChecksum(baselineScript) && versions.none { it < 49 }) {
                "Admin compatibility refuses unknown or mixed baseline history"
            }
        }
        // Ordinary canonical history is validated normally by Flyway. Only the
        // two known legacy fingerprints may reach the metadata rewrite below.
        val tail = rows.filter { checkNotNull(it.version).toInt() >= 50 }
        if (tail.isEmpty()) { c.commit(); return@use false }
        val legacyGrant = tail.singleOrNull { validRow(it, "50", "V50__admin_economy_grants.sql", legacyGrantChecksum) }
        val legacyPromo = tail.singleOrNull { validRow(it, "51", "V51__managed_promo_codes.sql", legacyPromoChecksum) }
        val resumedGrant = tail.singleOrNull { validRow(it, "51", grantScript, legacyGrantChecksum) }
        val resumedPromo = tail.singleOrNull { validRow(it, "52", promoScript, legacyPromoChecksum) }
        val canonicalNotification = tail.singleOrNull {
            validRow(it, "50", notificationScript, migrationChecksum(notificationScript))
        }
        if (canonicalNotification != null) {
            check(tail.all { row ->
                val version = checkNotNull(row.version).toInt()
                val script = canonicalTailScripts[version]
                script != null && validRow(row, version.toString(), script, migrationChecksum(script))
            } && tail.map { checkNotNull(it.version).toInt() }.sorted() == (50..tail.maxOf { checkNotNull(it.version).toInt() }).toList()) {
                "Admin compatibility refuses unknown canonical migration history"
            }
            c.commit(); return@use false
        }
        val legacy = legacyGrant != null && tail.all { it == legacyGrant || it == legacyPromo }
        val resumed = resumedGrant != null && tail.all { it == resumedGrant || it == resumedPromo }
        check(legacy || resumed) { "Admin compatibility refuses unknown legacy scripts or checksums" }
        check(baselines.isEmpty()) { "Legacy admin compatibility cannot rewrite baseline history" }
        check(versions.filter { it < 50 }.sorted() == (1..49).toList()) {
            "Legacy admin compatibility requires the complete original V1–V49 history"
        }
        rows.filter { checkNotNull(it.version).toInt() < 50 }.forEach { row ->
            check(row.script.matches(Regex("V${row.version}__[A-Za-z0-9_]+\\.sql")) &&
                row.checksum == migrationChecksum(row.script)) {
                "Original migration history changed; no admin history was normalized"
            }
        }
        check(migrationChecksum(grantScript) == legacyGrantChecksum && migrationChecksum(promoScript) == legacyPromoChecksum) {
            "Packaged admin migration bytes differ from the known deployed version"
        }
        requireAdminSchema(c, legacyPromo != null || resumedPromo != null)
        if (legacy) {
            // Move the old V51 first, so both changes remain valid even if a
            // history schema adds a uniqueness constraint on version later.
            legacyPromo?.let { row ->
                check(c.economyUpdate("""UPDATE public.flyway_schema_history SET version='52',script=?
                    WHERE installed_rank=? AND version='51' AND script='V51__managed_promo_codes.sql'
                    AND checksum=? AND type='SQL' AND success""", promoScript, row.rank, legacyPromoChecksum) == 1)
            }
            check(c.economyUpdate("""UPDATE public.flyway_schema_history SET version='51',script=?
                WHERE installed_rank=? AND version='50' AND script='V50__admin_economy_grants.sql'
                AND checksum=? AND type='SQL' AND success""", grantScript, checkNotNull(legacyGrant).rank, legacyGrantChecksum) == 1)
        }
        c.commit()
        if (legacy) LoggerFactory.getLogger("AdminMigrationCompatibility").info(
            "Normalized known admin migration versions; canonical notification V50 will apply next",
        )
        true
    } catch (error: Exception) { c.rollback(); throw error }
}

/** No runtime API calls this function. Out-of-order execution is enabled only
 * after exact legacy/resume history and schema checks, never for normal DBs. */
internal fun migrateWithLegacyAdminHistory(source: DataSource) {
    if (!normalizeLegacyAdminMigrationHistory(source)) {
        DatabaseFactory.migrate(source)
        return
    }
    Flyway.configure().dataSource(source).locations("classpath:db/migration")
        .cleanDisabled(true).outOfOrder(true).load().migrate()
}
