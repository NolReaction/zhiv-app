package ru.zhiv.mochlik.lab

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONException
import org.json.JSONObject

/** Token is stored only as AES-GCM ciphertext; the encryption key never leaves Android Keystore. */
internal class NativeSessionStore(context: Context, private val origin: String) {
    private val preferences = context.getSharedPreferences("mochlik.native.session.v1", Context.MODE_PRIVATE)

    class Session(token: String?, userId: String?, expiresAt: String?) {
        val token: String
        val userId: String
        val expiresAt: String
        val expiresMillis: Long

        init {
            require(
                token != null && token.matches(Regex("m1_[A-Za-z0-9_-]{43}")) && userId != null &&
                    userId.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            ) { "Invalid session" }
            this.token = token
            this.userId = userId
            this.expiresAt = requireNotNull(expiresAt) { "Invalid expiry" }
            expiresMillis = parseExpiry(this.expiresAt)
            require(expiresMillis > System.currentTimeMillis()) { "Expired session" }
        }
    }

    fun read(): Session? = synchronized(NativeSessionStore::class.java) { readLocked() }

    private fun readLocked(): Session? {
        val envelope = preferences.getString("session", null) ?: return null
        val secret = key()
        return try {
            val value = JSONObject(envelope)
            val iv = Base64.decode(value.getString("iv"), Base64.NO_WRAP)
            val encrypted = Base64.decode(value.getString("data"), Base64.NO_WRAP)
            require(iv.size == 12 && encrypted.size <= 16384) { "Invalid session envelope" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, iv))
            cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
            val clear = JSONObject(String(cipher.doFinal(encrypted), Charsets.UTF_8))
            Session(clear.getString("token"), clear.getString("userId"), clear.getString("expiresAt"))
        } catch (error: Exception) {
            if (error !is JSONException && error !is IllegalArgumentException && error !is AEADBadTagException) throw error
            clear()
            null
        }
    }

    fun write(value: Session) = synchronized(NativeSessionStore::class.java) { writeLocked(value) }

    private fun writeLocked(value: Session) {
        val clear = JSONObject().put("token", value.token).put("userId", value.userId).put("expiresAt", value.expiresAt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
        val envelope = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(clear.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
        check(preferences.edit().putString("session", envelope.toString()).commit()) { "Cannot save session" }
    }

    fun clearIfToken(expectedToken: String): Boolean = synchronized(NativeSessionStore::class.java) {
        val current = readLocked()
        if (current == null || current.token != expectedToken) return@synchronized false
        clearLocked()
        true
    }

    fun clear() = synchronized(NativeSessionStore::class.java) { clearLocked() }

    private fun clearLocked() {
        val removed = preferences.edit().remove("session").commit()
        var keyRemoved = false
        try {
            val keys = KeyStore.getInstance("AndroidKeyStore")
            keys.load(null)
            keys.deleteEntry(KEY_ALIAS)
            keyRemoved = true
        } catch (_: Exception) {
            // A successfully deleted ciphertext cannot restore a session.
        }
        check(removed || keyRemoved) { "Cannot clear session" }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore")
        store.load(null)
        if (store.containsAlias(KEY_ALIAS)) return store.getKey(KEY_ALIAS, null) as SecretKey
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "mochlik.mobile.session.v1"

        private fun parseExpiry(value: String): Long {
            require(value.matches(Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z"))) { "Invalid expiry" }
            val normalized = value.substring(0, 19) + "Z"
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT).apply {
                timeZone = TimeZone.getTimeZone("UTC")
                isLenient = false
            }
            val position = ParsePosition(0)
            val date = format.parse(normalized, position)
            require(date != null && position.index == normalized.length) { "Invalid expiry" }
            return date.time
        }
    }
}
