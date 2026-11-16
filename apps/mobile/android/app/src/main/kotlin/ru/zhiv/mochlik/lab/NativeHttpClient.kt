package ru.zhiv.mochlik.lab

import com.getcapacitor.JSObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal object NativeHttpClient {
    private val client = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .callTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    class Cancelled : Exception()
    class TooLarge : Exception()

    class Transfer {
        val cancelled = AtomicBoolean(false)
        @Volatile var call: Call? = null

        fun cancel() {
            cancelled.set(true)
            call?.cancel()
        }
    }

    class Response(val status: Int, val headers: JSObject, val body: ByteArray)

    fun execute(
        uri: URI,
        method: String,
        headers: Map<String, String>,
        body: ByteArray?,
        token: String?,
        transfer: Transfer
    ): Response {
        if (transfer.cancelled.get()) throw Cancelled()
        val payload = if (method != "GET" && method != "HEAD") (body ?: byteArrayOf()).toRequestBody() else null
        val builder = Request.Builder().url(uri.toString()).method(method, payload)
            .header("User-Agent", "MochlikMobile/Android").header("Cache-Control", "no-store")
        for ((name, value) in headers) builder.header(name, value)
        if (token != null) builder.header("Authorization", "Bearer $token")
        val call = client.newCall(builder.build())
        transfer.call = call
        try {
            if (transfer.cancelled.get()) {
                call.cancel()
                throw Cancelled()
            }
            call.execute().use { response ->
                val status = response.code
                check(status !in 300..399 || status == 304) { "Redirect refused" }
                val responseHeaders = JSObject()
                for (name in response.headers.names()) {
                    if (NativeHttpPolicy.allowedResponseHeader(name)) {
                        val value = response.headers(name).joinToString(", ")
                        if (value.length <= 16384) responseHeaders.put(name, value)
                    }
                }
                val responseBody = response.body
                if (responseBody != null && responseBody.contentLength() > NativeHttpPolicy.MAX_RESPONSE_BYTES) throw TooLarge()
                val output = ByteArrayOutputStream()
                responseBody?.byteStream()?.use { stream ->
                    val chunk = ByteArray(8192)
                    while (true) {
                        val count = stream.read(chunk)
                        if (count == -1) break
                        if (transfer.cancelled.get()) throw Cancelled()
                        if (output.size() + count > NativeHttpPolicy.MAX_RESPONSE_BYTES) throw TooLarge()
                        output.write(chunk, 0, count)
                    }
                }
                if (transfer.cancelled.get()) throw Cancelled()
                return Response(status, responseHeaders, output.toByteArray())
            }
        } finally {
            transfer.call = null
        }
    }
}
