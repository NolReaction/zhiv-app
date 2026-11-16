package ru.zhiv.notifications

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.crypto.ECDSAVerifier
import com.nimbusds.jose.crypto.RSASSAVerifier
import com.nimbusds.jwt.SignedJWT
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.security.interfaces.ECPublicKey
import java.security.interfaces.RSAPublicKey
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.Flow
import kotlin.test.*

class NativePushSenderTest {
    private val initial = Instant.parse("2026-11-14T12:00:00Z")
    private val ios = NativePushSubscription("ios", "ab".repeat(32))
    private val android = NativePushSubscription("android", "registration-" + UUID.randomUUID())
    private val payload = PushPayload("Мохлик", "Есть новые события.", UUID.randomUUID().toString(),
        "/?notification=mailbox&owner=ABCD-EFGH-JKMN", "ABCD-EFGH-JKMN")
    private fun response(status: Int, body: String = "", retry: String? = null, http2: Boolean = true) =
        NativePushHttpResponse(status, body.toByteArray(), retry, http2)
    private fun oauth(token: String = "generated-access-token", expires: Int = 3600) = response(200,
        buildJsonObject { put("access_token", token); put("token_type", "Bearer"); put("expires_in", expires) }.toString())
    private fun requestJson(request: NativePushHttpRequest) = Json.parseToJsonElement(request.body.toString(Charsets.UTF_8)).jsonObject
    private fun fcmError(code: String) = buildJsonObject {
        putJsonObject("error") { putJsonArray("details") { add(buildJsonObject {
            put("@type", "type.googleapis.com/google.firebase.fcm.v1.FcmError"); put("errorCode", code)
        }) } }
    }.toString()
    private class FakeTransport(var respond: (NativePushHttpRequest) -> NativePushHttpResponse) : NativePushHttpTransport {
        val requests = mutableListOf<NativePushHttpRequest>()
        var closed = false
        override fun execute(request: NativePushHttpRequest): NativePushHttpResponse {
            validateNativePushProviderRequest(request)
            requests += request
            return respond(request)
        }
        override fun close() { closed = true }
    }
    private fun config() = NativePushConfig(NativePushTestKeys.apns(), NativePushTestKeys.fcm())

    @Test fun `APNs signs an ES256 token and sends bounded owner specific metadata over HTTP2`() {
        val transport = FakeTransport { response(200) }
        NativeProviderPushSender(config(), transport) { initial }.use { sender ->
            assertEquals(PushResult.DELIVERED, sender.send(ios, payload))
            val request = transport.requests.single()
            assertEquals("https://api.sandbox.push.apple.com/3/device/${ios.token}", request.uri.toString())
            assertEquals("test.mochlik.mobile", request.headers["apns-topic"])
            assertEquals("alert", request.headers["apns-push-type"])
            assertEquals("10", request.headers["apns-priority"])
            assertEquals(initial.plusSeconds(1800).epochSecond.toString(), request.headers["apns-expiration"])
            assertEquals(payload.tag, request.headers["apns-id"])
            assertEquals("mochlik-remote", request.headers["apns-collapse-id"])
            val jwt = SignedJWT.parse(request.headers.getValue("authorization").substringAfter("bearer "))
            assertTrue(jwt.verify(ECDSAVerifier(NativePushTestKeys.ec.public as ECPublicKey)))
            assertEquals(JWSAlgorithm.ES256, jwt.header.algorithm)
            assertEquals("ABCDEFGHIJ", jwt.header.keyID)
            assertEquals("KLMNOPQRST", jwt.jwtClaimsSet.issuer)
            assertEquals(initial, jwt.jwtClaimsSet.issueTime.toInstant())
            val json = requestJson(request)
            assertEquals(setOf("aps", "source", "ownerPublicId", "target", "eventId"), json.keys)
            assertEquals(payload.ownerPublicId, json["ownerPublicId"]?.jsonPrimitive?.content)
            assertEquals("mochlik-remote", json["source"]?.jsonPrimitive?.content)
            assertEquals("mailbox", json["target"]?.jsonPrimitive?.content)
            assertEquals(payload.tag, json["eventId"]?.jsonPrimitive?.content)
            assertEquals(payload.title, json["aps"]?.jsonObject?.get("alert")?.jsonObject?.get("title")?.jsonPrimitive?.content)
            assertEquals(payload.body, json["aps"]?.jsonObject?.get("alert")?.jsonObject?.get("body")?.jsonPrimitive?.content)
        }
        assertTrue(transport.closed)
    }

    @Test fun `APNs caches provider assertions for 50 minutes and uses selected production host`() {
        var now = initial
        val transport = FakeTransport { response(200) }
        val config = NativePushConfig(apns = NativePushTestKeys.apns("production"))
        NativeProviderPushSender(config, transport) { now }.use { sender ->
            sender.send(ios, payload)
            now = initial.plusSeconds(2999); sender.send(ios, payload)
            now = initial.plusSeconds(3000); sender.send(ios, payload)
            now = initial.minusSeconds(1); sender.send(ios, payload)
            val tokens = transport.requests.map { it.headers.getValue("authorization") }
            assertEquals(tokens[0], tokens[1]); assertNotEquals(tokens[1], tokens[2]); assertNotEquals(tokens[2], tokens[3])
            assertTrue(transport.requests.all { it.uri.host == "api.push.apple.com" })
        }
    }

    @Test fun `FCM exchanges a signed OAuth assertion and sends only restricted data`() {
        val transport = FakeTransport { if (it.uri.path == "/token") oauth() else response(200) }
        NativeProviderPushSender(config(), transport) { initial }.use { sender ->
            val checkin = payload.copy(url = "/?notification=checkin&owner=${payload.ownerPublicId}")
            assertEquals(PushResult.DELIVERED, sender.send(android, checkin))
            assertEquals(2, transport.requests.size)
            val authRequest = transport.requests.first()
            assertEquals("https://oauth2.googleapis.com/token", authRequest.uri.toString())
            assertEquals("application/x-www-form-urlencoded", authRequest.headers["Content-Type"])
            val form = authRequest.body.toString(Charsets.UTF_8).split('&').associate {
                it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), Charsets.UTF_8)
            }
            assertEquals("urn:ietf:params:oauth:grant-type:jwt-bearer", form["grant_type"])
            val jwt = SignedJWT.parse(form.getValue("assertion"))
            assertTrue(jwt.verify(RSASSAVerifier(NativePushTestKeys.rsa.public as RSAPublicKey)))
            assertEquals(JWSAlgorithm.RS256, jwt.header.algorithm)
            assertEquals("generated-test-key", jwt.header.keyID)
            assertEquals("push@mochlik-test.iam.gserviceaccount.com", jwt.jwtClaimsSet.issuer)
            assertNull(jwt.jwtClaimsSet.subject)
            assertEquals(listOf("https://oauth2.googleapis.com/token"), jwt.jwtClaimsSet.audience)
            assertEquals("https://www.googleapis.com/auth/firebase.messaging", jwt.jwtClaimsSet.getStringClaim("scope"))
            assertEquals(initial, jwt.jwtClaimsSet.issueTime.toInstant())
            assertEquals(initial.plusSeconds(3600), jwt.jwtClaimsSet.expirationTime.toInstant())
            val request = transport.requests.last()
            assertEquals("https://fcm.googleapis.com/v1/projects/mochlik-test/messages:send", request.uri.toString())
            assertEquals("Bearer generated-access-token", request.headers["Authorization"])
            val message = requestJson(request).getValue("message").jsonObject
            assertEquals(setOf("token", "data", "android"), message.keys)
            assertEquals(android.token, message.getValue("token").jsonPrimitive.content)
            val data = message.getValue("data").jsonObject
            assertEquals(setOf("source", "target", "ownerPublicId", "eventId"), data.keys)
            assertEquals("checkin", data.getValue("target").jsonPrimitive.content)
            assertTrue(data.values.all { it.jsonPrimitive.isString })
            val settings = message.getValue("android").jsonObject
            assertEquals("HIGH", settings.getValue("priority").jsonPrimitive.content)
            assertEquals("1800s", settings.getValue("ttl").jsonPrimitive.content)
            assertEquals("test.mochlik.mobile", settings.getValue("restricted_package_name").jsonPrimitive.content)
            assertEquals("mochlik-remote", settings.getValue("collapse_key").jsonPrimitive.content)
        }
    }

    @Test fun `OAuth access tokens refresh before expiry and after a backwards clock change`() {
        var now = initial
        var authorizationCount = 0
        val transport = FakeTransport { if (it.uri.path == "/token") oauth("generated-${++authorizationCount}") else response(200) }
        NativeProviderPushSender(config(), transport) { now }.use { sender ->
            assertEquals(PushResult.DELIVERED, sender.send(android, payload))
            now = initial.plusSeconds(3539); sender.send(android, payload)
            assertEquals(1, authorizationCount)
            now = initial.plusSeconds(3540); sender.send(android, payload)
            assertEquals(2, authorizationCount)
            now = initial.minusSeconds(1); sender.send(android, payload)
            assertEquals(3, authorizationCount)
            assertEquals(listOf("Bearer generated-1", "Bearer generated-1", "Bearer generated-2", "Bearer generated-3"),
                transport.requests.filter { it.uri.host == "fcm.googleapis.com" }.map { it.headers["Authorization"] })
        }
    }

    @Test fun `only explicit APNs dead device responses expire a registration`() {
        val cases = listOf(
            Triple(410, "Unregistered", PushResult.EXPIRED), Triple(400, "BadDeviceToken", PushResult.EXPIRED),
            Triple(410, "", PushResult.REJECTED), Triple(400, "DeviceTokenNotForTopic", PushResult.REJECTED),
            Triple(403, "InvalidProviderToken", PushResult.REJECTED), Triple(403, "ExpiredProviderToken", PushResult.RETRY),
            Triple(404, "BadPath", PushResult.REJECTED), Triple(429, "TooManyRequests", PushResult.RETRY),
            Triple(503, "Shutdown", PushResult.RETRY), Triple(302, "", PushResult.REJECTED),
        )
        cases.forEach { (status, reason, expected) ->
            val transport = FakeTransport { response(status, buildJsonObject { put("reason", reason) }.toString()) }
            NativeProviderPushSender(config(), transport) { initial }.use { assertEquals(expected, it.send(ios, payload), "$status $reason") }
        }
        val transport = FakeTransport { response(200, http2 = false) }
        NativeProviderPushSender(config(), transport) { initial }.use { assertEquals(PushResult.UNCERTAIN, it.send(ios, payload)) }
    }

    @Test fun `FCM expires only a typed unregistered response and never provider authorization errors`() {
        val cases = listOf(
            Triple(404, fcmError("UNREGISTERED"), PushResult.EXPIRED), Triple(404, "{}", PushResult.REJECTED),
            Triple(404, """{"error":{"status":"UNREGISTERED"}}""", PushResult.REJECTED),
            Triple(400, fcmError("INVALID_ARGUMENT"), PushResult.REJECTED), Triple(403, fcmError("SENDER_ID_MISMATCH"), PushResult.REJECTED),
            Triple(401, "", PushResult.RETRY), Triple(429, fcmError("QUOTA_EXCEEDED"), PushResult.RETRY),
            Triple(503, "", PushResult.RETRY), Triple(302, "", PushResult.REJECTED),
        )
        cases.forEach { (status, body, expected) ->
            val transport = FakeTransport { if (it.uri.path == "/token") oauth() else response(status, body) }
            NativeProviderPushSender(config(), transport) { initial }.use { assertEquals(expected, it.send(android, payload), "$status $body") }
        }
    }

    @Test fun `provider retry deadlines honor seconds dates and minimum delay across subscriptions`() {
        listOf("120" to 120L, "0" to 60L, "garbage" to 60L, "-1" to 60L, "1000000" to 1_000_000L,
            DateTimeFormatter.RFC_1123_DATE_TIME.format(initial.plusSeconds(180).atZone(ZoneOffset.UTC)) to 180L).forEach { (header, delay) ->
            var now = initial
            val transport = FakeTransport { response(429, retry = header) }
            NativeProviderPushSender(config(), transport) { now }.use { sender ->
                assertEquals(PushResult.RETRY, sender.send(ios, payload))
                assertEquals(initial.plusSeconds(delay), sender.retryNotBefore("ios"))
                assertNull(sender.retryNotBefore("android"))
                now = initial.plusSeconds(delay - 1)
                assertEquals(PushResult.RETRY, sender.send(ios.copy(token = "cd".repeat(32)), payload))
                assertEquals(1, transport.requests.size)
                now = initial.plusSeconds(delay)
                assertNull(sender.retryNotBefore("ios"))
                transport.respond = { response(200) }
                assertEquals(PushResult.DELIVERED, sender.send(ios, payload))
                assertEquals(2, transport.requests.size)
            }
        }
    }

    @Test fun `FCM 401 invalidates access token but respects retry delay before exchanging again`() {
        var now = initial
        var authorizations = 0
        var pushes = 0
        val transport = FakeTransport {
            if (it.uri.path == "/token") { authorizations++; oauth() }
            else if (++pushes == 1) response(401) else response(200)
        }
        NativeProviderPushSender(config(), transport) { now }.use { sender ->
            assertEquals(PushResult.RETRY, sender.send(android, payload))
            assertEquals(PushResult.RETRY, sender.send(android, payload))
            assertEquals(1, authorizations)
            now = initial.plusSeconds(60)
            assertEquals(PushResult.DELIVERED, sender.send(android, payload))
            assertEquals(2, authorizations)
        }
    }

    @Test fun `unrepresentable provider deadline is rejected without retrying early or overflowing queue timestamp`() {
        val transport = FakeTransport { response(429, retry = Long.MAX_VALUE.toString()) }
        NativeProviderPushSender(config(), transport) { initial }.use { sender ->
            assertEquals(PushResult.REJECTED, sender.send(ios, payload))
            assertNull(sender.retryNotBefore("ios"))
        }
    }

    @Test fun `interrupted sends preserve interruption and distinguish authorization from delivery`() {
        val transport = FakeTransport { throw InterruptedException("simulated stop") }
        NativeProviderPushSender(config(), transport) { initial }.use { sender ->
            try {
                assertEquals(PushResult.UNCERTAIN, sender.send(ios, payload))
                assertTrue(Thread.currentThread().isInterrupted)
            } finally { Thread.interrupted() }
            try {
                assertEquals(PushResult.RETRY, sender.send(android, payload))
                assertTrue(Thread.currentThread().isInterrupted)
            } finally { Thread.interrupted() }
        }
    }

    @Test fun `notification transport failure is uncertain while OAuth failure is safely retryable`() {
        val failed = FakeTransport { throw IOException("simulated offline transport") }
        NativeProviderPushSender(config(), failed) { initial }.use { sender ->
            assertEquals(PushResult.UNCERTAIN, sender.send(ios, payload))
            assertEquals(PushResult.RETRY, sender.send(android, payload))
        }
        val afterAuth = FakeTransport { if (it.uri.path == "/token") oauth() else throw IOException("simulated timeout") }
        NativeProviderPushSender(config(), afterAuth) { initial }.use { assertEquals(PushResult.UNCERTAIN, it.send(android, payload)) }
    }

    @Test fun `OAuth malformed or rejected responses never trigger a notification send`() {
        fun malformed(type: String = "Bearer", duration: Int = 3600, value: String = UUID.randomUUID().toString()) = buildJsonObject {
            put("access_token", value); put("token_type", type); put("expires_in", duration)
        }.toString()
        val bodies = listOf("not-json", "[]", "{}", malformed(type = "Basic"), malformed(duration = 0), malformed(duration = 3601),
            malformed(value = UUID.randomUUID().toString() + "\r\nheader"), "x".repeat(16_385))
        bodies.forEach { body ->
            val transport = FakeTransport { response(200, body) }
            NativeProviderPushSender(config(), transport) { initial }.use { assertEquals(PushResult.REJECTED, it.send(android, payload)) }
            assertEquals(1, transport.requests.size)
        }
        listOf(400 to PushResult.REJECTED, 401 to PushResult.REJECTED, 429 to PushResult.RETRY, 503 to PushResult.RETRY).forEach { (status, expected) ->
            val transport = FakeTransport { response(status, retry = "120") }
            NativeProviderPushSender(config(), transport) { initial }.use { sender ->
                assertEquals(expected, sender.send(android, payload))
                if (expected == PushResult.RETRY) assertEquals(initial.plusSeconds(120), sender.retryNotBefore("android"))
            }
            assertEquals(1, transport.requests.size)
        }
    }

    @Test fun `disabled providers invalid identifiers and unsupported targets cause no network request`() {
        val transport = FakeTransport { error("must not send") }
        NativeProviderPushSender(NativePushConfig(), transport) { initial }.use { sender ->
            assertEquals(PushResult.REJECTED, sender.send(ios, payload))
            assertEquals(PushResult.REJECTED, sender.send(android, payload))
        }
        NativeProviderPushSender(config(), transport) { initial }.use { sender ->
            listOf(ios.copy(token = "abc"), ios.copy(token = "AA".repeat(32)), android.copy(token = "short"),
                android.copy(token = "a".repeat(4097)), android.copy(token = "invalid\r\nregistration"), ios.copy(platform = "web")).forEach {
                assertEquals(PushResult.REJECTED, sender.send(it, payload))
            }
            listOf(payload.copy(tag = "not-uuid"), payload.copy(tag = "1-1-1-1-1"), payload.copy(ownerPublicId = "wrong-owner"),
                payload.copy(url = "/?notification=mailbox&owner=WRNG-WRNG-WRNG"),
                payload.copy(url = "/?notification=world&section=production&owner=${payload.ownerPublicId}"),
                payload.copy(url = "https://example.test/"), payload.copy(title = "x".repeat(129)), payload.copy(body = "")).forEach {
                assertEquals(PushResult.REJECTED, sender.send(ios, it))
            }
        }
        assertTrue(transport.requests.isEmpty())
        assertFalse(ios.toString().contains(ios.token)); assertFalse(android.toString().contains(android.token))
    }

    @Test fun `provider endpoint allowlist rejects redirects credentials ports query and traversal`() {
        val valid = listOf("https://api.push.apple.com/3/device/${ios.token}", "https://api.sandbox.push.apple.com/3/device/${ios.token}",
            "https://oauth2.googleapis.com/token", "https://fcm.googleapis.com/v1/projects/mochlik-test/messages:send")
        valid.forEach { validateNativePushProviderRequest(NativePushHttpRequest(URI(it), emptyMap(), ByteArray(0))) }
        listOf("http://oauth2.googleapis.com/token", "https://example.test/token", "https://oauth2.googleapis.com/token?next=1",
            "https://oauth2.googleapis.com:443/token", "https://user@oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token#ignored",
            "https://oauth2.googleapis.com/a/../token", "https://fcm.googleapis.com/v1/projects/../messages:send",
            "https://api.push.apple.com/3/device/%2fother").forEach {
            assertFailsWith<IllegalArgumentException> { validateNativePushProviderRequest(NativePushHttpRequest(URI(it), emptyMap(), ByteArray(0))) }
        }
        assertFailsWith<IllegalArgumentException> { validateNativePushProviderRequest(NativePushHttpRequest(URI(valid.first()), emptyMap(), ByteArray(8193))) }
    }

    @Test fun `response subscriber bounds streaming data and cancels on overflow`() {
        class Subscription : Flow.Subscription {
            var canceled = false
            var requested = 0L
            override fun request(count: Long) { requested += count }
            override fun cancel() { canceled = true }
        }
        val exact = NativePushBodySubscriber(4); val exactSubscription = Subscription()
        exact.onSubscribe(exactSubscription)
        exact.onNext(listOf(ByteBuffer.wrap(byteArrayOf(1, 2)), ByteBuffer.wrap(byteArrayOf(3, 4))))
        exact.onComplete()
        assertContentEquals(byteArrayOf(1, 2, 3, 4), exact.getBody().toCompletableFuture().get())
        assertFalse(exactSubscription.canceled)
        val overflow = NativePushBodySubscriber(4); val overflowSubscription = Subscription()
        overflow.onSubscribe(overflowSubscription)
        overflow.onNext(listOf(ByteBuffer.wrap(byteArrayOf(1, 2, 3))))
        overflow.onNext(listOf(ByteBuffer.wrap(byteArrayOf(4, 5))))
        assertTrue(overflowSubscription.canceled)
        assertIs<IOException>(assertFailsWith<ExecutionException> { overflow.getBody().toCompletableFuture().get() }.cause)
        overflow.onComplete()
        assertTrue(overflow.getBody().toCompletableFuture().isCompletedExceptionally)
    }
}
