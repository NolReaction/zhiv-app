package ru.zhiv.mochlik.lab

import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.util.Base64
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.tasks.Task
import com.google.firebase.messaging.FirebaseMessaging
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

@CapacitorPlugin(name = "MochlikNative")
class MochlikNativePlugin : Plugin(), ComponentCallbacks2 {
    private val lock = Any()
    private val workers = ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, ArrayBlockingQueue(32))
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private val requests = mutableMapOf<String, Request>()
    private var policy: NativeHttpPolicy? = null
    private var store: NativeSessionStore? = null
    private var session: NativeSessionStore.Session? = null
    private var loaded = false
    private var generation = 0L
    private var pushDeletion: Task<Void>? = null
    private var pushRegistration: Task<String>? = null
    private var pushStopped = false
    private var login: Login? = null
    private var safeAreaListener: View.OnLayoutChangeListener? = null
    private var lastSafeArea = ""
    private val externalInvalidation = NativeSessionEvents.InvalidationListener { expectedToken ->
        synchronized(lock) {
            if (session?.token == expectedToken) {
                try {
                    clearSession()
                } catch (_: Exception) {
                    // Memory is cleared and the caller also invalidates persisted credentials.
                }
            }
        }
    }

    private class Request(val call: PluginCall, val generation: Long) {
        val transfer = NativeHttpClient.Transfer()
        var timeout: ScheduledFuture<*>? = null
    }

    private class Login(val call: PluginCall, val state: String, val verifier: String, val generation: Long) {
        val transfer = NativeHttpClient.Transfer()
        var timeout: ScheduledFuture<*>? = null
        var exchanging = false
    }

    override fun load() {
        try {
            val configured = NativeHttpPolicy(context.getString(R.string.mobile_backend_origin))
            policy = configured
            store = NativeSessionStore(context, configured.origin())
        } catch (_: Exception) {
            policy = null
        }
        NativeSessionEvents.addInvalidationListener(externalInvalidation)
        context.applicationContext.registerComponentCallbacks(this)
        activity.runOnUiThread {
            val decor = activity.window.decorView
            val listener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> publishSafeArea() }
            safeAreaListener = listener
            decor.addOnLayoutChangeListener(listener)
            publishSafeArea()
        }
    }

    private fun loadSession() {
        if (!loaded) {
            session = checkNotNull(store).read()
            loaded = true
        }
        val current = session
        if (current != null && current.expiresMillis <= System.currentTimeMillis()) clearSession()
    }

    private fun state(): JSObject {
        val value = JSObject().put("configured", policy != null).put("authenticated", session != null).put("generation", generation)
        session?.let { value.put("userId", it.userId).put("expiresAt", it.expiresAt) }
        return value
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        synchronized(lock) {
            try {
                if (policy != null) loadSession()
                call.resolve(state())
            } catch (_: Exception) {
                call.reject("Не удалось открыть защищённое хранилище", "STORAGE_UNAVAILABLE")
            }
        }
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val currentPolicy = policy
        if (currentPolicy == null) {
            call.reject("Адрес сервера не настроен в сборке", "CONFIG_REQUIRED")
            return
        }
        val id: String
        val path = call.getString("path")
        val expectedUserId = call.getString("expectedUserId")
        val method: String
        val headers = mutableMapOf<String, String>()
        val body: ByteArray?
        val request: Request
        val token: String?
        try {
            id = requireNotNull(call.getString("id"))
            require(id.matches(Regex("[A-Za-z0-9_-]{1,128}")))
            currentPolicy.api(path, false)
            method = NativeHttpPolicy.method(call.getString("method", "GET"))
            val supplied = requireNotNull(call.getObject("headers", JSObject()))
            require(supplied.length() <= 24)
            val seenHeaders = mutableSetOf<String>()
            for (name in supplied.keys()) {
                val value = requireNotNull(supplied.getString(name))
                require(
                    supplied.opt(name) is String && seenHeaders.add(name.lowercase(Locale.ROOT)) &&
                        NativeHttpPolicy.allowedRequestHeader(name, value)
                )
                headers[name] = value
            }
            val encoded = call.getString("body")
            if (encoded != null && encoded.length > ((NativeHttpPolicy.MAX_REQUEST_BYTES + 2) / 3) * 4) {
                call.reject("Слишком большой запрос", "REQUEST_TOO_LARGE")
                return
            }
            body = encoded?.let { Base64.decode(it, Base64.NO_WRAP) }
            require(body == null || (body.size <= NativeHttpPolicy.MAX_REQUEST_BYTES && method != "GET" && method != "HEAD"))
        } catch (_: Exception) {
            call.reject("Недопустимый запрос приложения", "INVALID_REQUEST")
            return
        }
        synchronized(lock) {
            try {
                loadSession()
            } catch (_: Exception) {
                call.reject("Не удалось открыть защищённое хранилище", "STORAGE_UNAVAILABLE")
                return
            }
            val current = session
            if ((current == null && expectedUserId != null) || (current != null && current.userId != expectedUserId)) {
                call.reject("Сеанс изменился", "SESSION_CHANGED")
                return
            }
            if (requests.containsKey(id) || requests.size >= 32) {
                call.reject("Слишком много запросов", "INVALID_REQUEST")
                return
            }
            request = Request(call, generation)
            token = current?.token
            requests[id] = request
            request.timeout = timer.schedule({ cancel(id, request, "MOBILE_REQUEST_FAILED") }, 30, TimeUnit.SECONDS)
        }
        try {
            workers.execute work@{
                try {
                    synchronized(lock) {
                        if (requests[id] !== request || request.generation != generation) return@work
                    }
                    val response = NativeHttpClient.execute(currentPolicy.api(path, false), method, headers, body, token, request.transfer)
                    synchronized(lock) {
                        if (requests[id] !== request) return@work
                        requests.remove(id)
                        request.timeout?.cancel(false)
                        if (request.generation != generation) {
                            call.reject("Сеанс изменился", "SESSION_CHANGED")
                            return@work
                        }
                        val responsePath = currentPolicy.api(path, false).path
                        val sessionEnded = response.status in 200..299 &&
                            ((method == "POST" && responsePath == "/api/v1/auth/logout") ||
                                (method == "DELETE" && responsePath == "/api/v1/auth/account/profile"))
                        if ((response.status == 401 && token != null) || sessionEnded) {
                            try {
                                clearSession()
                            } catch (_: Exception) {
                                call.reject("Не удалось очистить защищённое хранилище", "STORAGE_UNAVAILABLE")
                                return@work
                            }
                        }
                        call.resolve(
                            JSObject().put("status", response.status).put("headers", response.headers)
                                .put("body", Base64.encodeToString(response.body, Base64.NO_WRAP))
                        )
                    }
                } catch (_: NativeHttpClient.TooLarge) {
                    cancel(id, request, "RESPONSE_TOO_LARGE")
                } catch (_: Exception) {
                    cancel(id, request, "MOBILE_REQUEST_FAILED")
                }
            }
        } catch (_: Exception) {
            cancel(id, request, "MOBILE_REQUEST_FAILED")
        }
    }

    private fun cancel(id: String?, expected: Request?, code: String) {
        synchronized(lock) {
            val active = requests[id] ?: return
            if (expected != null && expected !== active) return
            requests.remove(id)
            active.timeout?.cancel(false)
            active.transfer.cancel()
            active.call.reject(if (code == "ABORT_ERR") "Запрос отменён" else "Не удалось завершить запрос", code)
        }
    }

    @PluginMethod
    fun cancelRequest(call: PluginCall) {
        cancel(call.getString("id"), null, "ABORT_ERR")
        call.resolve()
    }

    @PluginMethod
    fun login(call: PluginCall) {
        val currentPolicy = policy
        if (currentPolicy == null) {
            call.reject("Адрес сервера не настроен в сборке", "CONFIG_REQUIRED")
            return
        }
        val attempt: Login
        val url: Uri
        synchronized(lock) {
            try {
                loadSession()
            } catch (_: Exception) {
                call.reject("Не удалось открыть защищённое хранилище", "STORAGE_UNAVAILABLE")
                return
            }
            if (session != null) {
                call.resolve(state())
                return
            }
            if (login != null) {
                call.reject("Вход уже открыт", "AUTH_BUSY")
                return
            }
            try {
                attempt = Login(call, randomCode(), randomCode(), generation)
                val challenge = Base64.encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(attempt.verifier.toByteArray(Charsets.US_ASCII)),
                    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
                )
                url = Uri.parse(currentPolicy.origin() + "/mobile/connect").buildUpon()
                    .appendQueryParameter("challenge", challenge)
                    .appendQueryParameter("state", attempt.state)
                    .appendQueryParameter("platform", "android")
                    .build()
                login = attempt
                attempt.timeout = timer.schedule({ finishLogin(attempt, "AUTH_CANCELLED") }, 10, TimeUnit.MINUTES)
            } catch (_: Exception) {
                call.reject("Не удалось начать вход", "AUTH_FAILED")
                return
            }
        }
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: Exception) {
                finishLogin(attempt, "AUTH_FAILED")
            }
        }
    }

    @PluginMethod
    fun cancelLogin(call: PluginCall) {
        synchronized(lock) { login?.let { finishLogin(it, "AUTH_CANCELLED") } }
        call.resolve()
    }

    public override fun handleOnNewIntent(intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "ru.zhiv.mochlik.lab" || uri.host != "auth" || uri.path != "/callback" ||
            uri.port != -1 || uri.userInfo != null || uri.fragment != null) return
        val attempt: Login
        val code: String
        synchronized(lock) {
            attempt = login ?: return
            if (attempt.exchanging || attempt.generation != generation) return
            if (uri.getQueryParameters("state").size != 1 || attempt.state != uri.getQueryParameter("state")) return
            if (uri.getQueryParameters("code").size != 1 || uri.queryParameterNames.size != 2) {
                finishLogin(attempt, "AUTH_FAILED")
                return
            }
            val receivedCode = uri.getQueryParameter("code")
            if (receivedCode == null || !receivedCode.matches(Regex("[A-Za-z0-9_-]{43}"))) {
                finishLogin(attempt, "AUTH_FAILED")
                return
            }
            code = receivedCode
            attempt.exchanging = true
        }
        try {
            workers.execute work@{
                try {
                    val body = JSONObject().put("code", code).put("verifier", attempt.verifier)
                        .put("state", attempt.state).put("platform", "android")
                    val response = NativeHttpClient.execute(
                        checkNotNull(policy).api("/api/v1/auth/mobile/exchange", true), "POST",
                        mapOf("Content-Type" to "application/json"), body.toString().toByteArray(Charsets.UTF_8), null, attempt.transfer
                    )
                    if (response.status != 200) {
                        finishLogin(attempt, "AUTH_FAILED")
                        return@work
                    }
                    val value = JSONObject(String(response.body, Charsets.UTF_8))
                    val authenticated = NativeSessionStore.Session(value.getString("token"), value.getString("userId"), value.getString("expiresAt"))
                    synchronized(lock) {
                        if (login !== attempt || attempt.generation != generation) return@work
                        NativeSessionEvents.changed()
                        try {
                            NativePushPolicy.clear(context)
                        } catch (_: RuntimeException) {
                            // New session fencing remains authoritative.
                        }
                        checkNotNull(store).write(authenticated)
                        session = authenticated
                        generation++
                        login = null
                        attempt.timeout?.cancel(false)
                        cancelAllRequests()
                        notifyListeners("sessionChange", state())
                        attempt.call.resolve(state())
                    }
                } catch (_: Exception) {
                    finishLogin(attempt, "AUTH_FAILED")
                }
            }
        } catch (_: Exception) {
            finishLogin(attempt, "AUTH_FAILED")
        }
    }

    private fun finishLogin(expected: Login, code: String) {
        synchronized(lock) {
            if (login !== expected) return
            login = null
            expected.transfer.cancel()
            expected.timeout?.cancel(false)
            expected.call.reject(if (code == "AUTH_CANCELLED") "Вход отменён" else "Не удалось завершить вход", code)
        }
    }

    @PluginMethod
    fun logout(call: PluginCall) {
        var savedToken: String? = null
        var cleanupFailed = false
        synchronized(lock) {
            try {
                if (policy != null) loadSession()
                savedToken = session?.token
            } catch (_: Exception) {
                cleanupFailed = true
            }
            try {
                clearSession()
            } catch (_: Exception) {
                cleanupFailed = true
            }
        }
        val token = savedToken
        if (token != null) {
            try {
                workers.execute {
                    val transfer = NativeHttpClient.Transfer()
                    val timeout = timer.schedule({ transfer.cancel() }, 30, TimeUnit.SECONDS)
                    try {
                        NativeHttpClient.execute(
                            checkNotNull(policy).api("/api/v1/auth/logout", true), "POST", mapOf("Content-Type" to "application/json"),
                            "{}".toByteArray(Charsets.UTF_8), token, transfer
                        )
                    } catch (_: Exception) {
                        // Local credentials are already gone; server expiry/revocation still applies.
                    } finally {
                        timeout.cancel(false)
                    }
                }
            } catch (_: Exception) {
                // A destroyed app must never restore the local session to retry.
            }
        }
        if (cleanupFailed) call.reject("Не удалось очистить защищённое хранилище", "STORAGE_UNAVAILABLE")
        else synchronized(lock) { call.resolve(state()) }
    }

    private fun clearSession() {
        NativeSessionEvents.changed()
        try {
            NativePushPolicy.clear(context)
        } catch (_: RuntimeException) {
            // Native session revocation must still complete.
        }
        session = null
        generation++
        login?.let { finishLogin(it, "AUTH_CANCELLED") }
        cancelAllRequests()
        notifyListeners("sessionChange", state())
        store?.clear()
    }

    private fun cancelAllRequests() {
        for ((id, request) in requests.toList()) cancel(id, request, "SESSION_CHANGED")
    }

    @PluginMethod
    fun openWebsite(call: PluginCall) {
        val currentPolicy = policy
        if (currentPolicy == null) {
            call.reject("Адрес сервера не настроен в сборке", "CONFIG_REQUIRED")
            return
        }
        val uri = try {
            Uri.parse(currentPolicy.website(call.getString("path", "/")).toString())
        } catch (_: Exception) {
            call.reject("Недопустимая ссылка", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
                call.resolve()
            } catch (_: Exception) {
                call.reject("Не удалось открыть браузер", "MOBILE_REQUEST_FAILED")
            }
        }
    }

    @PluginMethod
    fun getPushConfiguration(call: PluginCall) {
        val configured = NativePushPolicy.configured(context)
        call.resolve(
            JSObject().put("platform", "android").put("configured", configured)
                .put("reason", if (configured) JSONObject.NULL else "Сообщения сервера пока недоступны в этой сборке.")
        )
    }

    @PluginMethod
    fun registerRemotePush(call: PluginCall) {
        synchronized(lock) {
            try {
                loadSession()
                val expected = NativePushGeneration.parse(call.data.opt("expectedSessionGeneration"))
                val expectedUser = call.getString("expectedUserId")
                val current = session
                if (current == null || expected == null || expected != generation || current.userId != expectedUser) {
                    call.reject("Профиль изменился", "SESSION_CHANGED")
                    return
                }
                if (!NativePushPolicy.configured(context)) {
                    call.reject("Сообщения сервера пока недоступны в этой сборке", "PUSH_NOT_CONFIGURED")
                    return
                }
                if (pushDeletion?.isComplete == false || pushRegistration?.isComplete == false) {
                    call.reject("Предыдущее подключение ещё закрывается. Повторите при подключении к интернету.", "PUSH_REGISTRATION_BUSY")
                    return
                }
                val expectedGeneration = generation
                val messaging = FirebaseMessaging.getInstance()
                messaging.isAutoInitEnabled = true
                pushStopped = false
                val pending = messaging.token
                pushRegistration = pending
                val answered = AtomicBoolean()
                val deadline = timer.schedule({
                    if (answered.compareAndSet(false, true)) {
                        call.reject("Телефон не подтвердил подключение. Проверьте сеть и повторите.", "PUSH_REGISTRATION_TIMEOUT")
                    }
                }, 20, TimeUnit.SECONDS)
                pending.addOnCompleteListener complete@{ task ->
                    synchronized(lock) {
                        if (pushRegistration === pending) pushRegistration = null
                        deadline.cancel(false)
                        if (!answered.compareAndSet(false, true)) return@complete
                        val activeSession = session
                        if (generation != expectedGeneration || activeSession == null || activeSession.userId != expectedUser || pushStopped) {
                            call.reject("Профиль изменился", "SESSION_CHANGED")
                            return@complete
                        }
                        if (!task.isSuccessful) {
                            call.reject("Телефон не подключил сообщения сервера. Проверьте сеть и повторите.", "PUSH_REGISTRATION_FAILED")
                            return@complete
                        }
                        call.resolve(JSObject().put("token", task.result))
                    }
                }
            } catch (_: Exception) {
                call.reject("Не удалось подключить сообщения сервера", "PUSH_REGISTRATION_FAILED")
            }
        }
    }

    @PluginMethod
    fun activateRemotePush(call: PluginCall) {
        synchronized(lock) {
            try {
                loadSession()
                val expected = NativePushGeneration.parse(call.data.opt("expectedSessionGeneration"))
                val current = session
                if (current == null || expected == null || expected != generation || current.userId != call.getString("expectedUserId")) {
                    call.reject("Профиль изменился", "SESSION_CHANGED")
                    return
                }
                if (pushStopped || pushDeletion?.isComplete == false) {
                    call.reject("Подключение ещё закрывается. Повторите позже.", "PUSH_REGISTRATION_BUSY")
                    return
                }
                NativePushPolicy.activate(context, current, call.getString("ownerPublicId"))
                call.resolve()
            } catch (_: Exception) {
                call.reject("Не удалось сохранить подключение уведомлений", "STORAGE_UNAVAILABLE")
            }
        }
    }

    @PluginMethod
    fun stopRemotePush(call: PluginCall) {
        synchronized(lock) {
            val expected = NativePushGeneration.parse(call.data.opt("expectedSessionGeneration"))
            val expectedUserId = call.getString("expectedUserId")
            if (expected == null || expected != generation || expectedUserId != session?.userId) {
                call.resolve()
                return // A delayed old cleanup cannot disable the new session.
            }
            try {
                NativePushPolicy.clear(context)
            } catch (_: Exception) {
                call.reject("Не удалось сохранить отключение уведомлений", "STORAGE_UNAVAILABLE")
                return
            }
            // Local consent is already cleared. Firebase deletion may need the network: do not
            // block logout/UI, but never create or activate a token until the old operation ends.
            val alreadyStopped = pushStopped
            pushStopped = true
            if (NativePushPolicy.configured(context) && !alreadyStopped && pushDeletion?.isComplete != false) {
                pushDeletion = FirebaseMessaging.getInstance().deleteToken()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun getSafeArea(call: PluginCall) {
        activity.runOnUiThread { call.resolve(safeArea()) }
    }

    private fun safeArea(): JSObject {
        val decor = activity.window.decorView
        val windowInsets = ViewCompat.getRootWindowInsets(decor)
        val insets = windowInsets?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()) ?: Insets.NONE
        val density = context.resources.displayMetrics.density
        return JSObject().put("top", (insets.top / density).toDouble()).put("right", (insets.right / density).toDouble())
            .put("bottom", (insets.bottom / density).toDouble()).put("left", (insets.left / density).toDouble())
    }

    private fun publishSafeArea() {
        val value = safeArea()
        val serialized = value.toString()
        if (serialized != lastSafeArea) {
            lastSafeArea = serialized
            notifyListeners("safeAreaChange", value)
        }
    }

    private fun randomCode(): String {
        val random = ByteArray(32)
        SecureRandom().nextBytes(random)
        return Base64.encodeToString(random, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    override fun onTrimMemory(level: Int) {
        if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level == ComponentCallbacks2.TRIM_MEMORY_COMPLETE) {
            notifyListeners("memoryWarning", JSObject().put("level", level.toString()))
        }
    }

    override fun onLowMemory() {
        notifyListeners("memoryWarning", JSObject().put("level", "critical"))
    }

    override fun onConfigurationChanged(configuration: Configuration) = Unit

    override fun handleOnDestroy() {
        synchronized(lock) {
            login?.let { finishLogin(it, "AUTH_CANCELLED") }
            cancelAllRequests()
        }
        safeAreaListener?.let { listener ->
            activity.runOnUiThread { activity.window.decorView.removeOnLayoutChangeListener(listener) }
        }
        NativeSessionEvents.removeInvalidationListener(externalInvalidation)
        context.applicationContext.unregisterComponentCallbacks(this)
        workers.shutdownNow()
        timer.shutdownNow()
    }
}
