package ru.zhiv.notifications

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import nl.martijndwars.webpush.AbstractPushService
import nl.martijndwars.webpush.Encoding
import nl.martijndwars.webpush.Notification
import nl.martijndwars.webpush.Urgency
import nl.martijndwars.webpush.Utils
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.Security
import java.time.Duration
import java.util.Base64

/** Secrets are deliberately not held in a data class (generated toString). */
class WebPushConfig(val publicKey: String? = null, internal val privateKey: String? = null, internal val subject: String? = null) {
    val configured: Boolean get() = publicKey != null && privateKey != null && subject != null
    fun delivery() = NotificationDelivery(configured, if (configured) publicKey else null, if (configured) null else "not_configured")
    companion object {
        fun fromEnvironment(env: Map<String, String> = System.getenv()): WebPushConfig {
            val public = env["WEB_PUSH_VAPID_PUBLIC_KEY"]?.trim()?.takeIf(String::isNotEmpty)
            val private = env["WEB_PUSH_VAPID_PRIVATE_KEY"]?.trim()?.takeIf(String::isNotEmpty)
            val subject = env["WEB_PUSH_VAPID_SUBJECT"]?.trim()?.takeIf(String::isNotEmpty)
            if (public == null && private == null && subject == null) return WebPushConfig()
            require(public != null && private != null && subject != null) { "Set all three WEB_PUSH_VAPID variables, or none" }
            require(runCatching { Base64.getUrlDecoder().decode(public).size == 65 && Base64.getUrlDecoder().decode(private).size == 32 }.getOrDefault(false)) { "Invalid VAPID key lengths" }
            val uri = runCatching { URI(subject) }.getOrNull()
            require(uri != null && ((uri.scheme == "mailto" && uri.schemeSpecificPart.contains('@')) ||
                (uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null))) { "VAPID subject must be a mailto contact or HTTPS URL" }
            return WebPushConfig(public, private, subject)
        }
    }
}
enum class PushResult { DELIVERED, EXPIRED, RETRY, REJECTED, UNCERTAIN }
fun interface PushSender { fun send(subscription: BrowserPushSubscription, payload: PushPayload): PushResult }

/** The upstream library implements RFC8291 + VAPID. Only the bounded HTTP
 * transport is ours: no redirects, no legacy Google keys, no response logging. */
class WebPushSender(config: WebPushConfig) : PushSender, AutoCloseable {
    private class Encoder(config: WebPushConfig) : AbstractPushService<Encoder>(config.publicKey, config.privateKey, config.subject) {
        fun encode(notification: Notification) = prepareRequest(notification, Encoding.AES128GCM)
    }
    private val encoder: Encoder
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(2)).build()
    init {
        require(config.configured)
        require(System.getenv("ECE_KEYLOG") != "1") { "ECE_KEYLOG must not be enabled on the API" }
        if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider())
        encoder = Encoder(config)
        require(Utils.verifyKeyPair(encoder.privateKey, encoder.publicKey)) { "VAPID public and private keys do not match" }
    }
    internal data class EncodedPush(val url: String, val headers: Map<String,String>, val body: ByteArray)
    internal fun encode(subscription: BrowserPushSubscription, payload: PushPayload): EncodedPush {
        validatePushSubscription(subscription)
        val notification = Notification.builder().endpoint(subscription.endpoint)
            .userPublicKey(Utils.loadPublicKey(subscription.keys.p256dh))
            .userAuth(Base64.getUrlDecoder().decode(subscription.keys.auth))
            .payload(Json.encodeToString(payload).toByteArray(Charsets.UTF_8)).ttl(1800)
            .urgency(Urgency.LOW).topic(payload.tag).build()
        val encoded=encoder.encode(notification)
        // 5.1.2 retains compatibility code that rewrites old FCM paths and adds
        // the retired Crypto-Key header. Modern AES128GCM uses the exact browser
        // endpoint and the VAPID Authorization header only (RFC8292 section 3).
        return EncodedPush(subscription.endpoint,encoded.headers.filterKeys { !it.equals("Crypto-Key",true) },encoded.body)
    }
    override fun send(subscription: BrowserPushSubscription, payload: PushPayload): PushResult = try {
        val encoded = encode(subscription, payload)
        val request = HttpRequest.newBuilder(URI(encoded.url)).timeout(Duration.ofSeconds(3))
            .POST(HttpRequest.BodyPublishers.ofByteArray(encoded.body))
        encoded.headers.forEach { (name, value) -> if (!name.equals("Content-Length", true)) request.header(name, value) }
        when (client.send(request.build(), HttpResponse.BodyHandlers.discarding()).statusCode()) {
            in 200..299 -> PushResult.DELIVERED
            404, 410 -> PushResult.EXPIRED
            429, 500, 502, 503, 504 -> PushResult.RETRY
            else -> PushResult.REJECTED
        }
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt(); PushResult.UNCERTAIN
    } catch (_: java.io.IOException) {
        // Acceptance is unknown after a transport timeout. Do not risk sending
        // the same user-visible message again after the browser received it.
        PushResult.UNCERTAIN
    } catch (_: Exception) { PushResult.REJECTED }
    override fun close() { client.close() }
}
