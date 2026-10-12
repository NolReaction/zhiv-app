package ru.zhiv.notifications

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import nl.martijndwars.webpush.Encoding
import nl.martijndwars.webpush.HttpEce
import nl.martijndwars.webpush.Utils
import org.bouncycastle.jce.interfaces.ECPrivateKey
import org.bouncycastle.jce.interfaces.ECPublicKey
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.jose4j.jws.JsonWebSignature
import org.junit.jupiter.api.Test
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Security
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import javax.crypto.Cipher
import kotlin.test.*

class WebPushSenderTest {
    private val base64=Base64.getUrlEncoder().withoutPadding()
    private fun pair(): KeyPair {
        if(Security.getProvider("BC")==null) Security.addProvider(BouncyCastleProvider())
        return KeyPairGenerator.getInstance("ECDH","BC").apply { initialize(ECGenParameterSpec("prime256v1")) }.generateKeyPair()
    }
    private fun publicKey(pair: KeyPair)=base64.encodeToString(Utils.encode(pair.public as ECPublicKey))
    private fun privateKey(pair: KeyPair): String {
        val raw=(pair.private as ECPrivateKey).d.toByteArray()
        return base64.encodeToString(if(raw.size>32) raw.takeLast(32).toByteArray() else ByteArray(32-raw.size)+raw)
    }
    @Test fun `production encoder signs VAPID and round trips an AES128GCM payload offline`() {
        val vapid=pair();val browser=pair();val auth=ByteArray(16) { (it+1).toByte() }
        val config=WebPushConfig(publicKey(vapid),privateKey(vapid),"mailto:test@example.test")
        val subscription=BrowserPushSubscription("https://fcm.googleapis.com/fcm/send/test",PushKeys(publicKey(browser),base64.encodeToString(auth)))
        val payload=PushPayload("Я Живой","Ресурсы готовы.","mochlik-updates","/?notification=world&section=production&owner=ABCD-EFGH-JKLM","ABCD-EFGH-JKLM")
        WebPushSender(config).use { sender ->
            val encoded=sender.encode(subscription,payload)
            assertEquals(subscription.endpoint,encoded.url)
            assertEquals("aes128gcm",encoded.headers["Content-Encoding"])
            assertEquals("1800",encoded.headers["TTL"])
            assertEquals("low",encoded.headers["Urgency"])
            assertFalse(encoded.headers.containsKey("Crypto-Key"))
            val authorization=checkNotNull(encoded.headers["Authorization"])
            assertTrue(authorization.startsWith("vapid t="))
            val jws=JsonWebSignature().apply { compactSerialization=authorization.substringAfter("vapid t=").substringBefore(",");key=vapid.public }
            assertTrue(jws.verifySignature());assertContains(jws.payload,"https://fcm.googleapis.com")
            assertFalse(encoded.body.toString(Charsets.UTF_8).contains("Ресурсы"))
            val header=HttpEce().parseHeader(encoded.body)
            val senderKey=Utils.loadPublicKey(header[2])
            val decoder=HttpEce(mapOf("receiver" to KeyPair(senderKey,browser.private)),mapOf("receiver" to "P-256"))
            val keys=decoder.deriveKeyAndNonce(header[0],null,"receiver",browser.public as ECPublicKey,auth,Encoding.AES128GCM,Cipher.DECRYPT_MODE)
            val plain=decoder.decryptRecord(header[3],keys[0],keys[1],Encoding.AES128GCM)
            assertEquals(Json.encodeToString(payload),plain.toString(Charsets.UTF_8))
        }
    }
    @Test fun `mismatched VAPID pair fails at startup instead of dropping deliveries`() {
        val first=pair();val second=pair()
        assertFailsWith<IllegalArgumentException> { WebPushSender(WebPushConfig(publicKey(first),privateKey(second),"mailto:test@example.test")) }
    }
}
