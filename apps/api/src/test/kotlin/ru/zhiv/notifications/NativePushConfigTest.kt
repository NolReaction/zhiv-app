package ru.zhiv.notifications

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.RSAPrivateKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.*

/** Credentials exist only in memory or JUnit's disposable directory. */
internal object NativePushTestKeys {
    val ec: KeyPair by lazy { ecPair("secp256r1") }
    val rsa: KeyPair by lazy { rsaPair(2048) }
    fun ecPair(curve: String): KeyPair = KeyPairGenerator.getInstance("EC")
        .apply { initialize(ECGenParameterSpec(curve)) }.generateKeyPair()
    fun rsaPair(bits: Int): KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(bits) }.generateKeyPair()
    fun pem(key: PrivateKey): String {
        val label = listOf("PRIVATE", "KEY").joinToString(" ")
        return "-----BEGIN $label-----\n" + Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(key.encoded) + "\n-----END $label-----\n"
    }
    fun apns(environment: String = "sandbox") = ApnsPushConfig("ABCDEFGHIJ", "KLMNOPQRST", "test.mochlik.mobile", environment, ec.private as ECPrivateKey)
    fun fcm() = FcmPushConfig("mochlik-test", "test.mochlik.mobile", "push@mochlik-test.iam.gserviceaccount.com", "generated-test-key", rsa.private as RSAPrivateKey)
    fun serviceAccount(key: PrivateKey = rsa.private, endpoint: String = "https://oauth2.googleapis.com/token") = buildJsonObject {
        put("type", "service_account")
        put("project_id", "mochlik-test")
        put("client_email", "push@mochlik-test.iam.gserviceaccount.com")
        put("private_key_id", "generated-test-key")
        put("private_key", pem(key))
        put("token_uri", endpoint)
    }.toString()
}

class NativePushConfigTest {
    @TempDir lateinit var directory: Path

    private fun file(name: String, value: String): String = Files.writeString(directory.resolve(name), value).toString()
    private fun apnsEnvironment(key: PrivateKey = NativePushTestKeys.ec.private): Map<String, String> = mapOf(
        "NATIVE_PUSH_APNS_KEY_FILE" to file("provider.p8", NativePushTestKeys.pem(key)),
        "NATIVE_PUSH_APNS_KEY_ID" to "ABCDEFGHIJ", "NATIVE_PUSH_APNS_TEAM_ID" to "KLMNOPQRST",
        "NATIVE_PUSH_APNS_TOPIC" to "test.mochlik.mobile", "NATIVE_PUSH_APNS_ENVIRONMENT" to "sandbox",
    )
    private fun fcmEnvironment(json: String = NativePushTestKeys.serviceAccount()): Map<String, String> = mapOf(
        "NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE" to file("provider.json", json),
        "NATIVE_PUSH_FCM_ANDROID_PACKAGE" to "test.mochlik.mobile",
    )

    @Test fun `providers are disabled without complete explicit credentials`() {
        val config = NativePushConfig.fromEnvironment(emptyMap())
        assertFalse(config.anyConfigured)
        listOf("ios", "android", "web", "").forEach { assertFalse(config.configured(it)) }
        assertFalse(NativePushConfig.fromEnvironment(mapOf("NATIVE_PUSH_APNS_TOPIC" to " ")).anyConfigured)
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(mapOf("NATIVE_PUSH_APNS_TOPIC" to "test.mochlik.mobile")) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(mapOf("NATIVE_PUSH_FCM_ANDROID_PACKAGE" to "test.mochlik.mobile")) }
    }

    @Test fun `file backed keys load independently and configuration never renders secrets`() {
        val apnsOnly = NativePushConfig.fromEnvironment(apnsEnvironment())
        assertTrue(apnsOnly.configured("ios")); assertFalse(apnsOnly.configured("android"))
        val fcmOnly = NativePushConfig.fromEnvironment(fcmEnvironment())
        assertFalse(fcmOnly.configured("ios")); assertTrue(fcmOnly.configured("android"))
        val both = NativePushConfig.fromEnvironment(apnsEnvironment() + fcmEnvironment())
        assertTrue(both.anyConfigured)
        assertEquals("sandbox", both.apns?.environment)
        assertEquals("mochlik-test", both.fcm?.projectId)
        assertEquals("NativePushConfig(ios=true,android=true)", both.toString())
        assertEquals("ApnsPushConfig(configured)", both.apns.toString())
        assertEquals("FcmPushConfig(configured)", both.fcm.toString())
    }

    @Test fun `APNs rejects wrong curve RSA keys environment and injected header values`() {
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(apnsEnvironment(NativePushTestKeys.ecPair("secp384r1").private)) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(apnsEnvironment(NativePushTestKeys.rsa.private)) }
        val environment = apnsEnvironment()
        listOf("development", "https://example.test", "SANDBOX").forEach {
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(environment + ("NATIVE_PUSH_APNS_ENVIRONMENT" to it)) }
        }
        listOf("NATIVE_PUSH_APNS_KEY_ID", "NATIVE_PUSH_APNS_TEAM_ID", "NATIVE_PUSH_APNS_TOPIC").forEach {
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(environment + (it to "value\r\nInjected: header")) }
        }
    }

    @Test fun `FCM rejects credential endpoint redirects and requires strong RSA keys`() {
        listOf("http://oauth2.googleapis.com/token", "https://example.test/token", "https://oauth2.googleapis.com/token?redirect=1").forEach {
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment(NativePushTestKeys.serviceAccount(endpoint = it))) }
        }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment(NativePushTestKeys.serviceAccount(NativePushTestKeys.ec.private))) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment(NativePushTestKeys.serviceAccount(NativePushTestKeys.rsaPair(1024).private))) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment("{}")) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment("[]")) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment() + ("NATIVE_PUSH_FCM_ANDROID_PACKAGE" to "test.app/../../token")) }
        assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment() + ("NATIVE_PUSH_FCM_ANDROID_PACKAGE" to "test.invalid-app")) }
    }

    @Test fun `secret file and parser errors are bounded and redact path and contents`() {
        val secretMarker = "private-material-" + java.util.UUID.randomUUID()
        val environment = apnsEnvironment()
        val errors = listOf(
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(environment + ("NATIVE_PUSH_APNS_KEY_FILE" to directory.resolve(secretMarker).toString())) },
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(environment + ("NATIVE_PUSH_APNS_KEY_FILE" to file("malformed.p8", secretMarker))) },
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(environment + ("NATIVE_PUSH_APNS_KEY_FILE" to file("huge.p8", "x".repeat(65_537)))) },
            assertFailsWith<IllegalArgumentException> { NativePushConfig.fromEnvironment(fcmEnvironment(secretMarker)) },
        )
        errors.forEach { error ->
            assertFalse(error.toString().contains(secretMarker))
            assertFalse(error.toString().contains(directory.toString()))
            assertNull(error.cause)
        }
    }
}
