package ru.zhiv.mochlik.lab;

import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.util.Base64;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.HashSet;
import java.util.Set;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

@CapacitorPlugin(name = "MochlikNative")
public final class MochlikNativePlugin extends Plugin implements ComponentCallbacks2 {
    private final Object lock = new Object();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Request> requests = new HashMap<>();
    private NativeHttpPolicy policy;
    private NativeSessionStore store;
    private NativeSessionStore.Session session;
    private boolean loaded;
    private long generation;
    private Login login;
    private View.OnLayoutChangeListener safeAreaListener;
    private String lastSafeArea = "";
    private final NativeSessionEvents.InvalidationListener externalInvalidation = expectedToken -> {
        synchronized (lock) {
            if (session != null && session.token.equals(expectedToken)) {
                try { clearSession(); }
                catch (Exception ignored) { /* Memory is cleared and the caller also invalidates persisted credentials. */ }
            }
        }
    };

    private static final class Request {
        final PluginCall call;
        final long generation;
        final NativeHttpClient.Transfer transfer = new NativeHttpClient.Transfer();
        ScheduledFuture<?> timeout;
        Request(PluginCall call, long generation) { this.call = call; this.generation = generation; }
    }
    private static final class Login {
        final PluginCall call;
        final String state;
        final String verifier;
        final long generation;
        final NativeHttpClient.Transfer transfer = new NativeHttpClient.Transfer();
        ScheduledFuture<?> timeout;
        boolean exchanging;
        Login(PluginCall call, String state, String verifier, long generation) {
            this.call = call; this.state = state; this.verifier = verifier; this.generation = generation;
        }
    }

    @Override public void load() {
        try {
            policy = new NativeHttpPolicy(getContext().getString(R.string.mobile_backend_origin));
            store = new NativeSessionStore(getContext(), policy.origin());
        } catch (Exception ignored) { policy = null; }
        NativeSessionEvents.addInvalidationListener(externalInvalidation);
        getContext().getApplicationContext().registerComponentCallbacks(this);
        getActivity().runOnUiThread(() -> {
            View decor = getActivity().getWindow().getDecorView();
            safeAreaListener = (view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> publishSafeArea();
            decor.addOnLayoutChangeListener(safeAreaListener);
            publishSafeArea();
        });
    }

    private void loadSession() throws Exception {
        if (!loaded) { session = store.read(); loaded = true; }
        if (session != null && session.expiresMillis <= System.currentTimeMillis()) clearSession();
    }

    private JSObject state() {
        JSObject value = new JSObject().put("configured", policy != null).put("authenticated", session != null);
        if (session != null) value.put("userId", session.userId).put("expiresAt", session.expiresAt);
        return value;
    }

    @PluginMethod public void getState(PluginCall call) {
        synchronized (lock) {
            try {
                if (policy != null) loadSession();
                call.resolve(state());
            } catch (Exception ignored) { call.reject("Не удалось открыть защищённое хранилище", "STORAGE_UNAVAILABLE"); }
        }
    }

    @PluginMethod public void request(PluginCall call) {
        if (policy == null) { call.reject("Адрес сервера не настроен в сборке", "CONFIG_REQUIRED"); return; }
        final String id = call.getString("id");
        final String path = call.getString("path");
        final String expectedUserId = call.getString("expectedUserId");
        final String method = call.getString("method", "GET");
        final Map<String, String> headers = new HashMap<>();
        final byte[] body;
        final Request request;
        final String token;
        try {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException();
            policy.api(path, false);
            NativeHttpPolicy.method(method);
            JSObject supplied = call.getObject("headers", new JSObject());
            if (supplied.length() > 24) throw new IllegalArgumentException();
            Set<String> seenHeaders = new HashSet<>();
            Iterator<String> keys = supplied.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                String value = supplied.getString(name);
                if (!(supplied.opt(name) instanceof String) || !seenHeaders.add(name.toLowerCase(Locale.ROOT)) || !NativeHttpPolicy.allowedRequestHeader(name, value)) throw new IllegalArgumentException();
                headers.put(name, value);
            }
            String encoded = call.getString("body");
            if (encoded != null && encoded.length() > ((NativeHttpPolicy.MAX_REQUEST_BYTES + 2) / 3) * 4) {
                call.reject("Слишком большой запрос", "REQUEST_TOO_LARGE"); return;
            }
            body = encoded == null ? null : Base64.decode(encoded, Base64.NO_WRAP);
            if (body != null && (body.length > NativeHttpPolicy.MAX_REQUEST_BYTES || method.equals("GET") || method.equals("HEAD"))) throw new IllegalArgumentException();
        } catch (Exception ignored) { call.reject("Недопустимый запрос приложения", "INVALID_REQUEST"); return; }
        synchronized (lock) {
            try { loadSession(); }
            catch (Exception ignored) { call.reject("Не удалось открыть защищённое хранилище", "STORAGE_UNAVAILABLE"); return; }
            if ((session == null && expectedUserId != null) || (session != null && !session.userId.equals(expectedUserId))) {
                call.reject("Сеанс изменился", "SESSION_CHANGED"); return;
            }
            if (requests.containsKey(id) || requests.size() >= 32) { call.reject("Слишком много запросов", "INVALID_REQUEST"); return; }
            request = new Request(call, generation);
            token = session == null ? null : session.token;
            requests.put(id, request);
            request.timeout = timer.schedule(() -> cancel(id, request, "MOBILE_REQUEST_FAILED"), 30, TimeUnit.SECONDS);
        }
        try {
            workers.execute(() -> {
                try {
                    synchronized (lock) {
                        if (requests.get(id) != request || request.generation != generation) return;
                    }
                    NativeHttpClient.Response response = NativeHttpClient.execute(policy.api(path, false), method, headers, body, token, request.transfer);
                    synchronized (lock) {
                        if (requests.get(id) != request) return;
                        requests.remove(id);
                        request.timeout.cancel(false);
                        if (request.generation != generation) { call.reject("Сеанс изменился", "SESSION_CHANGED"); return; }
                        String responsePath = policy.api(path, false).getPath();
                        boolean sessionEnded = response.status >= 200 && response.status < 300 &&
                            ((method.equals("POST") && responsePath.equals("/api/v1/auth/logout")) ||
                             (method.equals("DELETE") && responsePath.equals("/api/v1/auth/account/profile")));
                        if ((response.status == 401 && token != null) || sessionEnded) {
                            try { clearSession(); }
                            catch (Exception ignored) { call.reject("Не удалось очистить защищённое хранилище", "STORAGE_UNAVAILABLE"); return; }
                        }
                        call.resolve(new JSObject().put("status", response.status).put("headers", response.headers)
                            .put("body", Base64.encodeToString(response.body, Base64.NO_WRAP)));
                    }
                } catch (NativeHttpClient.TooLarge ignored) { cancel(id, request, "RESPONSE_TOO_LARGE"); }
                catch (Exception ignored) { cancel(id, request, "MOBILE_REQUEST_FAILED"); }
            });
        } catch (Exception ignored) { cancel(id, request, "MOBILE_REQUEST_FAILED"); }
    }

    private void cancel(String id, Request expected, String code) {
        synchronized (lock) {
            Request active = requests.get(id);
            if (active == null || (expected != null && expected != active)) return;
            requests.remove(id);
            if (active.timeout != null) active.timeout.cancel(false);
            active.transfer.cancel();
            active.call.reject(code.equals("ABORT_ERR") ? "Запрос отменён" : "Не удалось завершить запрос", code);
        }
    }

    @PluginMethod public void cancelRequest(PluginCall call) { cancel(call.getString("id"), null, "ABORT_ERR"); call.resolve(); }

    @PluginMethod public void login(PluginCall call) {
        if (policy == null) { call.reject("Адрес сервера не настроен в сборке", "CONFIG_REQUIRED"); return; }
        final Login attempt;
        final Uri url;
        synchronized (lock) {
            try { loadSession(); }
            catch (Exception ignored) { call.reject("Не удалось открыть защищённое хранилище", "STORAGE_UNAVAILABLE"); return; }
            if (session != null) { call.resolve(state()); return; }
            if (login != null) { call.reject("Вход уже открыт", "AUTH_BUSY"); return; }
            try {
                attempt = new Login(call, randomCode(), randomCode(), generation);
                String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(attempt.verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                url = Uri.parse(policy.origin() + "/mobile/connect").buildUpon().appendQueryParameter("challenge", challenge)
                    .appendQueryParameter("state", attempt.state).appendQueryParameter("platform", "android").build();
                login = attempt;
                attempt.timeout = timer.schedule(() -> finishLogin(attempt, "AUTH_CANCELLED"), 10, TimeUnit.MINUTES);
            } catch (Exception ignored) { call.reject("Не удалось начать вход", "AUTH_FAILED"); return; }
        }
        getActivity().runOnUiThread(() -> {
            try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (Exception ignored) { finishLogin(attempt, "AUTH_FAILED"); }
        });
    }

    @PluginMethod public void cancelLogin(PluginCall call) {
        synchronized (lock) { if (login != null) finishLogin(login, "AUTH_CANCELLED"); }
        call.resolve();
    }

    @Override protected void handleOnNewIntent(Intent intent) {
        Uri uri = intent.getData();
        if (uri == null || !"ru.zhiv.mochlik.lab".equals(uri.getScheme()) || !"auth".equals(uri.getHost()) ||
            !"/callback".equals(uri.getPath()) || uri.getPort() != -1 || uri.getUserInfo() != null || uri.getFragment() != null) return;
        final Login attempt;
        final String code;
        synchronized (lock) {
            attempt = login;
            if (attempt == null || attempt.exchanging || attempt.generation != generation) return;
            if (uri.getQueryParameters("state").size() != 1 || !attempt.state.equals(uri.getQueryParameter("state"))) return;
            if (uri.getQueryParameters("code").size() != 1 || uri.getQueryParameterNames().size() != 2) { finishLogin(attempt, "AUTH_FAILED"); return; }
            code = uri.getQueryParameter("code");
            if (code == null || !code.matches("[A-Za-z0-9_-]{43}")) { finishLogin(attempt, "AUTH_FAILED"); return; }
            attempt.exchanging = true;
        }
        try {
            workers.execute(() -> {
                try {
                    JSONObject body = new JSONObject().put("code", code).put("verifier", attempt.verifier).put("state", attempt.state).put("platform", "android");
                    NativeHttpClient.Response response = NativeHttpClient.execute(policy.api("/api/v1/auth/mobile/exchange", true), "POST",
                        Collections.singletonMap("Content-Type", "application/json"), body.toString().getBytes(StandardCharsets.UTF_8), null, attempt.transfer);
                    if (response.status != 200) { finishLogin(attempt, "AUTH_FAILED"); return; }
                    JSONObject value = new JSONObject(new String(response.body, StandardCharsets.UTF_8));
                    NativeSessionStore.Session authenticated = new NativeSessionStore.Session(value.getString("token"), value.getString("userId"), value.getString("expiresAt"));
                    synchronized (lock) {
                        if (login != attempt || attempt.generation != generation) return;
                        NativeSessionEvents.changed();
                        store.write(authenticated);
                        session = authenticated;
                        generation++;
                        login = null;
                        attempt.timeout.cancel(false);
                        cancelAllRequests();
                        notifyListeners("sessionChange", state());
                        attempt.call.resolve(state());
                    }
                } catch (Exception ignored) { finishLogin(attempt, "AUTH_FAILED"); }
            });
        } catch (Exception ignored) { finishLogin(attempt, "AUTH_FAILED"); }
    }

    private void finishLogin(Login expected, String code) {
        synchronized (lock) {
            if (login != expected) return;
            login = null;
            expected.transfer.cancel();
            if (expected.timeout != null) expected.timeout.cancel(false);
            expected.call.reject(code.equals("AUTH_CANCELLED") ? "Вход отменён" : "Не удалось завершить вход", code);
        }
    }

    @PluginMethod public void logout(PluginCall call) {
        String savedToken = null;
        boolean cleanupFailed = false;
        synchronized (lock) {
            try {
                if (policy != null) loadSession();
                savedToken = session == null ? null : session.token;
            } catch (Exception ignored) { cleanupFailed = true; }
            try { clearSession(); }
            catch (Exception ignored) { cleanupFailed = true; }
        }
        final String token = savedToken;
        if (token != null) try {
            workers.execute(() -> {
                NativeHttpClient.Transfer transfer = new NativeHttpClient.Transfer();
                ScheduledFuture<?> timeout = timer.schedule(transfer::cancel, 30, TimeUnit.SECONDS);
                try { NativeHttpClient.execute(policy.api("/api/v1/auth/logout", true), "POST", Collections.singletonMap("Content-Type", "application/json"), "{}".getBytes(StandardCharsets.UTF_8), token, transfer); }
                catch (Exception ignored) { /* Local credentials are already gone; server expiry/revocation still applies. */ }
                finally { timeout.cancel(false); }
            });
        } catch (Exception ignored) { /* A destroyed app must never restore the local session to retry. */ }
        if (cleanupFailed) call.reject("Не удалось очистить защищённое хранилище", "STORAGE_UNAVAILABLE");
        else synchronized (lock) { call.resolve(state()); }
    }

    private void clearSession() {
        NativeSessionEvents.changed();
        session = null;
        generation++;
        if (login != null) finishLogin(login, "AUTH_CANCELLED");
        cancelAllRequests();
        notifyListeners("sessionChange", state());
        if (store != null) store.clear();
    }

    private void cancelAllRequests() {
        for (Map.Entry<String, Request> entry : new ArrayList<>(requests.entrySet())) cancel(entry.getKey(), entry.getValue(), "SESSION_CHANGED");
    }

    @PluginMethod public void openWebsite(PluginCall call) {
        if (policy == null) { call.reject("Адрес сервера не настроен в сборке", "CONFIG_REQUIRED"); return; }
        final Uri uri;
        try { uri = Uri.parse(policy.website(call.getString("path", "/")).toString()); }
        catch (Exception ignored) { call.reject("Недопустимая ссылка", "INVALID_REQUEST"); return; }
        getActivity().runOnUiThread(() -> {
            try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); call.resolve(); }
            catch (Exception ignored) { call.reject("Не удалось открыть браузер", "MOBILE_REQUEST_FAILED"); }
        });
    }

    @PluginMethod public void getSafeArea(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(safeArea()));
    }

    private JSObject safeArea() {
        View decor = getActivity().getWindow().getDecorView();
        WindowInsetsCompat windowInsets = ViewCompat.getRootWindowInsets(decor);
        Insets insets = windowInsets == null ? Insets.NONE : windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        float density = getContext().getResources().getDisplayMetrics().density;
        return new JSObject().put("top", insets.top / density).put("right", insets.right / density)
            .put("bottom", insets.bottom / density).put("left", insets.left / density);
    }

    private void publishSafeArea() {
        JSObject value = safeArea();
        String serialized = value.toString();
        if (!serialized.equals(lastSafeArea)) { lastSafeArea = serialized; notifyListeners("safeAreaChange", value); }
    }

    private static String randomCode() {
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        return Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    @Override public void onTrimMemory(int level) {
        if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level == ComponentCallbacks2.TRIM_MEMORY_COMPLETE) {
            notifyListeners("memoryWarning", new JSObject().put("level", String.valueOf(level)));
        }
    }
    @Override public void onLowMemory() { notifyListeners("memoryWarning", new JSObject().put("level", "critical")); }
    @Override public void onConfigurationChanged(Configuration configuration) {}
    @Override protected void handleOnDestroy() {
        synchronized (lock) {
            if (login != null) finishLogin(login, "AUTH_CANCELLED");
            cancelAllRequests();
        }
        if (safeAreaListener != null) getActivity().runOnUiThread(() -> getActivity().getWindow().getDecorView().removeOnLayoutChangeListener(safeAreaListener));
        NativeSessionEvents.removeInvalidationListener(externalInvalidation);
        getContext().getApplicationContext().unregisterComponentCallbacks(this);
        workers.shutdownNow();
        timer.shutdownNow();
    }
}
