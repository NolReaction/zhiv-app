package ru.zhiv.mochlik.lab;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Token is stored only as AES-GCM ciphertext; the encryption key never leaves Android Keystore. */
final class NativeSessionStore {
    private static final String KEY_ALIAS = "mochlik.mobile.session.v1";
    private final SharedPreferences preferences;
    private final String origin;

    static final class Session {
        final String token;
        final String userId;
        final String expiresAt;
        final long expiresMillis;
        Session(String token, String userId, String expiresAt) {
            if (token == null || !token.matches("m1_[A-Za-z0-9_-]{43}") || userId == null ||
                !userId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw new IllegalArgumentException("Invalid session");
            this.token = token;
            this.userId = userId;
            this.expiresAt = expiresAt;
            this.expiresMillis = parseExpiry(expiresAt);
            if (expiresMillis <= System.currentTimeMillis()) throw new IllegalArgumentException("Expired session");
        }
    }

    NativeSessionStore(Context context, String origin) {
        preferences = context.getSharedPreferences("mochlik.native.session.v1", Context.MODE_PRIVATE);
        this.origin = origin;
    }

    Session read() throws Exception {
        synchronized (NativeSessionStore.class) { return readLocked(); }
    }

    private Session readLocked() throws Exception {
        String envelope = preferences.getString("session", null);
        if (envelope == null) return null;
        SecretKey secret = key();
        try {
            JSONObject value = new JSONObject(envelope);
            byte[] iv = Base64.decode(value.getString("iv"), Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(value.getString("data"), Base64.NO_WRAP);
            if (iv.length != 12 || encrypted.length > 16384) throw new IllegalArgumentException("Invalid session envelope");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(128, iv));
            cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
            JSONObject clear = new JSONObject(new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
            return new Session(clear.getString("token"), clear.getString("userId"), clear.getString("expiresAt"));
        } catch (org.json.JSONException | IllegalArgumentException | javax.crypto.AEADBadTagException error) {
            clear();
            return null;
        }
    }

    void write(Session value) throws Exception {
        synchronized (NativeSessionStore.class) { writeLocked(value); }
    }

    private void writeLocked(Session value) throws Exception {
        JSONObject clear = new JSONObject().put("token", value.token).put("userId", value.userId).put("expiresAt", value.expiresAt);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(clear.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        if (!preferences.edit().putString("session", envelope.toString()).commit()) throw new IllegalStateException("Cannot save session");
    }

    boolean clearIfToken(String expectedToken) throws Exception {
        synchronized (NativeSessionStore.class) {
            Session current = readLocked();
            if (current == null || !current.token.equals(expectedToken)) return false;
            clearLocked();
            return true;
        }
    }

    void clear() {
        synchronized (NativeSessionStore.class) { clearLocked(); }
    }

    private void clearLocked() {
        boolean removed = preferences.edit().remove("session").commit();
        boolean keyRemoved = false;
        try {
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
            keys.load(null);
            keys.deleteEntry(KEY_ALIAS);
            keyRemoved = true;
        } catch (Exception ignored) { /* A successfully deleted ciphertext cannot restore a session. */ }
        if (!removed && !keyRemoved) throw new IllegalStateException("Cannot clear session");
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private static long parseExpiry(String value) {
        if (value == null || !value.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z")) throw new IllegalArgumentException("Invalid expiry");
        String normalized = value.substring(0, 19) + "Z";
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        format.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        Date date = format.parse(normalized, position);
        if (date == null || position.getIndex() != normalized.length()) throw new IllegalArgumentException("Invalid expiry");
        return date.getTime();
    }
}
