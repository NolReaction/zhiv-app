package ru.zhiv.auth

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.jwk.source.JWKSourceBuilder
import com.nimbusds.jose.jwk.source.JWKSource
import com.nimbusds.jose.proc.JWSVerificationKeySelector
import com.nimbusds.jose.proc.SecurityContext
import com.nimbusds.jose.util.DefaultResourceRetriever
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier
import com.nimbusds.jwt.proc.DefaultJWTProcessor
import jakarta.mail.Message
import jakarta.mail.Session
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.Properties
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.Flow
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

fun formEncode(values: Map<String, String>): String = values.entries.joinToString("&") {
    URLEncoder.encode(it.key, Charsets.UTF_8) + "=" + URLEncoder.encode(it.value, Charsets.UTF_8)
}

fun codeDigest(secret: String, flow: String, code: String): ByteArray = Mac.getInstance("HmacSHA256").run {
    init(SecretKeySpec(secret.toByteArray(), "HmacSHA256")); doFinal("$flow:$code".toByteArray())
}

fun interface TelegramVerifier { suspend fun verify(code: String, flow: LoginFlow): VerifiedTelegram }
fun interface LoginMailer { suspend fun send(email: String, code: String) }

class TelegramOidc(private val config: AuthConfig) : TelegramVerifier, AutoCloseable {
    private val keySource = JWKSourceBuilder.create<SecurityContext>(
        URI("https://oauth.telegram.org/.well-known/jwks.json").toURL(), DefaultResourceRetriever(5_000, 5_000, 100_000),
    ).build()
    private val validator = TelegramIdTokens(config.telegramClientId, keySource)
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build()

    override suspend fun verify(code: String, flow: LoginFlow): VerifiedTelegram = withContext(Dispatchers.IO) {
        try {
            val body = formEncode(mapOf("grant_type" to "authorization_code", "code" to code, "redirect_uri" to config.callback, "client_id" to config.telegramClientId, "code_verifier" to requireNotNull(flow.verifier)))
            val basic = Base64.getEncoder().encodeToString("${config.telegramClientId}:${config.telegramClientSecret}".toByteArray())
            val request = HttpRequest.newBuilder(URI("https://oauth.telegram.org/token"))
                .timeout(Duration.ofSeconds(10)).header("Authorization", "Basic $basic")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build()
            val response = client.send(request, HttpResponse.BodyHandler { LimitedBodySubscriber(65_536) })
            val bytes = response.body()
            require(response.statusCode() == 200 && bytes.size <= 65_536)
            val jwt = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject["id_token"]!!.jsonPrimitive.content
            validator.verify(jwt, requireNotNull(flow.nonce))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Provider responses may contain credentials: never put them in logs or error bodies.
            throw AuthFailure("TELEGRAM_LOGIN_FAILED", "Не удалось подтвердить вход через Telegram. Повторите вход.", 502)
        }
    }
    override fun close() { (keySource as? java.io.Closeable)?.close(); client.close() }
}

class SmtpLoginMailer(private val config: AuthConfig) : LoginMailer {
    override suspend fun send(email: String, code: String): Unit = withContext(Dispatchers.IO) {
        try {
            val properties = Properties().apply {
                setProperty("mail.smtp.host", config.smtpHost)
                setProperty("mail.smtp.port", config.smtpPort.toString())
                setProperty("mail.smtp.auth", config.smtpUser.isNotEmpty().toString())
                setProperty("mail.smtp.connectiontimeout", "8000")
                setProperty("mail.smtp.timeout", "8000")
                setProperty("mail.smtp.writetimeout", "8000")
                setProperty("mail.smtp.ssl.checkserveridentity", "true")
                if (config.smtpImplicitTls) setProperty("mail.smtp.ssl.enable", "true")
                else { setProperty("mail.smtp.starttls.enable", "true"); setProperty("mail.smtp.starttls.required", "true") }
            }
            val session = Session.getInstance(properties)
            val message = MimeMessage(session).apply {
                setFrom(InternetAddress(config.smtpFrom, "Я ЖИВОЙ", "UTF-8"))
                setRecipient(Message.RecipientType.TO, InternetAddress(email, true))
                setSubject("Код входа в Я ЖИВОЙ", "UTF-8")
                setText("Ваш код: $code\n\nВведите его в том окне, где начали вход или привязку почты. Код действует 10 минут. Никому его не передавайте.\n\nЕсли вы не запрашивали код, просто проигнорируйте письмо.", "UTF-8")
            }
            session.getTransport("smtp").use { transport ->
                transport.connect(config.smtpHost, config.smtpPort, config.smtpUser.ifEmpty { null }, config.smtpPassword.ifEmpty { null })
                message.saveChanges(); transport.sendMessage(message, message.allRecipients)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            throw AuthFailure("EMAIL_DELIVERY_FAILED", "Письмо не удалось отправить. Попробуйте позже или войдите через Telegram.", 503)
        }
    }
}


internal class TelegramIdTokens(private val clientId: String, keys: JWKSource<SecurityContext>) {
    private val processor = DefaultJWTProcessor<SecurityContext>().apply {
        jwsKeySelector = JWSVerificationKeySelector(JWSAlgorithm.RS256, keys)
        jwtClaimsSetVerifier = DefaultJWTClaimsVerifier<SecurityContext>(
            clientId, JWTClaimsSet.Builder().issuer("https://oauth.telegram.org").build(), setOf("sub", "iat", "exp", "nonce"),
        )
    }

    fun verify(jwt: String, nonce: String): VerifiedTelegram {
            val claims = processor.process(jwt, null)
            val now = Instant.now()
            require(claims.getStringClaim("nonce") == nonce)
            require(claims.issueTime.toInstant() <= now.plusSeconds(60) && claims.issueTime.toInstant() >= now.minusSeconds(900))
            require(claims.expirationTime.toInstant() > now)
            if (claims.audience.size > 1 || claims.getStringClaim("azp") != null) require(claims.getStringClaim("azp") == clientId)
            val subject = claims.subject
            require(!subject.isNullOrBlank() && subject.length <= 254)
            return VerifiedTelegram(subject)
    }
}

/** Keeps both the request deadline and a strict allocation bound while reading the response. */
private class LimitedBodySubscriber(private val limit: Int) : HttpResponse.BodySubscriber<ByteArray> {
    private val result = CompletableFuture<ByteArray>()
    private val output = ByteArrayOutputStream()
    private var subscription: Flow.Subscription? = null
    override fun getBody(): CompletionStage<ByteArray> = result
    override fun onSubscribe(value: Flow.Subscription) { subscription = value; value.request(1) }
    override fun onNext(items: List<ByteBuffer>) {
        if (result.isDone) return
        for (item in items) {
            if (item.remaining() > limit - output.size()) {
                subscription?.cancel(); result.completeExceptionally(IllegalStateException("Provider response too large")); return
            }
            val bytes = ByteArray(item.remaining()); item.get(bytes); output.write(bytes)
        }
        subscription?.request(1)
    }
    override fun onError(error: Throwable) { result.completeExceptionally(error) }
    override fun onComplete() { result.complete(output.toByteArray()) }
}
