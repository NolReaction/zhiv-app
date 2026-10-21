package ru.zhiv.db

import org.junit.jupiter.api.Test
import ru.zhiv.admin.SecurityObservationKind
import ru.zhiv.auth.AuthFailure
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class SecurityObservationRecorderBudgetTest {
    private val user = UUID.randomUUID()
    private fun key(userId: UUID = user, kind: SecurityObservationKind = SecurityObservationKind.ECONOMY_REQUEST_TAMPER,
        requestId: UUID = UUID.randomUUID()) = SecurityObservationWriteBudget.Key(userId, kind, requestId)

    @Test fun `normal first events and threshold events remain individually eligible`() {
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 })
        SecurityObservationKind.entries.forEach { kind ->
            repeat(kind.threshold) {
                val key = key(kind = kind)
                assertNull(budget.tryAcquire(key))
                budget.release(key, persisted = true)
            }
        }
    }

    @Test fun `repeated committed UUIDs consume no further budget and cannot suppress another account or reason`() {
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 }, burstCapacity = 3)
        val original = key()
        assertNull(budget.tryAcquire(original))
        budget.release(original, persisted = true)
        repeat(10_000) { assertEquals(SecurityObservationRecordResult.DUPLICATE, budget.tryAcquire(original)) }
        val otherUser = original.copy(userId = UUID.randomUUID())
        assertNull(budget.tryAcquire(otherUser))
        budget.release(otherUser, persisted = true)
        val otherReason = original.copy(kind = SecurityObservationKind.MARKET_OWNERSHIP_DENIED)
        assertNull(budget.tryAcquire(otherReason))
        budget.release(otherReason, persisted = true)
        assertEquals(SecurityObservationRecordResult.BUDGET, budget.tryAcquire(key()))
    }

    @Test fun `budget caps sequential work and refills by monotonic time without an idle backlog`() {
        var now = 0L
        val budget = SecurityObservationWriteBudget(nanoTime = { now }, ratePerSecond = 20, burstCapacity = 20)
        repeat(20) {
            val key = key()
            assertNull(budget.tryAcquire(key))
            budget.release(key, persisted = false)
        }
        assertEquals(SecurityObservationRecordResult.BUDGET, budget.tryAcquire(key()))
        now += 49_000_000
        assertEquals(SecurityObservationRecordResult.BUDGET, budget.tryAcquire(key()))
        now += 1_000_000
        val next = key()
        assertNull(budget.tryAcquire(next))
        budget.release(next, persisted = false)
        assertEquals(SecurityObservationRecordResult.BUDGET, budget.tryAcquire(key()))
        now += 3_600_000_000_000L
        repeat(20) {
            val key = key()
            assertNull(budget.tryAcquire(key))
            budget.release(key, persisted = false)
        }
        assertEquals(SecurityObservationRecordResult.BUDGET, budget.tryAcquire(key()))
    }

    @Test fun `one active persistence attempt rejects concurrent diagnostic work without spending tokens`() {
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 }, burstCapacity = 2)
        val first = key()
        assertNull(budget.tryAcquire(first))
        Executors.newFixedThreadPool(8).use { pool ->
            val outcomes = pool.invokeAll(List(100) { Callable { budget.tryAcquire(key()) } }).map { it.get() }
            assertEquals(List(100) { SecurityObservationRecordResult.BUSY }, outcomes)
        }
        budget.release(first, persisted = false)
        assertNull(budget.tryAcquire(first))
        budget.release(first, persisted = false)
        assertEquals(SecurityObservationRecordResult.BUDGET, budget.tryAcquire(first))
    }

    @Test fun `cache is bounded expires and failed storage is never cached`() {
        var now = 0L
        val budget = SecurityObservationWriteBudget(nanoTime = { now }, cacheCapacity = 2, duplicateTtlNanos = 100)
        val first = key()
        val second = key()
        val third = key()
        listOf(first, second, third).forEach {
            assertNull(budget.tryAcquire(it)); budget.release(it, persisted = true)
        }
        assertNull(budget.tryAcquire(first)) // Oldest committed entry was evicted.
        budget.release(first, persisted = false)
        assertNull(budget.tryAcquire(first)) // A failed attempt did not become a duplicate.
        budget.release(first, persisted = false)
        assertEquals(SecurityObservationRecordResult.DUPLICATE, budget.tryAcquire(third))
        now = 100
        assertNull(budget.tryAcquire(third))
        budget.release(third, persisted = false)
    }

    @Test fun `ordinary denials and saturated telemetry do not touch JDBC`() {
        val db = RecordingConnection(failWrites = true)
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 }, burstCapacity = 1)
        val metrics = SecurityObservationRecorderMetrics()
        recordRejectedSecurityObservation(db.connection, AuthFailure("ORDINARY", "Expected denial"), budget, metrics)
        assertEquals(0, db.statements.size)
        val held = key()
        assertNull(budget.tryAcquire(held))
        recordRejectedSecurityObservation(db.connection, event(), budget, metrics)
        assertEquals(0, db.statements.size)
        budget.release(held, persisted = false)
        recordRejectedSecurityObservation(db.connection, event(), budget, metrics)
        assertEquals(0, db.statements.size)
        assertContains(metrics.exposition(), "result=\"busy\"} 1\n")
        assertContains(metrics.exposition(), "result=\"budget\"} 1\n")
    }

    @Test fun `connection and rollback failure cannot replace the gameplay denial or cache its observation`() {
        val db = RecordingConnection(failWrites = true, failRollback = true)
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 })
        val metrics = SecurityObservationRecorderMetrics()
        val denial = event()
        repeat(2) { recordRejectedSecurityObservation(db.connection, denial, budget, metrics) }
        assertEquals(2, db.statements.size)
        assertEquals(2, db.rollbacks)
        assertEquals(0, db.commits)
        assertContains(metrics.exposition(), "result=\"failed\"} 2\n")
        assertContains(metrics.exposition(), "result=\"duplicate\"} 0\n")
    }

    @Test fun `only committed observation is cached and account lock never waits for gameplay`() {
        val db = RecordingConnection()
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 })
        val metrics = SecurityObservationRecorderMetrics()
        val denial = event()
        recordRejectedSecurityObservation(db.connection, denial, budget, metrics)
        val statementCount = db.statements.size
        repeat(100) { recordRejectedSecurityObservation(db.connection, denial, budget, metrics) }
        assertEquals(1, db.commits)
        assertEquals(0, db.rollbacks)
        assertEquals(statementCount, db.statements.size)
        assertContains(db.statements.single { it.startsWith("SELECT id FROM app_users") }, "FOR NO KEY UPDATE NOWAIT")
        assertContains(metrics.exposition(), "result=\"persisted\"} 1\n")
        assertContains(metrics.exposition(), "result=\"duplicate\"} 100\n")
        assertFalse(metrics.exposition().contains(user.toString()))
        assertFalse(metrics.exposition().contains(denial.requestId.toString()))
    }

    @Test fun `failed commit stays retryable and missing account cannot enter duplicate cache`() {
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 })
        val metrics = SecurityObservationRecorderMetrics()
        val denial = event()
        val failedCommit = RecordingConnection(failCommit = true)
        recordRejectedSecurityObservation(failedCommit.connection, denial, budget, metrics)
        assertEquals(1, failedCommit.rollbacks)
        val missingAccount = RecordingConnection(missingUser = true)
        repeat(2) { recordRejectedSecurityObservation(missingAccount.connection, denial, budget, metrics) }
        assertEquals(2, missingAccount.commits)
        assertContains(metrics.exposition(), "result=\"failed\"} 1\n")
        assertContains(metrics.exposition(), "result=\"missing_user\"} 2\n")
        assertContains(metrics.exposition(), "result=\"duplicate\"} 0\n")
    }

    @Test fun `busy gameplay account rolls diagnostic work back without treating contention as storage failure`() {
        val db = RecordingConnection(accountBusy = true)
        val budget = SecurityObservationWriteBudget(nanoTime = { 0 })
        val metrics = SecurityObservationRecorderMetrics()
        val denial = event()
        repeat(2) { recordRejectedSecurityObservation(db.connection, denial, budget, metrics) }
        assertEquals(2, db.rollbacks)
        assertEquals(0, db.commits)
        assertContains(metrics.exposition(), "result=\"busy\"} 2\n")
        assertContains(metrics.exposition(), "result=\"failed\"} 0\n")
        assertContains(metrics.exposition(), "result=\"duplicate\"} 0\n")
    }

    private fun event() = ObservedSecurityFailure(user, SecurityObservationKind.ECONOMY_REQUEST_TAMPER,
        "economy:sell", UUID.randomUUID(), "ECONOMY_REQUEST_CONFLICT", "Expected denial")

    /** JDBC lifecycle fixture only; SQL semantics remain covered by PostgreSQL integration tests. */
    private class RecordingConnection(
        private val failWrites: Boolean = false, private val failRollback: Boolean = false,
        private val failCommit: Boolean = false, private val missingUser: Boolean = false,
        private val accountBusy: Boolean = false,
    ) {
        val statements = mutableListOf<String>()
        var rollbacks = 0
        var commits = 0
        val connection: Connection = proxy(Connection::class.java) { method, args ->
            when (method) {
                "prepareStatement" -> {
                    val sql = args!![0] as String
                    statements.add(sql)
                    if (failWrites) throw SQLException("Synthetic unavailable connection")
                    if (accountBusy && sql.startsWith("SELECT id FROM app_users")) throw SQLException("Synthetic lock contention", "55P03")
                    statement(sql)
                }
                "createArrayOf" -> proxy(java.sql.Array::class.java) { _, _ -> null }
                "commit" -> { commits++; if (failCommit) throw SQLException("Synthetic commit failure"); null }
                "rollback" -> { rollbacks++; if (failRollback) throw SQLException("Synthetic rollback failure"); null }
                else -> error("Unexpected connection call $method")
            }
        }

        private fun statement(sql: String): PreparedStatement = proxy(PreparedStatement::class.java) { method, _ ->
            when (method) {
                "executeUpdate" -> 1
                "executeQuery" -> {
                    val hasRow = sql.startsWith("SELECT clock_timestamp()") || (sql.startsWith("SELECT id FROM app_users") && !missingUser)
                    var first = true
                    proxy(ResultSet::class.java) { resultMethod, _ ->
                        when (resultMethod) {
                            "next" -> (first && hasRow).also { first = false }
                            "getObject" -> OffsetDateTime.parse("2026-10-18T00:00:00Z")
                            "close" -> null
                            else -> error("Unexpected result call $resultMethod")
                        }
                    }
                }
                "close", "setObject", "setArray", "setString", "setLong", "setInt", "setBoolean" -> null
                else -> error("Unexpected statement call $method")
            }
        }

        companion object {
            @Suppress("UNCHECKED_CAST")
            private fun <T> proxy(type: Class<T>, handler: (String, Array<out Any?>?) -> Any?): T =
                Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, args -> handler(method.name, args) } as T
        }
    }
}
