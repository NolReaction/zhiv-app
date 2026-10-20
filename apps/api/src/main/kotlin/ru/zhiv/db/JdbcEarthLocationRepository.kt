package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.earth.*
import ru.zhiv.http.PublicUserDto
import ru.zhiv.identity.PlayerTag
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.UUID
import javax.sql.DataSource
import kotlin.math.ceil
import kotlin.math.max

/** No coordinate receipts, logs, notifications, or history. All writes serialize with account lifecycle. */
class JdbcEarthLocationRepository(private val source: DataSource): EarthLocationRepository {
    private val budgets=EarthCommandBudgets()
    private data class Actor(val id: UUID,val publicId: String,val sessionId: UUID)
    private data class Settings(val mode: String,val revision: Long,val precision: String,val until: Instant?,
        val epoch: UUID?,val session: UUID?,val sequence: Long,val captured: Instant?,val accepted: Instant?,val bucket: Instant?,val count: Int)
    private fun ResultSet.instant(name: String): Instant?=getObject(name,OffsetDateTime::class.java)?.toInstant()
    private fun now(c: Connection): Instant=c.economyRows("SELECT clock_timestamp()") { it.getObject(1,OffsetDateTime::class.java).toInstant() }.single()
    private fun at(value: Instant?): OffsetDateTime?=value?.atOffset(ZoneOffset.UTC)
    private fun actor(c: Connection,hash: ByteArray,lock: Boolean=false): Actor = c.economyRows("""SELECT u.id,u.public_id,s.id AS session_id
        FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL
        AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL ${if(lock) "FOR SHARE OF s" else ""}""",hash) {
        Actor(it.getObject("id",UUID::class.java),it.getString("public_id"),it.getObject("session_id",UUID::class.java))
    }.firstOrNull() ?: earthFailure("UNAUTHORIZED",401)
    private fun owner(actor: Actor,expected: String) { if(actor.publicId!=expected) earthFailure("EARTH_OWNER_MISMATCH") }
    private fun lockUsers(c: Connection,ids: Set<UUID>) {
        val sorted=ids.sorted(); val marks=sorted.joinToString(",") { "?" }
        c.economyRows("SELECT id FROM app_users WHERE id IN ($marks) ORDER BY id FOR NO KEY UPDATE",*sorted.toTypedArray()) { true }
    }
    private suspend fun <T> tx(block: (Connection)->T): T=withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit=false;c.transactionIsolation=Connection.TRANSACTION_READ_COMMITTED
            try { block(c).also { c.commit() } } catch(error: Exception) { c.rollback();throw error }
        }
    }
    private fun state(c: Connection,id: UUID,lock: Boolean=false): Settings?=c.economyRows("""SELECT * FROM earth_sharing_settings
        WHERE user_id=? ${if(lock) "FOR UPDATE" else ""}""",id) {
        Settings(it.getString("mode"),it.getLong("revision"),it.getString("precision"),it.instant("sharing_until"),
            it.getObject("publication_epoch",UUID::class.java),it.getObject("publisher_session_id",UUID::class.java),
            it.getLong("last_sequence"),it.instant("last_captured_at"),it.instant("last_accepted_at"),it.instant("enable_bucket_at"),it.getInt("enable_bucket_count"))
    }.firstOrNull()
    private fun settings(c: Connection,actor: Actor,publishedEpoch: UUID?=null): EarthSharingSettings {
        val value=state(c,actor.id)
        val circles=c.economyRows("""SELECT g.circle_id FROM earth_sharing_recipients g JOIN circles c ON c.id=g.circle_id
            JOIN app_users u ON u.id=g.recipient_user_id WHERE g.owner_user_id=? AND c.kind='DIRECT' AND c.archived_at IS NULL
            AND u.deleted_at IS NULL AND u.banned_at IS NULL ORDER BY g.circle_id""",actor.id) { it.getObject(1).toString() }
        return EarthSharingSettings(actor.publicId,value?.mode ?: "OFF",value?.revision ?: 0,value?.precision ?: "APPROXIMATE",
            circles,value?.until?.toString(),publishedEpoch?.toString(),now(c).toString())
    }
    override suspend fun settings(sessionHash: ByteArray)=tx { c -> settings(c,actor(c,sessionHash)) }
    private fun recipients(c: Connection,actor: UUID,circles: List<String>): Map<UUID,UUID> {
        if(circles.isEmpty()) return emptyMap()
        val ids=circles.map(UUID::fromString);val marks=ids.joinToString(",") { "?" }
        return c.economyRows("""SELECT c.id,CASE WHEN c.direct_user_low_id=? THEN c.direct_user_high_id ELSE c.direct_user_low_id END AS peer
            FROM circles c JOIN app_users l ON l.id=c.direct_user_low_id JOIN app_users h ON h.id=c.direct_user_high_id
            WHERE c.id IN ($marks) AND c.kind='DIRECT' AND c.archived_at IS NULL AND ? IN(c.direct_user_low_id,c.direct_user_high_id)
            AND l.deleted_at IS NULL AND l.banned_at IS NULL AND h.deleted_at IS NULL AND h.banned_at IS NULL""",
            actor,*ids.toTypedArray(),actor) { it.getObject("id",UUID::class.java) to it.getObject("peer",UUID::class.java) }.toMap()
    }
    override suspend fun share(sessionHash: ByteArray,request: EarthSharingWrite): EarthSharingSettings {
        validateEarthSharing(request)
        return tx { c ->
            val initial=actor(c,sessionHash);owner(initial,request.expectedOwnerPublicId)
            budgets.take(initial.id,if(request.mode=="SHARING") "enable" else "privacy")
            val candidates=if(request.mode=="SHARING") recipients(c,initial.id,request.recipientCircleIds) else emptyMap()
            lockUsers(c,candidates.values.toSet()+initial.id)
            val current=actor(c,sessionHash,true);owner(current,request.expectedOwnerPublicId)
            c.economyUpdate("INSERT INTO earth_sharing_settings(user_id) VALUES (?) ON CONFLICT DO NOTHING",current.id)
            val value=state(c,current.id,true)!!
            val time=now(c)
            val enabling=request.mode=="SHARING"
            val selected=if(enabling) recipients(c,current.id,request.recipientCircleIds) else emptyMap()
            if(enabling && selected.size!=request.recipientCircleIds.size) invalidEarthSharing()
            if(enabling && (value.revision!=request.expectedRevision || value.revision>=9_007_199_254_740_990L)) earthFailure("EARTH_REVISION_CONFLICT")
            val bucket=if(value.bucket==null || !time.isBefore(value.bucket.plusSeconds(60))) time else value.bucket
            val count=if(bucket==time) 0 else value.count
            if(enabling && count>=10) throw EarthRateLimited(max(1,ceil((60_000-(time.toEpochMilli()-bucket.toEpochMilli()))/1000.0).toInt()))
            val epoch=if(enabling) UUID.randomUUID() else null
            val precision=if(enabling) request.precision else value.precision
            val until=if(enabling) request.durationMinutes?.let { time.plusSeconds(it*60L) } else if(request.mode=="GHOST") value.until else null
            c.economyUpdate("""UPDATE earth_sharing_settings SET mode=?,revision=least(revision+1,9007199254740990),precision=?,sharing_until=?,
                publication_epoch=?,publisher_session_id=?,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL,
                enable_bucket_at=?,enable_bucket_count=? WHERE user_id=?""",request.mode,precision,at(until),epoch,
                if(enabling) current.sessionId else null,at(if(enabling) bucket else value.bucket),if(enabling) count+1 else value.count,current.id)
            if(enabling) {
                c.economyUpdate("DELETE FROM earth_sharing_recipients WHERE owner_user_id=?",current.id)
                for((circle,recipient) in selected) c.economyUpdate("INSERT INTO earth_sharing_recipients(owner_user_id,circle_id,recipient_user_id) VALUES (?,?,?)",current.id,circle,recipient)
            }
            settings(c,current,epoch)
        }
    }
    override suspend fun publish(sessionHash: ByteArray,request: EarthPositionWrite): EarthPositionReceipt {
        // PostgreSQL timestamps have microsecond precision. Normalize before the
        // monotonic comparison so rounding cannot turn one fix into two fixes.
        val captured=validateEarthPosition(request).truncatedTo(ChronoUnit.MICROS)
        return tx { c ->
            val initial=actor(c,sessionHash);owner(initial,request.expectedOwnerPublicId)
            budgets.take(initial.id,"publish");lockUsers(c,setOf(initial.id))
            val current=actor(c,sessionHash,true);owner(current,request.expectedOwnerPublicId)
            val value=state(c,current.id,true) ?: earthFailure("EARTH_PUBLICATION_CONFLICT")
            val time=now(c)
            if(value.mode!="SHARING" || value.epoch?.toString()!=request.publicationEpoch.lowercase() || value.session!=current.sessionId ||
                (value.until!=null && !value.until.isAfter(time))) earthFailure("EARTH_PUBLICATION_CONFLICT")
            if(request.sequence<=value.sequence || (value.captured!=null && !captured.isAfter(value.captured))) earthFailure("EARTH_PUBLICATION_CONFLICT")
            if(captured.isBefore(time.minusSeconds(60)) || captured.isAfter(time.plusSeconds(10))) invalidEarthPosition()
            val elapsed=value.accepted?.let { time.toEpochMilli()-it.toEpochMilli() }
            if(elapsed!=null && elapsed<30_000) throw EarthRateLimited(max(1,ceil((30_000-elapsed)/1000.0).toInt()))
            val updated=minOf(time,captured);val expiry=minOf(updated.plusSeconds(EARTH_POSITION_TTL_SECONDS),value.until ?: Instant.MAX)
            val approximate=value.precision=="APPROXIMATE"
            val latitude=if(approximate) approximateEarthCoordinate(request.latitude) else request.latitude
            val longitude=if(approximate) approximateEarthCoordinate(request.longitude) else request.longitude
            val accuracy=if(approximate) max(1500.0,request.accuracyMeters) else request.accuracyMeters
            c.economyUpdate("""INSERT INTO earth_latest_locations(user_id,publication_epoch,publisher_session_id,latitude,longitude,accuracy_meters,precision,updated_at,expires_at,accepted_at)
                VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET publication_epoch=EXCLUDED.publication_epoch,publisher_session_id=EXCLUDED.publisher_session_id,
                latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy_meters=EXCLUDED.accuracy_meters,precision=EXCLUDED.precision,
                updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at,accepted_at=EXCLUDED.accepted_at""",
                current.id,value.epoch,current.sessionId,latitude,longitude,accuracy,value.precision,at(updated),at(expiry),at(time))
            c.economyUpdate("UPDATE earth_sharing_settings SET last_sequence=?,last_captured_at=?,last_accepted_at=? WHERE user_id=?",request.sequence,at(captured),at(time),current.id)
            EarthPositionReceipt(current.publicId,time.toString(),expiry.toString(),time.toString())
        }
    }
    override suspend fun stop(sessionHash: ByteArray,request: EarthPositionStop): EarthPositionStopped {
        validateEarthStop(request)
        return tx { c ->
            val initial=actor(c,sessionHash);owner(initial,request.expectedOwnerPublicId)
            budgets.take(initial.id,"privacy");lockUsers(c,setOf(initial.id))
            val current=actor(c,sessionHash,true);owner(current,request.expectedOwnerPublicId)
            val value=state(c,current.id,true)
            if(value?.epoch?.toString()==request.publicationEpoch.lowercase() && value.session==current.sessionId)
                c.economyUpdate("UPDATE earth_sharing_settings SET publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL WHERE user_id=?",current.id)
            EarthPositionStopped(current.publicId,now(c).toString())
        }
    }
    override suspend fun people(sessionHash: ByteArray): EarthPeopleResponse=tx { c ->
        val viewer=actor(c,sessionHash)
        val people=c.economyRows("""SELECT g.circle_id,u.public_id,u.display_name,u.tag_text,u.tag_color,p.latitude,p.longitude,p.accuracy_meters,
            p.precision,p.updated_at,least(p.expires_at,coalesce(s.sharing_until,p.expires_at)) AS expires_at
            FROM earth_sharing_recipients g JOIN circles edge ON edge.id=g.circle_id
            JOIN app_users u ON u.id=g.owner_user_id JOIN earth_sharing_settings s ON s.user_id=u.id
            JOIN earth_latest_locations p ON p.user_id=u.id
            JOIN app_sessions publisher ON publisher.id=p.publisher_session_id AND publisher.user_id=u.id
            WHERE g.recipient_user_id=? AND edge.kind='DIRECT' AND edge.archived_at IS NULL
            AND ((edge.direct_user_low_id=u.id AND edge.direct_user_high_id=?) OR (edge.direct_user_high_id=u.id AND edge.direct_user_low_id=?))
            AND u.deleted_at IS NULL AND u.banned_at IS NULL AND s.mode IN ('SHARING','GHOST')
            AND (s.sharing_until IS NULL OR s.sharing_until>clock_timestamp()) AND p.expires_at>clock_timestamp()
            AND publisher.revoked_at IS NULL AND publisher.expires_at>clock_timestamp()
            ORDER BY u.public_id,g.circle_id LIMIT 100""",viewer.id,viewer.id,viewer.id) {
            val tag=it.getString("tag_text")?.let { text -> PlayerTag(text,it.getString("tag_color")) }
            EarthSharedPerson(it.getObject("circle_id").toString(),PublicUserDto(it.getString("public_id"),it.getString("display_name"),tag),
                it.getDouble("latitude"),it.getDouble("longitude"),it.getDouble("accuracy_meters"),it.getString("precision"),it.instant("updated_at")!!.toString(),it.instant("expires_at")!!.toString())
        }
        EarthPeopleResponse(viewer.publicId,people,now(c).toString())
    }
}
