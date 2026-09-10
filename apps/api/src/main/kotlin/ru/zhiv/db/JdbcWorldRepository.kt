package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.world.*
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

private fun Connection.worldUpdate(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
    values.forEachIndexed { i,v -> statement.setObject(i+1,v) }; statement.executeUpdate()
}
private fun <T> Connection.worldRows(sql: String, vararg values: Any?, read: (ResultSet)->T): List<T> = prepareStatement(sql).use { statement ->
    values.forEachIndexed { i,v -> statement.setObject(i+1,v) }
    statement.executeQuery().use { result -> buildList { while(result.next()) add(read(result)) } }
}
private data class WorldRow(val state: WorldState, val revision: Long, val day: LocalDate, val earned: Int, val remainder: Int)
private fun Connection.worldRow(user: UUID): WorldRow? = worldRows("SELECT * FROM world_profiles WHERE user_id=?",user) {
    WorldRow(worldJson.decodeFromString<WorldState>(it.getString("state")),it.getLong("revision"),it.getObject("tap_day",LocalDate::class.java),it.getInt("tap_sparks"),it.getInt("tap_remainder"))
}.firstOrNull()
private fun Connection.worldSave(user: UUID, state: WorldState) {
    worldUpdate("UPDATE world_profiles SET state=?::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=?",worldJson.encodeToString(state),user)
}

/** Called only inside an accepted clicker batch transaction, after the common
 * user lock. The original game receipt guards replays; ledger keys guard effects. */
internal fun creditWorldTaps(c: Connection, user: UUID, sourceKey: String, taps: Int, now: OffsetDateTime) {
    if(taps<=0) return
    val row=c.worldRow(user) ?: return // Enrollment is explicit: first open of World.
    val day=now.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate()
    val earned=if(row.day==day) row.earned else 0
    if(earned>=WorldRules.catalog.dailySparkLimit) return
    val total=(if(row.day==day) row.remainder else 0)+taps
    val credit=minOf(WorldRules.catalog.dailySparkLimit-earned,total/WorldRules.catalog.tapsPerSpark)
    if(c.worldUpdate("INSERT INTO world_ledger(user_id,source_key,kind,sparks) VALUES (?,?,'taps',?) ON CONFLICT DO NOTHING",user,sourceKey,credit)==0) return
    c.worldUpdate("UPDATE world_profiles SET tap_day=?,tap_sparks=?,tap_remainder=? WHERE user_id=?",day,earned+credit,total%WorldRules.catalog.tapsPerSpark,user)
    if(credit>0) c.worldSave(user,row.state.copy(resources=row.state.resources.copy(sparks=row.state.resources.sparks+credit)))
}

/** Both users are already locked by the account lifecycle transaction. Starter
 * cosmetics have no currency grant. All in-flight trips transfer with their IDs. */
internal fun mergeWorldProfiles(c: Connection, target: UUID, source: UUID) {
    val b=c.worldRow(source) ?: return
    val a=c.worldRow(target)
    val today=c.worldRows("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date") { it.getObject(1,LocalDate::class.java) }.first()
    val state=if(a==null) b.state else WorldRules.merge(a.state,b.state)
    val earned=minOf(WorldRules.catalog.dailySparkLimit,(if(a?.day==today) a.earned else 0)+(if(b.day==today) b.earned else 0))
    c.worldUpdate("""INSERT INTO world_profiles(user_id,state,revision,tap_day,tap_sparks,tap_remainder) VALUES (?,?::jsonb,?,?,?,0)
        ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,tap_day=EXCLUDED.tap_day,
        tap_sparks=EXCLUDED.tap_sparks,tap_remainder=0,updated_at=clock_timestamp()""",
        target,worldJson.encodeToString(state),maxOf(a?.revision ?: 0,b.revision)+1,today,earned)
    c.worldUpdate("""INSERT INTO world_ledger(user_id,source_key,kind,sparks,wood,stone,created_at)
        SELECT ?,'merged:' || user_id::text || ':' || source_key,kind,sparks,wood,stone,created_at FROM world_ledger WHERE user_id=? ON CONFLICT DO NOTHING""",target,source)
    // Record requests as consumed even if a former source browser retries after merge.
    c.worldUpdate("""INSERT INTO world_commands(user_id,request_id,signature,message,created_at)
        SELECT ?,request_id,signature,message,created_at FROM world_commands WHERE user_id=? ON CONFLICT DO NOTHING""",target,source)
}

class JdbcWorldRepository(private val source: DataSource): WorldRepository {
    private data class Actor(val id: UUID,val publicId: String)
    private fun actor(c: Connection, hash: ByteArray): Actor = c.worldRows("""SELECT u.id,u.public_id FROM app_users u
        JOIN app_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND u.deleted_at IS NULL AND u.banned_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()""",hash) { Actor(it.getObject(1,UUID::class.java),it.getString(2)) }.firstOrNull()
        ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401)
    private suspend fun <T> transaction(hash: ByteArray, block: (Connection,Actor,OffsetDateTime)->T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit=false
            try {
                val first=actor(c,hash)
                c.worldUpdate("SET LOCAL lock_timeout = '5s'")
                c.worldRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",first.id) { true }
                val current=actor(c,hash)
                val now=c.worldRows("SELECT clock_timestamp()") { it.getObject(1,OffsetDateTime::class.java) }.first()
                c.worldUpdate("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb) ON CONFLICT DO NOTHING",current.id,worldJson.encodeToString(WorldState()))
                val result=block(c,current,now); c.commit(); result
            } catch(error: Exception) { c.rollback(); throw error }
        }
    }
    private fun snapshot(c: Connection, actor: Actor, now: OffsetDateTime): WorldSnapshot {
        val row=checkNotNull(c.worldRow(actor.id))
        val gifts=c.worldRows("SELECT item_id FROM game_items WHERE user_id=? ORDER BY item_id",actor.id) { it.getString(1) }
        return WorldSnapshot(actor.publicId,row.revision,now.toInstant().toString(),row.state,gifts,
            if(row.day==now.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate()) row.earned else 0,WorldRules.catalog.version)
    }
    override suspend fun snapshot(sessionHash: ByteArray): WorldSnapshot = transaction(sessionHash) { c,actor,now -> snapshot(c,actor,now) }
    override suspend fun command(sessionHash: ByteArray,command: WorldCommand): WorldResult = transaction(sessionHash) { c,actor,now ->
        if(actor.publicId!=command.ownerPublicId) throw AuthFailure("WORLD_OWNER_CHANGED","Открыт другой профиль. Обновите Мир.",409)
        val id=UUID.fromString(command.requestId)
        val signature=worldJson.encodeToString(command)
        val receipt=c.worldRows("SELECT signature,message FROM world_commands WHERE user_id=? AND request_id=?",actor.id,id) { it.getString(1) to it.getString(2) }.firstOrNull()
        if(receipt!=null) {
            if(receipt.first!=signature) throw AuthFailure("WORLD_COMMAND_CONFLICT","Этот запрос уже использован для другого действия",409)
            return@transaction WorldResult(snapshot(c,actor,now),receipt.second,true)
        }
        val before=checkNotNull(c.worldRow(actor.id))
        if(before.revision!=command.expectedRevision) throw AuthFailure("WORLD_REVISION_CONFLICT","Мир уже изменился. Обновите его и повторите действие.",409)
        val (state,message)=WorldRules.apply(before.state,command,now.toInstant())
        c.worldSave(actor.id,state)
        val a=state.resources; val b=before.state.resources
        c.worldUpdate("INSERT INTO world_ledger(user_id,source_key,kind,sparks,wood,stone) VALUES (?,?,?,?,?,?)",
            actor.id,if(command.action=="claim_journey") "journey:${command.target}" else "command:$id",command.action,a.sparks-b.sparks,a.wood-b.wood,a.stone-b.stone)
        c.worldUpdate("INSERT INTO world_commands(user_id,request_id,signature,message) VALUES (?,?,?,?)",actor.id,id,signature,message)
        WorldResult(snapshot(c,actor,now),message)
    }
}
