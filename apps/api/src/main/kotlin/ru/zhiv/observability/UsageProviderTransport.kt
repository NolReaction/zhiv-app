package ru.zhiv.observability

import ru.zhiv.config.MapTilerServiceToken
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.Flow
import java.util.concurrent.TimeUnit

/** Bounded streamed body and full-response deadline, including stalled response bodies. */
internal class HttpUsageProviderTransport : UsageProviderTransport {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
        .followRedirects(HttpClient.Redirect.NEVER).build()

    override fun read(uri: URI, token: MapTilerServiceToken): UsageProviderResponse {
        val request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(4))
            .header("Accept", "application/json").header("Authorization", token.authorization()).GET().build()
        val body = UsageBodySubscriber()
        val pending = client.sendAsync(request) { body }
        return try {
            val response = pending.get(5, TimeUnit.SECONDS)
            UsageProviderResponse(response.statusCode(), response.body())
        } catch (_: Exception) {
            body.cancel()
            pending.cancel(true)
            // Exceptions can contain request/header/body material; never propagate them.
            throw IllegalStateException("Usage provider unavailable")
        }
    }
}

private class UsageBodySubscriber : HttpResponse.BodySubscriber<String> {
    private val result = CompletableFuture<String>()
    private val bytes = ByteArrayOutputStream()
    @Volatile private var subscription: Flow.Subscription? = null
    override fun getBody(): CompletionStage<String> = result
    override fun onSubscribe(value: Flow.Subscription) {
        subscription = value
        if (result.isDone) value.cancel() else value.request(1)
    }
    override fun onNext(items: List<ByteBuffer>) {
        for (item in items) {
            if (item.remaining() > USAGE_RESPONSE_LIMIT - bytes.size()) { cancel(); return }
            val chunk = ByteArray(item.remaining())
            item.get(chunk)
            bytes.write(chunk)
        }
        subscription?.request(1)
    }
    override fun onError(throwable: Throwable) { result.completeExceptionally(throwable) }
    override fun onComplete() { result.complete(bytes.toString(StandardCharsets.UTF_8)) }
    fun cancel() {
        result.completeExceptionally(IllegalStateException("Usage response unavailable"))
        subscription?.cancel()
    }
}
