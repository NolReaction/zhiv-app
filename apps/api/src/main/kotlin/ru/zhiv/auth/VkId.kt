package ru.zhiv.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.time.Duration
import ru.zhiv.observability.ProviderFailure

fun interface VkVerifier {
    suspend fun verify(code: String, deviceId: String, state: String, flow: LoginFlow): VerifiedVk
}

internal fun interface VkTransport { fun post(uri: URI, form: String): ByteArray }

/** VK ID Authorization Code + PKCE, following VKCOM/vkid-web-sdk's exchange and userInfo. */
class VkId internal constructor(private val config: AuthConfig, private val transport: VkTransport? = null) : VkVerifier, AutoCloseable {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build()
    private class HttpFailure(val status: Int) : RuntimeException()

    private fun post(uri: URI, values: Map<String, String>): ByteArray {
        val form = formEncode(values)
        val bytes = if (transport != null) transport.post(uri, form) else {
            val request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/x-www-form-urlencoded").header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build()
            val response = client.send(request, HttpResponse.BodyHandler { LimitedBodySubscriber(65_536) })
            if (response.statusCode() != 200) throw HttpFailure(response.statusCode())
            response.body()
        }
        require(bytes.size <= 65_536)
        return bytes
    }

    override suspend fun verify(code: String, deviceId: String, state: String, flow: LoginFlow): VerifiedVk = withContext(Dispatchers.IO) {
        var stage = "exchange"
        try {
            // VK's official SDK sends these exchange parameters in the query, and code in the form.
            // Neither request URLs nor provider responses may be logged: they contain credentials.
            val exchange = URI("https://id.vk.ru/oauth2/auth?" + formEncode(mapOf(
                "grant_type" to "authorization_code", "client_id" to config.vkClientId,
                "redirect_uri" to config.vkCallback, "code_verifier" to requireNotNull(flow.verifier),
                "state" to state, "device_id" to deviceId,
            )))
            val token = Json.parseToJsonElement(post(exchange, mapOf("code" to code)).toString(Charsets.UTF_8)).jsonObject
            require("error" !in token)
            val returnedState = token["state"]?.jsonPrimitive?.content.orEmpty()
            require(MessageDigest.isEqual(state.toByteArray(), returnedState.toByteArray()))
            val subject = token["user_id"]?.jsonPrimitive?.content.orEmpty()
            require(Regex("^[1-9][0-9]{0,18}$").matches(subject))
            val accessToken = token["access_token"]?.jsonPrimitive?.content.orEmpty()
            require(accessToken.isNotBlank() && accessToken.length <= 16_384)
            stage = "user_info"
            val response = Json.parseToJsonElement(post(
                URI("https://id.vk.ru/oauth2/user_info?" + formEncode(mapOf("client_id" to config.vkClientId))),
                mapOf("access_token" to accessToken),
            ).toString(Charsets.UTF_8)).jsonObject
            require("error" !in response)
            require(response["user"]?.jsonObject?.get("user_id")?.jsonPrimitive?.content == subject)
            VerifiedVk(subject)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            throw AuthFailure("VK_LOGIN_FAILED", "Не удалось подтвердить вход через ВК. Попробуйте ещё раз.", 502,
                ProviderFailure("vk", stage, (failure as? HttpFailure)?.status, failure))
        }
    }

    override fun close() { client.close() }
}
