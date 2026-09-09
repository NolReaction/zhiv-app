package ru.zhiv.observability

import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.application.install
import io.ktor.server.response.respond
import io.ktor.server.response.respondRedirect
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.slf4j.LoggerFactory
import ru.zhiv.auth.AuthFailure
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.health.ReadinessProbe
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.DisplayNameCooldownResponse
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.installZhivApi
import java.sql.SQLException
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RequestDiagnosticsTest {
    @Test
    fun `server incident persistence outlives the response without delaying it`() = testApplication {
        val started = CompletableDeferred<Triple<String, String, Int>>()
        val release = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Unit>()
        application {
            install(RequestDiagnostics) {
                persist = { call, code, status ->
                    started.complete(Triple(call.requestId(), code, status))
                    release.await()
                    finished.complete(Unit)
                }
            }
            routing { get("/test/persistence") { call.respond(HttpStatusCode.InternalServerError, "Unavailable") } }
        }
        try {
            val response = withTimeout(5000) { client.get("/test/persistence") }
            assertEquals(HttpStatusCode.InternalServerError, response.status)
            val event = withTimeout(5000) { started.await() }
            assertEquals(Triple(response.headers[REQUEST_ID_HEADER], "INTERNAL_ERROR", 500), event)
            assertFalse(finished.isCompleted, "The response must not wait for database work")
            release.complete(Unit)
            withTimeout(5000) { finished.await() }
        } finally { release.complete(Unit) }
    }

    @Test
    fun `plain exceptions and explicit server errors both produce one correlated event`() = capture { logs ->
        val ids = mutableSetOf<String>()
        testApplication {
            application {
                installZhivApi(UnusedRepository, UnusedRepository, config())
                routing {
                    get("/test/exception") { throw IllegalStateException("private-exception-message") }
                    get("/test/explicit") { call.respond(HttpStatusCode.InternalServerError, ApiErrorResponse("INTERNAL_ERROR", "Safe error")) }
                }
            }
            for (path in listOf("/test/exception", "/test/explicit")) {
                val response = client.get(path)
                assertEquals(HttpStatusCode.InternalServerError, response.status)
                val id = assertNotNull(response.headers[REQUEST_ID_HEADER])
                assertEquals(id, jsonField(response.bodyAsText(), "requestId"))
                ids.add(id)
            }
        }
        assertEquals(2, logs.list.size)
        assertEquals(ids, logs.list.map { fields(it)["request_id"] }.toSet())
        assertTrue(logs.list.all { it.throwableProxy == null && !fields(it).toString().contains("private-exception-message") })
    }

    @Test
    fun `server replaces client request ids and direct errors carry the response id`() = capture { logs ->
        val ids = mutableSetOf<String>()
        testApplication {
            application { installZhivApi(UnusedRepository, UnusedRepository, config()) }
            for (incoming in listOf(UUID.randomUUID().toString(), "spoofed", "x".repeat(4096), "spoof%0D%0Aerror=fake")) {
                val response = client.get("/api/v1/me") { header(REQUEST_ID_HEADER, incoming) }
                val requestId = assertNotNull(response.headers[REQUEST_ID_HEADER])
                assertEquals(HttpStatusCode.Unauthorized, response.status)
                assertNotEquals(incoming, requestId)
                assertEquals(4, UUID.fromString(requestId).version())
                assertEquals(requestId, jsonField(response.bodyAsText(), "requestId"))
                assertTrue(ids.add(requestId))
            }
        }
        assertTrue(logs.list.isEmpty(), "Absent sessions should not produce diagnostic noise")
    }

    @Test
    fun `unexpected failures correlate without exposing sql messages causes or request material`() = capture { logs ->
        val secrets = listOf("person@example.invalid", "otp-946271", "cookie-super-secret", "oauth-code-secret", "token-secret", "sql-parameter-secret")
        val failure = SQLException("INSERT account VALUES ('${secrets[0]}', '${secrets[5]}')", "23505").apply {
            initCause(IllegalStateException(secrets.joinToString("\n")))
            addSuppressed(IllegalArgumentException("suppressed-secret"))
        }
        var requestId: String? = null
        testApplication {
            application {
                installZhivApi(UnusedRepository, UnusedRepository, config())
                routing {
                    post("/api/v1/auth/email/verify") { throw failure }
                }
            }
            val response = client.post("/api/v1/auth/email/verify?code=${secrets[3]}&state=${secrets[4]}") {
                header(HttpHeaders.Cookie, "zhiv_session_dev=${secrets[2]}")
                header(HttpHeaders.Authorization, "Bearer ${secrets[4]}")
                header(HttpHeaders.UserAgent, secrets[0])
                header(REQUEST_ID_HEADER, "spoofed-request")
                contentType(ContentType.Application.Json)
                setBody("""{"email":"${secrets[0]}","code":"${secrets[1]}"}""")
            }
            assertEquals(HttpStatusCode.InternalServerError, response.status)
            requestId = assertNotNull(response.headers[REQUEST_ID_HEADER])
            assertEquals(requestId, jsonField(response.bodyAsText(), "requestId"))
        }
        val event = logs.list.single()
        val fields = fields(event)
        assertEquals(requestId, fields["request_id"])
        assertEquals("/api/v1/auth/email/verify", fields["operation"])
        assertEquals("POST", fields["method"])
        assertEquals(500, fields["status"])
        assertEquals("INTERNAL_ERROR", fields["error_code"])
        assertEquals("23505", fields["sql_state"])
        assertEquals("integrity_constraint", fields["sql_category"])
        assertEquals(SQLException::class.java.name, fields["exception_class"])
        assertContains(fields["cause_classes"].toString(), IllegalStateException::class.java.name)
        assertContains(fields["source"].toString(), "RequestDiagnosticsTest.kt:")
        assertTrue((fields["duration_ms"] as Long) >= 0)
        assertNull(event.throwableProxy, "SLF4J must never receive a raw Throwable")
        val output = event.formattedMessage + fields.toString()
        for (secret in secrets + listOf("suppressed-secret", "spoofed-request", "INSERT account")) assertFalse(output.contains(secret), output)
    }

    @Test
    fun `existing transient sql states keep their responses and all errors are correlated`() = capture { logs ->
        val cases = listOf("40001" to "serialization_conflict", "40P01" to "deadlock", "55P03" to "lock_unavailable", "57014" to "query_cancelled")
        val ids = mutableSetOf<String>()
        testApplication {
            application {
                installZhivApi(UnusedRepository, UnusedRepository, config())
                routing {
                    cases.forEachIndexed { index, (state, _) ->
                        get("/test/sql/$index") { throw SQLException("database-secret", state) }
                    }
                }
            }
            for (index in cases.indices) {
                val response = client.get("/test/sql/$index")
                assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
                assertEquals("DATABASE_BUSY", jsonField(response.bodyAsText(), "code"))
                val id = assertNotNull(response.headers[REQUEST_ID_HEADER])
                assertEquals(id, jsonField(response.bodyAsText(), "requestId"))
                ids.add(id)
            }
        }
        assertEquals(4, logs.list.size)
        assertEquals(ids, logs.list.map { fields(it)["request_id"] }.toSet())
        assertEquals(cases.map { it.second }.toSet(), logs.list.map { fields(it)["sql_category"] }.toSet())
        assertTrue(logs.list.all { fields(it)["operation"] == "unmatched" })
    }

    @Test
    fun `callback failures preserve redirect status and provider cause without secrets`() = capture { logs ->
        var id: String? = null
        testApplication {
            application {
                installZhivApi(UnusedRepository, UnusedRepository, config())
                routing {
                    get("/api/v1/auth/vk/callback") {
                        call.recordAuthFailure(AuthFailure("VK_LOGIN_FAILED", "Safe public text", 502,
                            ProviderFailure("vk", "exchange", 503, java.net.http.HttpTimeoutException("callback-secret"))))
                        call.respondRedirect("/?auth=vk_login_failed")
                    }
                }
            }
            val response = createClient { followRedirects = false }.get("/api/v1/auth/vk/callback?code=callback-secret")
            assertEquals(HttpStatusCode.Found, response.status)
            assertEquals("/?auth=vk_login_failed", response.headers[HttpHeaders.Location])
            id = response.headers[REQUEST_ID_HEADER]
        }
        val fields = fields(logs.list.single())
        assertEquals(id, fields["request_id"])
        assertEquals(302, fields["status"])
        assertEquals(502, fields["failure_status"])
        assertEquals("vk", fields["provider"])
        assertEquals("exchange", fields["provider_stage"])
        assertEquals(503, fields["provider_http_status"])
        assertContains(fields["cause_classes"].toString(), "HttpTimeoutException")
        assertFalse(fields.toString().contains("callback-secret"))
    }

    @Test
    fun `health and expected responses stay quiet while readiness failure remains visible`() = capture { logs ->
        testApplication {
            application {
                installZhivApi(UnusedRepository, UnusedRepository, config(), readiness = ReadinessProbe { false })
                routing {
                    get("/test/cooldown") {
                        call.respond(HttpStatusCode.TooManyRequests, DisplayNameCooldownResponse(availableAt = "later", serverTime = "now"))
                    }
                    get("/test/auth-expired") { throw AuthFailure("AUTH_EXPIRED", "Try again") }
                    get("/test/auth-code") { throw AuthFailure("AUTH_CODE_INVALID", "Try again") }
                }
            }
            assertEquals("""{"status":"ok"}""", client.get("/healthz").bodyAsText())
            assertEquals(HttpStatusCode.TooManyRequests, client.get("/test/cooldown").status)
            assertEquals(HttpStatusCode.BadRequest, client.get("/test/auth-expired").status)
            assertEquals(HttpStatusCode.BadRequest, client.get("/test/auth-code").status)
            val readiness = client.get("/readyz")
            assertEquals(HttpStatusCode.ServiceUnavailable, readiness.status)
            assertEquals("""{"status":"unavailable"}""", readiness.bodyAsText())
            assertEquals("no-store", readiness.headers[HttpHeaders.CacheControl])
            assertNotNull(readiness.headers[REQUEST_ID_HEADER])
        }
        assertEquals(setOf("AUTH_CODE_INVALID", "READINESS_UNAVAILABLE"), logs.list.map { fields(it)["error_code"] }.toSet())
        assertEquals(2, logs.list.size)
    }

    @Test
    fun `bootstrap rate limit keeps its retry header and receives a request id`() = capture { logs ->
        var blockedId: String? = null
        testApplication {
            application { installZhivApi(UnusedRepository, UnusedRepository, config()) }
            repeat(60) { assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/bootstrap").status) }
            val blocked = client.post("/api/v1/bootstrap")
            assertEquals(HttpStatusCode.TooManyRequests, blocked.status)
            assertNotNull(blocked.headers[HttpHeaders.RetryAfter])
            blockedId = assertNotNull(blocked.headers[REQUEST_ID_HEADER])
            assertFalse(blocked.bodyAsText().contains("requestId"), "Keep Ktor's existing rate-limit body")
        }
        val fields = fields(logs.list.single())
        assertEquals(blockedId, fields["request_id"])
        assertEquals("RATE_LIMITED", fields["error_code"])
    }

    @Test
    fun `sql metadata rejects injection and limits cyclic causes without reading messages`() {
        val sql = SQLException("email-secret otp-secret", "23505\nforged=secret")
        val wrapper = IllegalStateException("token-secret", sql)
        sql.initCause(wrapper)
        sql.setNextException(SQLException("next-secret", "08006"))
        val details = safeExceptionDetails(wrapper)
        assertEquals("08006", details["sql_state"])
        assertEquals("connection_failure", details["sql_category"])
        assertEquals("unknown", safeExceptionDetails(SQLException("secret", "23505\nforged=secret"))["sql_state"])
        assertFalse(details.toString().contains("secret"))
        assertFalse(details.toString().contains('\n'))
        assertEquals("/api/v1/people/{circleId}/nickname", diagnosticOperation("/api/v1/people/private-email@example.invalid/nickname"))
        assertEquals("unmatched", diagnosticOperation("/secret-callback?code=private"))
    }

    private fun jsonField(body: String, name: String): String = Json.parseToJsonElement(body).jsonObject.getValue(name).jsonPrimitive.content
    private fun fields(event: ILoggingEvent): Map<String, Any?> = event.keyValuePairs.associate { it.key to it.value }

    private fun capture(block: (ListAppender<ILoggingEvent>) -> Unit) {
        val logger = LoggerFactory.getLogger(DIAGNOSTICS_LOGGER) as Logger
        val appender = ListAppender<ILoggingEvent>().also { it.start() }
        logger.addAppender(appender)
        try { block(appender) } finally { logger.detachAppender(appender); appender.stop() }
    }

    private fun config() = AppConfig(
        databaseUrl = "jdbc:postgresql://unused/zhiv", databaseUser = "unused", databasePassword = "unused",
        production = false, allowedOrigins = setOf("http://localhost"),
    )

    private object UnusedRepository : IdentityRepository, CheckInRepository {
        override suspend fun bootstrap(displayName: String, bootstrapKeyHash: ByteArray, sessionTokenHash: ByteArray, sessionLifetimeDays: Long, timeZone: String): UserSnapshot = error("unused")
        override suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot? = null
        override suspend fun updateDisplayName(sessionTokenHash: ByteArray, displayName: String, idempotencyKey: UUID): DisplayNameUpdateResult = error("unused")
        override suspend fun record(sessionTokenHash: ByteArray, idempotencyKey: UUID): CheckInResult = error("unused")
    }
}
