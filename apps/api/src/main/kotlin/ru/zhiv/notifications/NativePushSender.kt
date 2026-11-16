package ru.zhiv.notifications

import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.ECDSASigner
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.time.Duration
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ExecutionException
import java.util.concurrent.Flow
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

data class NativePushSubscription(val platform: String, val token: String) {
    override fun toString(): String = "NativePushSubscription(platform=$platform,token=<redacted>)"
}

fun interface NativePushSender {
    fun send(subscription: NativePushSubscription, payload: PushPayload): PushResult
    fun retryNotBefore(platform: String): Instant? = null
}

fun validateNativePushSubscription(subscription: NativePushSubscription) {
    val token = subscription.token
    val valid = when (subscription.platform) {
        "ios" -> token.length % 2 == 0 && token.matches(Regex("^[0-9a-f]{32,512}$"))
        "android" -> token.matches(Regex("^[A-Za-z0-9_:./~+=-]{16,4096}$"))
        else -> false
    }
    require(valid) { "Invalid native push subscription" }
}

/** No arbitrary URLs leave the queue. This metadata is also checked on device
 * before navigation, and on Android before displaying a remote notification. */
private fun nativePushData(payload: PushPayload): JsonObject {
    require(payload.ownerPublicId.matches(Regex("^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$"))) { "Invalid push owner" }
    val eventId = runCatching { UUID.fromString(payload.tag).toString() }.getOrNull()
    require(eventId != null && eventId == payload.tag) { "Invalid push event identifier" }
    val target = when (payload.url) {
        "/?notification=mailbox&owner=${payload.ownerPublicId}" -> "mailbox"
        "/?notification=checkin&owner=${payload.ownerPublicId}" -> "checkin"
        else -> throw IllegalArgumentException("Unsupported native push destination")
    }
    return buildJsonObject {
        put("source", "mochlik-remote")
        put("ownerPublicId", payload.ownerPublicId)
        put("target", target)
        put("eventId", eventId)
    }
}

internal class NativePushHttpRequest(val uri: URI, val headers: Map<String, String>, val body: ByteArray)
internal class NativePushHttpResponse(
    val status: Int,
    val body: ByteArray = ByteArray(0),
    val retryAfter: String? = null,
    val http2: Boolean = true,
)
internal fun interface NativePushHttpTransport : AutoCloseable {
    fun execute(request: NativePushHttpRequest): NativePushHttpResponse
    override fun close() {}
}

/** Bound the response while it arrives, not after an unbounded allocation. */
internal class NativePushBodySubscriber(private val limit: Int = 16_384) : HttpResponse.BodySubscriber<ByteArray> {
    private val result = CompletableFuture<ByteArray>()
    private val bytes = ByteArrayOutputStream()
    private var subscription: Flow.Subscription? = null
    override fun getBody(): CompletionStage<ByteArray> = result
    override fun onSubscribe(value: Flow.Subscription) { subscription = value; value.request(1) }
    override fun onNext(items: List<ByteBuffer>) {
        if (result.isDone) return
        for (item in items) {
            if (item.remaining() > limit - bytes.size()) {
                subscription?.cancel()
                result.completeExceptionally(IOException("Native push response exceeds limit"))
                return
            }
            val part = ByteArray(item.remaining())
            item.get(part)
            bytes.write(part)
        }
        subscription?.request(1)
    }
    override fun onError(error: Throwable) { result.completeExceptionally(error) }
    override fun onComplete() { result.complete(bytes.toByteArray()) }
}

internal fun validateNativePushProviderRequest(request: NativePushHttpRequest) {
    val uri = request.uri
    val allowed = uri.scheme == "https" && uri.rawUserInfo == null && uri.port == -1 && uri.rawQuery == null &&
        uri.rawFragment == null && when (uri.host) {
            "api.push.apple.com", "api.sandbox.push.apple.com" -> uri.rawPath.matches(Regex("^/3/device/[0-9a-f]{32,512}$"))
            "oauth2.googleapis.com" -> uri.rawPath == "/token"
            "fcm.googleapis.com" -> uri.rawPath.matches(Regex("^/v1/projects/[a-z][a-z0-9-]{4,61}[a-z0-9]/messages:send$"))
            else -> false
        }
    require(allowed && request.body.size <= 8192) { "Invalid native push provider request" }
}

private class JdkNativePushHttpTransport : NativePushHttpTransport {
    private val client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_2)
        .followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(2)).build()
    override fun execute(request: NativePushHttpRequest): NativePushHttpResponse {
        validateNativePushProviderRequest(request)
        val uri = request.uri
        val builder = HttpRequest.newBuilder(uri).version(HttpClient.Version.HTTP_2).timeout(Duration.ofSeconds(3))
            .POST(HttpRequest.BodyPublishers.ofByteArray(request.body))
        request.headers.forEach { (key, value) -> builder.header(key, value) }
        val future = client.sendAsync(builder.build(), HttpResponse.BodyHandler { NativePushBodySubscriber() })
        try {
            // The explicit deadline also covers a provider that streams a body
            // indefinitely after returning headers.
            val response = future.get(5, TimeUnit.SECONDS)
            return NativePushHttpResponse(response.statusCode(), response.body(),
                response.headers().firstValue("Retry-After").orElse(null), response.version() == HttpClient.Version.HTTP_2)
        } catch (_: TimeoutException) {
            future.cancel(true)
            throw IOException("Native push provider timeout")
        } catch (_: ExecutionException) {
            future.cancel(true)
            throw IOException("Native push provider request failed")
        } catch (error: InterruptedException) {
            future.cancel(true)
            throw error
        }
    }
    override fun close() { client.close() }
}

/** APNs and OAuth assertions use the existing audited JOSE dependency. The
 * sender does not log provider responses, registration tokens or credentials. */
class NativeProviderPushSender internal constructor(
    private val config: NativePushConfig,
    private val transport: NativePushHttpTransport,
    private val clock: () -> Instant = Instant::now,
) : NativePushSender, AutoCloseable {
    constructor(config: NativePushConfig) : this(config, JdkNativePushHttpTransport())

    private class Credential(val value: String, val issuedAt: Instant, val refreshAt: Instant)
    private class TokenFailure(val result: PushResult) : RuntimeException("Native push authorization unavailable")
    private var apnsCredential: Credential? = null
    private var fcmCredential: Credential? = null
    private val retryDeadlines = mutableMapOf<String, Instant>()

    @Synchronized override fun retryNotBefore(platform: String): Instant? = retryDeadlines[platform]?.takeIf { it > clock() }

    @Synchronized override fun send(subscription: NativePushSubscription, payload: PushPayload): PushResult {
        if (!config.configured(subscription.platform)) return PushResult.REJECTED
        return try {
            validateNativePushSubscription(subscription)
            val data = nativePushData(payload)
            val now = clock()
            if (retryDeadlines[subscription.platform]?.let { it > now } == true) return PushResult.RETRY
            when (subscription.platform) {
                "ios" -> sendApns(subscription, payload, data, now)
                "android" -> sendFcm(subscription, data, now)
                else -> PushResult.REJECTED
            }
        } catch (error: TokenFailure) {
            error.result
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            PushResult.UNCERTAIN
        } catch (_: IOException) {
            // A notification may already be accepted after an HTTP timeout.
            PushResult.UNCERTAIN
        } catch (_: Exception) {
            PushResult.REJECTED
        }
    }

    private fun sendApns(subscription: NativePushSubscription, payload: PushPayload, data: JsonObject, now: Instant): PushResult {
        val settings = config.apns ?: return PushResult.REJECTED
        require(payload.title.length in 1..128 && payload.body.length in 1..512) { "Invalid native notification text" }
        val body = buildJsonObject {
            putJsonObject("aps") {
                putJsonObject("alert") { put("title", payload.title); put("body", payload.body) }
                put("sound", "default")
                put("thread-id", "mochlik-remote")
            }
            data.forEach { (key, value) -> put(key, value) }
        }.toString().toByteArray(Charsets.UTF_8)
        require(body.size <= 4096) { "Native notification exceeds APNs limit" }
        val host = if (settings.environment == "sandbox") "api.sandbox.push.apple.com" else "api.push.apple.com"
        val response = transport.execute(NativePushHttpRequest(URI("https://$host/3/device/${subscription.token}"), mapOf(
            "authorization" to "bearer ${apnsToken(settings, now)}", "content-type" to "application/json",
            "apns-topic" to settings.topic, "apns-push-type" to "alert", "apns-priority" to "10",
            "apns-expiration" to now.plusSeconds(1800).epochSecond.toString(),
            "apns-collapse-id" to "mochlik-remote", "apns-id" to payload.tag,
        ), body))
        if (!response.http2) return PushResult.UNCERTAIN
        val reason = jsonObject(response.body)?.string("reason")
        return when {
            response.status == 200 -> PushResult.DELIVERED
            response.status == 410 && reason == "Unregistered" -> PushResult.EXPIRED
            response.status == 400 && reason == "BadDeviceToken" -> PushResult.EXPIRED
            response.status == 403 && reason == "ExpiredProviderToken" -> {
                apnsCredential = null
                retry("ios", response, now)
            }
            response.status == 429 || response.status in 500..599 -> retry("ios", response, now)
            else -> PushResult.REJECTED
        }
    }

    private fun apnsToken(settings: ApnsPushConfig, now: Instant): String {
        apnsCredential?.takeIf { now >= it.issuedAt && now < it.refreshAt }?.let { return it.value }
        val jwt = SignedJWT(JWSHeader.Builder(JWSAlgorithm.ES256).keyID(settings.keyId).build(),
            JWTClaimsSet.Builder().issuer(settings.teamId).issueTime(Date.from(now)).build())
        jwt.sign(ECDSASigner(settings.privateKey))
        return jwt.serialize().also { apnsCredential = Credential(it, now, now.plusSeconds(3000)) }
    }

    private fun sendFcm(subscription: NativePushSubscription, data: JsonObject, now: Instant): PushResult {
        val settings = config.fcm ?: return PushResult.REJECTED
        val accessToken = fcmToken(settings, now)
        // Data-only messages let the native service verify current owner and
        // consent before display. FCM must not auto-display another account's alert.
        val body = buildJsonObject {
            putJsonObject("message") {
                put("token", subscription.token)
                put("data", data)
                putJsonObject("android") {
                    put("priority", "HIGH")
                    put("ttl", "1800s")
                    put("collapse_key", "mochlik-remote")
                    put("restricted_package_name", settings.androidPackage)
                }
            }
        }.toString().toByteArray(Charsets.UTF_8)
        val response = transport.execute(NativePushHttpRequest(
            URI("https://fcm.googleapis.com/v1/projects/${settings.projectId}/messages:send"),
            mapOf("Authorization" to "Bearer $accessToken", "Content-Type" to "application/json; charset=utf-8"), body))
        return when {
            response.status == 200 -> PushResult.DELIVERED
            response.status == 404 && fcmError(response.body) == "UNREGISTERED" -> PushResult.EXPIRED
            response.status == 401 -> {
                fcmCredential = null
                retry("android", response, now)
            }
            response.status == 429 || response.status in 500..599 -> retry("android", response, now)
            else -> PushResult.REJECTED
        }
    }

    private fun fcmToken(settings: FcmPushConfig, now: Instant): String {
        fcmCredential?.takeIf { now >= it.issuedAt && now < it.refreshAt }?.let { return it.value }
        val jwt = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(settings.keyId).type(JOSEObjectType.JWT).build(),
            JWTClaimsSet.Builder().issuer(settings.clientEmail).audience("https://oauth2.googleapis.com/token")
                .claim("scope", "https://www.googleapis.com/auth/firebase.messaging")
                .issueTime(Date.from(now)).expirationTime(Date.from(now.plusSeconds(3600))).build())
        jwt.sign(RSASSASigner(settings.privateKey))
        val form = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
            URLEncoder.encode(jwt.serialize(), Charsets.UTF_8)
        val response = try {
            transport.execute(NativePushHttpRequest(URI("https://oauth2.googleapis.com/token"),
                mapOf("Content-Type" to "application/x-www-form-urlencoded"), form.toByteArray(Charsets.UTF_8)))
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw TokenFailure(PushResult.RETRY)
        } catch (_: IOException) {
            // This request cannot deliver a user notification, so retry is safe.
            throw TokenFailure(PushResult.RETRY)
        }
        if (response.status != 200) {
            throw TokenFailure(if (response.status == 429 || response.status in 500..599) retry("android", response, now) else PushResult.REJECTED)
        }
        val json = jsonObject(response.body) ?: throw TokenFailure(PushResult.REJECTED)
        val token = json.string("access_token")
        val duration = runCatching { json["expires_in"]?.jsonPrimitive?.longOrNull }.getOrNull()
        if (json.string("token_type")?.equals("Bearer", true) != true || token == null ||
            token.length > 8192 || !token.matches(Regex("^[A-Za-z0-9._~+/-]+=*$")) || duration == null || duration !in 1..3600) {
            throw TokenFailure(PushResult.REJECTED)
        }
        val refreshIn = maxOf(1, duration - minOf(60, duration / 2))
        fcmCredential = Credential(token, now, now.plusSeconds(refreshIn))
        return token
    }

    private fun retry(platform: String, response: NativePushHttpResponse, now: Instant): PushResult {
        val raw = response.retryAfter?.trim()?.takeIf { it.length <= 128 }
        val seconds = raw?.toLongOrNull()?.takeIf { it >= 0 }
        val date = if (seconds == null && raw != null) runCatching {
            ZonedDateTime.parse(raw, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()
        }.getOrNull() else null
        val deadline = seconds?.let { runCatching { now.plusSeconds(it) }.getOrDefault(Instant.MAX) } ?: date
        // Do not turn an overflowing provider deadline into an earlier retry,
        // or propagate an unrepresentable timestamp into the durable queue.
        if (deadline != null && deadline > Instant.parse("9999-12-31T23:59:59Z")) return PushResult.REJECTED
        val after = maxOf(now.plusSeconds(60), deadline ?: now)
        retryDeadlines[platform] = maxOf(retryDeadlines[platform] ?: now, after)
        return PushResult.RETRY
    }

    private fun fcmError(body: ByteArray): String? {
        val error = jsonObject(body)?.get("error") as? JsonObject ?: return null
        val details = error["details"] as? JsonArray ?: return null
        return details.mapNotNull { it as? JsonObject }.firstOrNull {
            it.string("@type") == "type.googleapis.com/google.firebase.fcm.v1.FcmError"
        }?.string("errorCode")
    }
    private fun jsonObject(body: ByteArray): JsonObject? = if (body.size > 16_384) null else
        runCatching { Json.parseToJsonElement(body.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull()
    private fun JsonObject.string(key: String): String? = runCatching {
        this[key]?.jsonPrimitive?.takeIf { it.isString }?.contentOrNull
    }.getOrNull()

    @Synchronized override fun close() {
        apnsCredential = null
        fcmCredential = null
        retryDeadlines.clear()
        transport.close()
    }
}
