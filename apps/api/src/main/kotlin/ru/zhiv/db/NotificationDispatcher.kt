package ru.zhiv.db

import org.slf4j.LoggerFactory
import ru.zhiv.economy.EconomyJob
import ru.zhiv.economy.EconomyRules
import ru.zhiv.economy.EconomyState
import ru.zhiv.economy.economyJson
import ru.zhiv.notifications.*
import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.sql.DataSource

/** Durable reservation before network I/O. An interrupted/ambiguous send is
 * never replayed; accepted delivery cannot be made exactly-once by HTTP. */
class NotificationDispatcher(
    private val source: DataSource,
    private val sender: PushSender,
    private val clock: () -> Instant = Instant::now,
) {
    private data class Event(val key: String, val category: String, val due: Instant, val attempts: Int)
    private data class Batch(val id: UUID, val user: UUID)
    private data class Sources(val state: EconomyState?, val hasLegacyJourney: Boolean) {
        val jobs: List<EconomyJob> get() = state?.jobs.orEmpty()
    }
    private data class SourceEvent(val event: Event, val job: EconomyJob?, val readiness: NotificationJobReadiness)
    private fun <T> transaction(block: (Connection) -> T): T = source.connection.use { c ->
        c.autoCommit=false
        try { val result=block(c); c.commit(); result } catch(error: Exception) { c.rollback(); throw error }
    }
    private fun preferences(c: Connection,user: UUID): NotificationPreferences? = c.economyRows(
        "SELECT preferences::text FROM notification_preferences WHERE user_id=?",user
    ) { notificationJson.decodeFromString<NotificationPreferences>(it.getString(1)) }.singleOrNull()
    private fun visible(c: Connection,user: UUID,now: Instant): Boolean = c.economyRows("""
        SELECT EXISTS(SELECT 1 FROM notification_preferences WHERE user_id=? AND last_visible_at>?::timestamptz)
          OR EXISTS(SELECT 1 FROM game_presence_clients p JOIN app_sessions s ON s.id=p.auth_session_id
            WHERE p.user_id=? AND p.status='active' AND p.last_seen_at>?::timestamptz
              AND s.revoked_at IS NULL AND s.expires_at>?::timestamptz)
    """,user,now.minusSeconds(120).notificationSqlTime(),user,now.minusSeconds(120).notificationSqlTime(),now.notificationSqlTime()) { it.getBoolean(1) }.single()
    private fun subscribed(c: Connection,user: UUID,now: Instant): Boolean = c.economyRows("""
        SELECT 1 FROM notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id AND s.user_id=n.user_id
        WHERE n.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?::timestamptz LIMIT 1
    """,user,now.notificationSqlTime()) { true }.isNotEmpty()
    private fun dismiss(c: Connection,user: UUID,events: List<Event>) {
        events.forEach { c.economyUpdate("UPDATE notification_events SET state='dismissed' WHERE user_id=? AND source_key=?",user,it.key) }
    }
    private fun events(c: Connection,user: UUID,now: Instant,batch: UUID?=null): List<Event> = c.economyRows(
        if(batch==null) "SELECT source_key,category,due_at,attempts FROM notification_events WHERE user_id=? AND state='pending' AND next_attempt_at<=?::timestamptz ORDER BY due_at LIMIT 20"
        else "SELECT source_key,category,due_at,attempts FROM notification_events WHERE user_id=? AND state='sending' AND batch_id=? ORDER BY due_at",
        user,batch ?: now.notificationSqlTime()
    ) { Event(it.getString(1),it.getString(2),it.getObject(3,OffsetDateTime::class.java).toInstant(),it.getInt(4)) }
    private fun sources(c: Connection,user: UUID): Sources {
        val state=c.economyRows("SELECT state::text FROM economy_profiles WHERE user_id=?",user) {
            economyJson.decodeFromString<EconomyState>(it.getString(1))
        }.singleOrNull()
        val legacy=c.economyRows("SELECT jsonb_array_length(coalesce(state->'journeys','[]'::jsonb))>0 FROM world_profiles WHERE user_id=?",user) {
            it.getBoolean(1)
        }.singleOrNull() ?: false
        return Sources(state,legacy)
    }
    private fun sourceEvents(events: List<Event>,sources: Sources,now: Instant): List<SourceEvent> = events.mapNotNull { event ->
        if(event.category=="checkin") SourceEvent(event,null,NotificationJobReadiness(event.due))
        else sources.jobs.singleOrNull { "job:${it.id}"==event.key && it.kind==event.category }?.let { job ->
            val readiness=notificationJobReadiness(job,sources.jobs,sources.hasLegacyJourney,now)
            // The queue persists the actual availability after an actor wait;
            // removing a returned trip must not regress this to old ripening.
            SourceEvent(event,job,if(readiness.phase=="harvest") readiness.copy(dueAt=event.due) else readiness)
        }
    }
    private fun sourceIsStale(source: SourceEvent,now: Instant): Boolean =
        source.readiness.blockedUntil==null && source.readiness.dueAt<now.minusSeconds(86400)
    private fun postpone(c: Connection,user: UUID,events: List<SourceEvent>,now: Instant,wasReserved: Boolean) {
        events.forEach { source ->
            val after=maxOf(source.readiness.dueAt,source.readiness.blockedUntil ?: now)
            c.economyUpdate("""UPDATE notification_events SET state='pending',batch_id=NULL,
                attempts=greatest(0,attempts-?),next_attempt_at=? WHERE user_id=? AND source_key=?""",
                if(wasReserved) 1 else 0,after.notificationSqlTime(),user,source.event.key)
        }
    }
    private fun budgetAfter(c: Connection,user: UUID,p: NotificationPreferences,now: Instant,excludeBatch: UUID?=null): Instant {
        if(!p.rateLimitsEnabled) return nextNotificationWindow(p,now)
        // A rolling 24-hour cap also prevents timezone changes or midnight from
        // causing a burst. The UI's daily limit is an upper bound, not a target.
        val history=c.economyRows("""SELECT reserved_at FROM notification_batches WHERE user_id=?
            AND state IN ('sending','delivered','uncertain') AND reserved_at>?::timestamptz
            AND (?::uuid IS NULL OR id<>?::uuid) ORDER BY reserved_at DESC""",
            user,now.minusSeconds(86400).notificationSqlTime(),excludeBatch,excludeBatch) { it.getObject(1,OffsetDateTime::class.java).toInstant() }
        var after=nextNotificationWindow(p,now)
        history.firstOrNull()?.let { after=maxOf(after,it.plusSeconds(p.minIntervalMinutes*60L)) }
        if(history.size>=p.maxPerDay) after=maxOf(after,history[p.maxPerDay-1].plusSeconds(86400))
        return nextNotificationWindow(p,after)
    }
    private fun reserve(user: UUID,now: Instant): Batch? = transaction { c ->
        val locked=c.economyRows("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL AND banned_at IS NULL FOR NO KEY UPDATE SKIP LOCKED",user) { true }.isNotEmpty()
        if(!locked) return@transaction null
        val p=preferences(c,user) ?: return@transaction null
        c.economyRows("SELECT notification_sync_sources_at(?,?::timestamptz)",user,now.notificationSqlTime()) { true }
        val due=events(c,user,now)
        if(due.isEmpty()) return@transaction null
        val current=sourceEvents(due,sources(c,user),now)
        val stale=due.filter { event ->
            val source=current.singleOrNull { it.event==event }
            source==null || !p.enabled(event.category) || sourceIsStale(source,now) || event.attempts>=3
        }
        dismiss(c,user,stale)
        val valid=current.filter { it.event !in stale }
        val waiting=valid.filter { it.readiness.dueAt>now || it.readiness.blockedUntil!=null }
        postpone(c,user,waiting,now,wasReserved=false)
        val ready=(valid-waiting.toSet()).map { it.event }
        if(ready.isEmpty()) return@transaction null
        if(visible(c,user,now) || !subscribed(c,user,now)) { dismiss(c,user,ready); return@transaction null }
        val after=budgetAfter(c,user,p,now)
        if(after>now) {
            ready.forEach { c.economyUpdate("UPDATE notification_events SET next_attempt_at=? WHERE user_id=? AND source_key=?",after.notificationSqlTime(),user,it.key) }
            return@transaction null
        }
        val batch=Batch(UUID.randomUUID(),user)
        c.economyUpdate("INSERT INTO notification_batches(id,user_id,reserved_at,state) VALUES (?,?,?,'sending')",batch.id,user,now.notificationSqlTime())
        ready.forEach { c.economyUpdate("UPDATE notification_events SET state='sending',batch_id=?,attempts=attempts+1 WHERE user_id=? AND source_key=?",batch.id,user,it.key) }
        batch
    }
    private fun deliver(batch: Batch,now: Instant) = transaction { c ->
        val owner=c.economyRows("SELECT public_id FROM app_users WHERE id=? AND deleted_at IS NULL AND banned_at IS NULL FOR NO KEY UPDATE",batch.user) { it.getString(1) }.singleOrNull()
        val p=preferences(c,batch.user)
        // Source deletion/speedup/claim between reservation and send is observed.
        c.economyRows("SELECT notification_sync_sources_at(?,?::timestamptz)",batch.user,now.notificationSqlTime()) { true }
        val queued=events(c,batch.user,now,batch.id)
        val sources=sources(c,batch.user)
        val current=sourceEvents(queued,sources,now).filter {
            p?.enabled(it.event.category)==true && !sourceIsStale(it,now)
        }
        val postponed=current.filter { it.readiness.dueAt>now || it.readiness.blockedUntil!=null }
        postpone(c,batch.user,postponed,now,wasReserved=true)
        val readySources=current-postponed.toSet()
        val ready=readySources.map { it.event }
        dismiss(c,batch.user,queued-ready.toSet()-postponed.map { it.event }.toSet())
        if(owner==null || p==null || ready.isEmpty() || visible(c,batch.user,now)) {
            dismiss(c,batch.user,ready)
            c.economyUpdate("UPDATE notification_batches SET state='dismissed',finished_at=? WHERE id=?",now.notificationSqlTime(),batch.id)
            return@transaction
        }
        val after=budgetAfter(c,batch.user,p,now,batch.id)
        if(after>now) {
            ready.forEach { event -> c.economyUpdate("UPDATE notification_events SET state='pending',batch_id=NULL,attempts=greatest(0,attempts-1),next_attempt_at=? WHERE user_id=? AND source_key=?",after.notificationSqlTime(),batch.user,event.key) }
            c.economyUpdate("UPDATE notification_batches SET state='dismissed',finished_at=? WHERE id=?",now.notificationSqlTime(),batch.id)
            return@transaction
        }
        // One most recently connected device receives the summary. This avoids
        // multiplying the daily budget by the number of browsers on the account.
        val subscription=c.economyRows("""SELECT n.endpoint,n.p256dh,n.auth FROM notification_subscriptions n
            JOIN app_sessions s ON s.id=n.session_id AND s.user_id=n.user_id
            WHERE n.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?::timestamptz
            ORDER BY n.updated_at DESC LIMIT 1 FOR SHARE OF n,s""",batch.user,now.notificationSqlTime()) {
            BrowserPushSubscription(it.getString(1),PushKeys(it.getString(2),it.getString(3)))
        }.singleOrNull()
        val categories=ready.map { it.category }.toSet()
        // Production quantities are already public and exact. Check the whole
        // summary against current storage, including market AND barter escrow.
        // Exploration drops remain private and never affect this hint.
        val productionQuantity=readySources.filter { it.event.category=="production" }.sumOf { it.job?.rewards?.values?.sum() ?: 0L }
        val storageBlocked=sources.state?.let { state ->
            productionQuantity>EconomyRules.storage(state,reservedEconomyMarketItems(c,batch.user)).available
        } ?: false
        val message=notificationMessage(readySources.map { source ->
            NotificationMessageEvent(source.event.category,source.job,source.readiness.phase,
                storageBlocked=source.event.category=="production" && storageBlocked)
        })
        val target=when {
            "exploration" in categories -> "world&section=activities"
            "construction" in categories -> "world&section=construction"
            "production" in categories -> "world&section=production"
            else -> "checkin"
        }
        val payload=PushPayload(message.title,message.body,"mochlik-updates","/?notification=$target&owner=$owner",owner)
        val result=if(subscription==null) PushResult.EXPIRED else sender.send(subscription,payload)
        val status=when(result) {
            PushResult.DELIVERED -> "delivered"
            PushResult.UNCERTAIN -> "uncertain"
            PushResult.RETRY -> "failed"
            else -> "dismissed"
        }
        c.economyUpdate("UPDATE notification_batches SET state=?,finished_at=? WHERE id=?",status,now.notificationSqlTime(),batch.id)
        if(result==PushResult.EXPIRED && subscription!=null) c.economyUpdate("DELETE FROM notification_subscriptions WHERE user_id=? AND endpoint_hash=?",batch.user,notificationEndpointHash(subscription.endpoint))
        ready.forEach { event ->
            if(result==PushResult.RETRY && event.attempts<3) c.economyUpdate("""UPDATE notification_events
                SET state='pending',batch_id=NULL,next_attempt_at=? WHERE user_id=? AND source_key=?""",
                now.plusSeconds(if(event.attempts==1) 300 else 1800).notificationSqlTime(),batch.user,event.key)
            else c.economyUpdate("UPDATE notification_events SET state=? WHERE user_id=? AND source_key=?",if(status=="failed") "dismissed" else status,batch.user,event.key)
        }
    }
    fun tick(maxAccounts: Int=50): Int {
        require(maxAccounts in 1..100)
        val now=clock()
        transaction { c ->
            // A process might stop after handing the request to a push provider.
            // Never retry these ambiguous durable reservations after restart.
            c.economyUpdate("""UPDATE notification_events SET state='uncertain' WHERE state='sending' AND batch_id IN
                (SELECT id FROM notification_batches WHERE state='sending' AND reserved_at<?::timestamptz)""",now.minusSeconds(120).notificationSqlTime())
            c.economyUpdate("UPDATE notification_batches SET state='uncertain',finished_at=? WHERE state='sending' AND reserved_at<?::timestamptz",now.notificationSqlTime(),now.minusSeconds(120).notificationSqlTime())
            c.economyUpdate("DELETE FROM notification_batches WHERE reserved_at<?::timestamptz",now.minusSeconds(32L*86400).notificationSqlTime())
            c.economyUpdate("DELETE FROM notification_subscriptions WHERE session_id IN (SELECT id FROM app_sessions WHERE expires_at<=?::timestamptz)",now.notificationSqlTime())
        }
        val users=transaction { c -> c.economyRows("""SELECT user_id FROM notification_events WHERE state='pending'
            AND next_attempt_at<=?::timestamptz GROUP BY user_id ORDER BY min(next_attempt_at) LIMIT ?""",now.notificationSqlTime(),maxAccounts) { it.getObject(1,UUID::class.java) } }
        var count=0
        users.forEach { user -> reserve(user,now)?.let { deliver(it,clock()); count++ } }
        return count
    }
}
internal class NotificationMaintenance(source: DataSource,sender: PushSender) : AutoCloseable {
    private val log=LoggerFactory.getLogger(NotificationMaintenance::class.java)
    private val dispatcher=NotificationDispatcher(source,sender)
    private val executor=Executors.newSingleThreadScheduledExecutor { task -> Thread(task,"web-push-delivery").apply { isDaemon=true } }
    init { executor.scheduleWithFixedDelay({
        try { dispatcher.tick() } catch(error: Exception) { log.warn("Web push delivery will retry: {}",error.javaClass.simpleName) }
    },30,30,TimeUnit.SECONDS) }
    override fun close() { executor.shutdownNow(); executor.awaitTermination(6,TimeUnit.SECONDS) }
}
