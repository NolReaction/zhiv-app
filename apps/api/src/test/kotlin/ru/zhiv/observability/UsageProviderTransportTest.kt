package ru.zhiv.observability

import com.sun.net.httpserver.HttpServer
import ru.zhiv.config.MapTilerServiceToken
import java.net.InetSocketAddress
import java.net.URI
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.*

class UsageProviderTransportTest {
    private fun token(): MapTilerServiceToken {
        val path = Files.createTempFile("usage-token-", ".txt")
        return try { Files.writeString(path, "fixture-service-token"); MapTilerServiceToken.fromFile(path.toString()) }
        finally { Files.deleteIfExists(path) }
    }

    @Test fun `real transport uses header authorization and never follows a redirect`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val executor = Executors.newFixedThreadPool(3)
        val redirected = AtomicInteger()
        var receivedAuthorization: String? = null
        server.executor = executor
        server.createContext("/usage") { exchange ->
            receivedAuthorization = exchange.requestHeaders.getFirst("Authorization")
            exchange.responseHeaders.set("Location", "http://127.0.0.1:${server.address.port}/unexpected")
            exchange.sendResponseHeaders(302, -1); exchange.close()
        }
        server.createContext("/unexpected") { exchange ->
            redirected.incrementAndGet(); exchange.sendResponseHeaders(200, -1); exchange.close()
        }
        server.start()
        try {
            val result = HttpUsageProviderTransport().read(URI("http://127.0.0.1:${server.address.port}/usage"), token())
            assertEquals(302, result.status)
            assertEquals("Token fixture-service-token", receivedAuthorization)
            assertEquals(0, redirected.get())
        } finally { server.stop(0); executor.shutdownNow() }
    }

    @Test fun `real transport cancels streamed oversized and stalled bodies within the total deadline`() {
        for (stall in listOf(false, true)) {
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            val executor = Executors.newFixedThreadPool(2)
            server.executor = executor
            server.createContext("/") { exchange ->
                try {
                    exchange.sendResponseHeaders(200, 0)
                    exchange.responseBody.use { output ->
                        if (stall) { output.write(32); output.flush(); Thread.sleep(20_000) }
                        else repeat(USAGE_RESPONSE_LIMIT / 1024 + 2) { output.write(ByteArray(1024) { 32 }) }
                    }
                } catch (_: Exception) { /* Expected cancellation of an invalid or stalled response. */ }
                finally { exchange.close() }
            }
            server.start()
            try {
                val started = System.nanoTime()
                val failure = assertFails { HttpUsageProviderTransport().read(URI("http://127.0.0.1:${server.address.port}/"), token()) }
                assertTrue((System.nanoTime() - started) / 1_000_000 < 6_000)
                assertEquals("Usage provider unavailable", failure.message)
                assertNull(failure.cause)
            } finally { server.stop(0); executor.shutdownNow() }
        }
    }
}
