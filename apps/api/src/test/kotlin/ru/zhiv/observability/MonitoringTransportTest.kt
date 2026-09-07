package ru.zhiv.observability

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class MonitoringTransportTest {
    @Test
    fun `real transport rejects oversized bodies during streaming`() = runBlocking {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val executor = Executors.newFixedThreadPool(3)
        server.executor = executor
        server.createContext("/") { exchange ->
            try {
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.use { output -> repeat(300) { output.write(ByteArray(1024) { 32 }) } }
            } catch (_: Exception) {
                // Expected: the bounded client cancels the stream before accepting the whole body.
            } finally {
                exchange.close()
            }
        }
        server.start()
        try {
            val snapshot = MonitoringService("http://127.0.0.1:${server.address.port}").snapshot()
            assertFalse(snapshot.available)
            assertEquals("MONITORING_UNAVAILABLE", snapshot.error)
        } finally {
            server.stop(0)
            executor.shutdownNow()
        }
    }

    @Test
    fun `real transport refuses redirects instead of forwarding queries to another host`() = runBlocking {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val executor = Executors.newFixedThreadPool(3)
        val redirected = AtomicInteger()
        server.executor = executor
        server.createContext("/api/v1/") { exchange ->
            exchange.responseHeaders.set("Location", "http://127.0.0.1:${server.address.port}/unexpected")
            exchange.sendResponseHeaders(302, -1)
            exchange.close()
        }
        server.createContext("/unexpected") { exchange ->
            redirected.incrementAndGet()
            exchange.sendResponseHeaders(200, -1)
            exchange.close()
        }
        server.start()
        try {
            assertFalse(MonitoringService("http://127.0.0.1:${server.address.port}").snapshot().available)
            assertEquals(0, redirected.get())
        } finally {
            server.stop(0)
            executor.shutdownNow()
        }
    }
}
