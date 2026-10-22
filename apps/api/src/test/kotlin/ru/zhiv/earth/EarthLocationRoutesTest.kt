package ru.zhiv.earth

import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.http.content.OutgoingContent
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.writeFully
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class EarthLocationRoutesTest {
    private val config=AppConfig("unused","unused","unused",true,setOf("https://im-alive.ru"))
    private val owner="0000-0000-0001"
    private val epoch=UUID.randomUUID().toString()
    private val sharing=EarthSharingWrite(owner,0,"SHARING","APPROXIMATE",listOf(UUID.randomUUID().toString()),60)
    private val position=EarthPositionWrite(owner,epoch,1,55.75,37.62,5.0,Instant.now().toString())
    private class Fake: EarthLocationRepository {
        var calls=0;var limited=false
        private val now=Instant.now().toString()
        private fun touch() { calls++;if(limited) throw EarthRateLimited(30) }
        override suspend fun settings(sessionHash: ByteArray): EarthSharingSettings { touch();return EarthSharingSettings("0000-0000-0001","OFF",0,"APPROXIMATE",emptyList(),null,null,now) }
        override suspend fun share(sessionHash: ByteArray,request: EarthSharingWrite): EarthSharingSettings { touch();return EarthSharingSettings(request.expectedOwnerPublicId,request.mode,1,request.precision,request.recipientCircleIds,null,UUID.randomUUID().toString(),now) }
        override suspend fun resume(sessionHash: ByteArray,request: EarthSharingResume): EarthSharingSettings { touch();return EarthSharingSettings(request.expectedOwnerPublicId,"SHARING",request.expectedRevision+1,"PRECISE",emptyList(),null,UUID.randomUUID().toString(),now) }
        override suspend fun publish(sessionHash: ByteArray,request: EarthPositionWrite): EarthPositionReceipt { touch();return EarthPositionReceipt(request.expectedOwnerPublicId,now,now,now) }
        override suspend fun stop(sessionHash: ByteArray,request: EarthPositionStop): EarthPositionStopped { touch();return EarthPositionStopped(request.expectedOwnerPublicId,now) }
        override suspend fun people(sessionHash: ByteArray): EarthPeopleResponse { touch();return EarthPeopleResponse("0000-0000-0001",emptyList(),now) }
    }
    private fun ApplicationTestBuilder.setup(repo: Fake) {
        application {
            install(ContentNegotiation) { json(Json { encodeDefaults=true;explicitNulls=true }) }
            install(RateLimit) { register(RateLimitName("earth-read")) { rateLimiter(limit=100,refillPeriod=1.hours) } }
            install(StatusPages) { exception<AuthFailure> { call,error -> call.respond(HttpStatusCode.fromValue(error.status),ApiErrorResponse(error.code,error.message)) } }
            routing { earthLocationRoutes(repo,TokenCodec(),config) }
        }
    }
    private fun HttpRequestBuilder.auth() {
        cookie(config.cookieName,"test-session");header(HttpHeaders.Origin,"https://im-alive.ru")
        header("Idempotency-Key",UUID.randomUUID().toString());contentType(ContentType.Application.Json)
    }
    @Test fun `private routes require session trusted origin and UUID write keys`()=testApplication {
        val repo=Fake();setup(repo)
        for(path in listOf("/api/v1/earth/sharing","/api/v1/earth/people")) {
            val response=client.get(path)
            assertEquals(HttpStatusCode.Unauthorized,response.status)
            assertEquals("private, no-store",response.headers[HttpHeaders.CacheControl])
        }
        val forbidden=client.put("/api/v1/earth/sharing") { cookie(config.cookieName,"test");setBody(Json.encodeToString(sharing)) }
        assertEquals(HttpStatusCode.Forbidden,forbidden.status)
        val noKey=client.put("/api/v1/earth/sharing") { cookie(config.cookieName,"test");header(HttpHeaders.Origin,"https://im-alive.ru");contentType(ContentType.Application.Json);setBody(Json.encodeToString(sharing)) }
        assertEquals(HttpStatusCode.BadRequest,noKey.status)
        assertContains(noKey.bodyAsText(),"INVALID_IDEMPOTENCY_KEY")
        assertEquals(0,repo.calls)
        assertEquals(HttpStatusCode.OK,client.get("/api/v1/earth/sharing") { auth() }.status)
        assertEquals(HttpStatusCode.OK,client.put("/api/v1/earth/sharing") { auth();setBody(Json.encodeToString(sharing)) }.status)
        assertEquals(HttpStatusCode.OK,client.post("/api/v1/earth/sharing/resume") { auth();setBody(Json.encodeToString(EarthSharingResume(owner,1))) }.status)
        assertEquals(HttpStatusCode.OK,client.put("/api/v1/earth/location") { auth();setBody(Json.encodeToString(position)) }.status)
        assertEquals(HttpStatusCode.OK,client.delete("/api/v1/earth/location") { auth();setBody(Json.encodeToString(EarthPositionStop(owner,epoch))) }.status)
    }
    @Test fun `strict JSON no URL coordinates and invalid inputs never touch storage`()=testApplication {
        val repo=Fake();setup(repo)
        for(body in listOf("{}",Json.encodeToString(sharing).dropLast(1)+",\"latitude\":55}",Json.encodeToString(sharing.copy(durationMinutes=30)))) {
            val response=client.put("/api/v1/earth/sharing") { auth();setBody(body) }
            assertEquals(HttpStatusCode.BadRequest,response.status)
            assertContains(response.bodyAsText(),"INVALID_EARTH_SHARING")
        }
        val badPosition=client.put("/api/v1/earth/location") { auth();setBody(Json.encodeToString(position.copy(latitude=91.0))) }
        assertEquals(HttpStatusCode.BadRequest,badPosition.status);assertContains(badPosition.bodyAsText(),"INVALID_EARTH_POSITION")
        assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/earth/people?latitude=55") { auth() }.status)
        assertEquals(HttpStatusCode.BadRequest,client.put("/api/v1/earth/sharing?longitude=37") { auth();setBody(Json.encodeToString(sharing)) }.status)
        for(body in listOf("{}",Json.encodeToString(EarthSharingResume(owner,-1)),"""{"expectedOwnerPublicId":"$owner","expectedRevision":0,"durationMinutes":null}""")) {
            assertEquals(HttpStatusCode.BadRequest,client.post("/api/v1/earth/sharing/resume") { auth();setBody(body) }.status)
        }
        assertEquals(0,repo.calls)
    }
    @Test fun `unknown streamed length is bounded by actual bytes and rate failures stay private`()=testApplication {
        val repo=Fake();setup(repo)
        val response=client.put("/api/v1/earth/location") {
            auth();setBody(object: OutgoingContent.WriteChannelContent() {
                override val contentType=ContentType.Application.Json
                override suspend fun writeTo(channel: ByteWriteChannel) { channel.writeFully(" ".repeat(8193).toByteArray()) }
            })
        }
        assertEquals(HttpStatusCode.PayloadTooLarge,response.status)
        assertEquals("private, no-store",response.headers[HttpHeaders.CacheControl]);assertEquals(0,repo.calls)
        repo.limited=true
        val limited=client.put("/api/v1/earth/location") { auth();setBody(Json.encodeToString(position)) }
        assertEquals(HttpStatusCode.TooManyRequests,limited.status)
        assertEquals("30",limited.headers[HttpHeaders.RetryAfter]);assertContains(limited.bodyAsText(),"EARTH_RATE_LIMITED")
        assertEquals("private, no-store",limited.headers[HttpHeaders.CacheControl])
        assertFalse(limited.bodyAsText().contains("latitude"))
    }
}
