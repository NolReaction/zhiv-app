package ru.zhiv.notifications

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.RSAPrivateKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/** File-backed provider keys are never part of a generated data-class toString. */
class ApnsPushConfig internal constructor(
    val keyId: String,
    val teamId: String,
    val topic: String,
    val environment: String,
    internal val privateKey: ECPrivateKey,
) {
    override fun toString(): String = "ApnsPushConfig(configured)"
}

class FcmPushConfig internal constructor(
    val projectId: String,
    val androidPackage: String,
    internal val clientEmail: String,
    internal val keyId: String,
    internal val privateKey: RSAPrivateKey,
) {
    override fun toString(): String = "FcmPushConfig(configured)"
}

class NativePushConfig(
    val apns: ApnsPushConfig? = null,
    val fcm: FcmPushConfig? = null,
) {
    val anyConfigured: Boolean get() = apns != null || fcm != null
    fun configured(platform: String): Boolean = when (platform) {
        "ios" -> apns != null
        "android" -> fcm != null
        else -> false
    }
    override fun toString(): String = "NativePushConfig(ios=${apns != null},android=${fcm != null})"

    companion object {
        private val appleTopic = Regex("^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$")
        private val androidApplicationId = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
        private val appleId = Regex("^[A-Z0-9]{10}$")
        private val pemLabel = listOf("PRIVATE", "KEY").joinToString(" ")
        private val pem = Regex("^-----BEGIN $pemLabel-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END $pemLabel-----$")

        /** Both providers are disabled when absent. A partial or malformed
         * configuration fails startup rather than appearing delivery-ready. */
        fun fromEnvironment(env: Map<String, String> = System.getenv()): NativePushConfig {
            fun setting(name: String): String? = env[name]?.trim()?.takeIf(String::isNotEmpty)
            val apnsNames = listOf("KEY_FILE", "KEY_ID", "TEAM_ID", "TOPIC", "ENVIRONMENT")
            val apnsValues = apnsNames.associateWith { setting("NATIVE_PUSH_APNS_$it") }
            val apns = if (apnsValues.values.all { it == null }) null else {
                require(apnsValues.values.all { it != null }) { "Set all five NATIVE_PUSH_APNS variables, or none" }
                val keyId = apnsValues.getValue("KEY_ID")!!
                val teamId = apnsValues.getValue("TEAM_ID")!!
                val topic = apnsValues.getValue("TOPIC")!!
                val environment = apnsValues.getValue("ENVIRONMENT")!!
                require(appleId.matches(keyId) && appleId.matches(teamId)) { "Invalid APNs key or team identifier" }
                require(topic.length <= 255 && appleTopic.matches(topic)) { "Invalid APNs topic" }
                require(environment in setOf("sandbox", "production")) { "APNs environment must be sandbox or production" }
                val key = parseKey(readSecret(apnsValues.getValue("KEY_FILE")!!, "APNs"), "EC", "APNs") as? ECPrivateKey
                    ?: throw IllegalArgumentException("APNs key must be an EC private key")
                val expected = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
                    .getParameterSpec(ECParameterSpec::class.java)
                require(key.params.order == expected.order && key.params.curve == expected.curve &&
                    key.params.generator == expected.generator && key.params.cofactor == expected.cofactor) { "APNs key must use P-256" }
                require(key.s.signum() > 0 && key.s < expected.order) { "Invalid APNs private scalar" }
                ApnsPushConfig(keyId, teamId, topic, environment, key)
            }
            val fcmFile = setting("NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE")
            val androidPackage = setting("NATIVE_PUSH_FCM_ANDROID_PACKAGE")
            val fcm = if (fcmFile == null && androidPackage == null) null else {
                require(fcmFile != null && androidPackage != null) { "Set both NATIVE_PUSH_FCM variables, or neither" }
                require(androidPackage.length <= 255 && androidApplicationId.matches(androidPackage)) { "Invalid FCM Android package" }
                val json = runCatching { Json.parseToJsonElement(readSecret(fcmFile, "FCM")) as? JsonObject }.getOrNull()
                    ?: throw IllegalArgumentException("Invalid FCM service account JSON")
                fun field(name: String): String = runCatching { json[name]?.jsonPrimitive?.takeIf { it.isString }?.contentOrNull }.getOrNull()
                    ?: throw IllegalArgumentException("Incomplete FCM service account JSON")
                require(field("type") == "service_account") { "FCM credentials must be a service account" }
                require(field("token_uri") == "https://oauth2.googleapis.com/token") { "Unsupported FCM token endpoint" }
                val projectId = field("project_id")
                val clientEmail = field("client_email")
                val keyId = field("private_key_id")
                require(projectId.matches(Regex("^[a-z][a-z0-9-]{4,61}[a-z0-9]$"))) { "Invalid FCM project identifier" }
                require(clientEmail.length <= 254 && clientEmail.matches(Regex("^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\\.gserviceaccount\\.com$"))) { "Invalid FCM service account email" }
                require(keyId.matches(Regex("^[A-Za-z0-9_-]{1,128}$"))) { "Invalid FCM key identifier" }
                val key = parseKey(field("private_key"), "RSA", "FCM") as? RSAPrivateKey
                    ?: throw IllegalArgumentException("FCM key must be an RSA private key")
                require(key.modulus.bitLength() in 2048..8192) { "FCM RSA key must contain 2048 to 8192 bits" }
                FcmPushConfig(projectId, androidPackage, clientEmail, keyId, key)
            }
            return NativePushConfig(apns, fcm)
        }

        private fun readSecret(file: String, provider: String): String = try {
            Files.newInputStream(Path.of(file)).use { stream ->
                val bytes = stream.readNBytes(65_537)
                require(bytes.size <= 65_536) { "Provider key file is too large" }
                bytes.toString(Charsets.UTF_8)
            }
        } catch (_: Exception) {
            // File paths and parser diagnostics may contain credential material.
            throw IllegalArgumentException("Unable to read $provider credentials file")
        }

        private fun parseKey(value: String, algorithm: String, provider: String): PrivateKey = try {
            val base64 = pem.matchEntire(value.trim())?.groupValues?.get(1)
                ?: throw IllegalArgumentException()
            val bytes = Base64.getDecoder().decode(base64.filterNot(Char::isWhitespace))
            KeyFactory.getInstance(algorithm).generatePrivate(PKCS8EncodedKeySpec(bytes))
        } catch (_: Exception) {
            throw IllegalArgumentException("Invalid $provider PKCS8 private key")
        }
    }
}
