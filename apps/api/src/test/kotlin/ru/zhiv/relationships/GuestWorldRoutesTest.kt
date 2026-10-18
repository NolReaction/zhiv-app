package ru.zhiv.relationships

import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
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
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.EconomyCommand
import ru.zhiv.economy.EconomyResult
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class GuestWorldRoutesTest {
    private val config=AppConfig("unused","unused","unused",true,setOf("https://im-alive.ru"))
    private val circle=UUID.randomUUID()
    private val path="/api/v1/people/$circle/world"
    private val command=EconomyCommand(UUID.randomUUID().toString(),"0000-0000-0001",0,"buy_listing",UUID.randomUUID().toString(),2,20)
    private class Fake : GuestWorldRepository {
        var reads=0;var purchases=0;var lastCircle: UUID?=null;var received: EconomyCommand?=null
        override suspend fun world(sessionHash: ByteArray,circleId: UUID): GuestWorld {
            reads++;lastCircle=circleId
            return GuestWorld("0000-0000-0001",circleId.toString(),GuestProfileUser("0000-0000-0002","Друг"),
                "2026-10-19T00:00:00Z",GuestWorldRules.scene(null,null,emptyList()),GuestWorldMarket(emptyList(),false,"buyer_locked"))
        }
        override suspend fun purchase(sessionHash: ByteArray,circleId: UUID,command: EconomyCommand): EconomyResult {
            purchases++;lastCircle=circleId;received=command
            throw AuthFailure("ECONOMY_REVISION_CONFLICT","Обновите хозяйство",409)
        }
    }
    private fun ApplicationTestBuilder.setup(repo: Fake) {
        application {
            install(ContentNegotiation) { json(Json { encodeDefaults=true;explicitNulls=true }) }
            install(RateLimit) { listOf("world-read","world-write").forEach { name ->
                register(RateLimitName(name)) { rateLimiter(limit=100,refillPeriod=1.hours) }
            } }
            install(StatusPages) { exception<AuthFailure> { call,error ->
                call.respond(HttpStatusCode.fromValue(error.status),ApiErrorResponse(error.code,error.message))
            } }
            routing { guestWorldRoutes(repo,TokenCodec(),config) }
        }
    }
    private fun HttpRequestBuilder.authorized(origin: Boolean=true) {
        cookie(config.cookieName,"test-session")
        if (origin) header(HttpHeaders.Origin,"https://im-alive.ru")
        contentType(ContentType.Application.Json)
    }

    @Test fun `guest reads require session valid relationship scope and no extra query fields`() = testApplication {
        val repo=Fake();setup(repo)
        assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
        assertEquals(HttpStatusCode.BadRequest,client.get("$path?include=wallet"){authorized()}.status)
        assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/people/not-a-uuid/world"){authorized()}.status)
        assertEquals(0,repo.reads)
        val response=client.get(path){authorized()}
        assertEquals(HttpStatusCode.OK,response.status);assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
        assertEquals(circle,repo.lastCircle);assertEquals(1,repo.reads)
        assertContains(response.bodyAsText(),"\"head\":null");assertContains(response.bodyAsText(),"\"reason\":\"buyer_locked\"")
    }

    @Test fun `purchases reject untrusted origin and scope changes before repository access`() = testApplication {
        val repo=Fake();setup(repo)
        assertEquals(HttpStatusCode.Unauthorized,client.post("$path/market/commands"){setBody(Json.encodeToString(command))}.status)
        assertEquals(HttpStatusCode.Forbidden,client.post("$path/market/commands"){authorized(false);setBody(Json.encodeToString(command))}.status)
        assertEquals(HttpStatusCode.BadRequest,client.post("$path/market/commands?seller=other"){authorized();setBody(Json.encodeToString(command))}.status)
        assertEquals(0,repo.purchases)
    }

    @Test fun `guest purchase decoder rejects other actions unknown fields and quoted numbers`() = testApplication {
        val repo=Fake();setup(repo)
        for (body in listOf(Json.encodeToString(command.copy(action="cancel_listing",quantity=1,totalPrice=0)),
            Json.encodeToString(command).dropLast(1)+",\"seller\":\"fake\"}",
            Json.encodeToString(command).replace("\"expectedRevision\":0","\"expectedRevision\":\"0\""))) {
            assertEquals(HttpStatusCode.BadRequest,client.post("$path/market/commands"){authorized();setBody(body)}.status)
        }
        assertEquals(0,repo.purchases)
    }

    @Test fun `valid purchase binds the path friend and returns authoritative error without cache`() = testApplication {
        val repo=Fake();setup(repo)
        val response=client.post("$path/market/commands"){authorized();setBody(Json.encodeToString(command))}
        assertEquals(HttpStatusCode.Conflict,response.status);assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
        assertEquals(1,repo.purchases);assertEquals(circle,repo.lastCircle);assertEquals(command,repo.received)
        assertContains(response.bodyAsText(),"ECONOMY_REVISION_CONFLICT")
    }
}
