package ru.zhiv.earth

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.application.install
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.contentType
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.route
import io.ktor.utils.io.readAvailable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.io.ByteArrayOutputStream

private val strictEarthJson=Json { ignoreUnknownKeys=false;isLenient=false;coerceInputValues=false }
private val EarthPrivacy=createRouteScopedPlugin("EarthPrivateResponses") {
    onCall { call -> call.response.header(HttpHeaders.CacheControl,"private, no-store");call.response.header("X-Robots-Tag","noindex, nofollow") }
}
private fun ApplicationCall.earthSession(config: AppConfig,codec: TokenCodec,writing: Boolean=false): ByteArray {
    if(writing && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
    val token=sessionCookie(config) ?: earthFailure("UNAUTHORIZED",401)
    if(!request.queryParameters.isEmpty()) invalidEarthSharing()
    if(writing && parseCanonicalUuidV4(request.headers["Idempotency-Key"])==null)
        throw AuthFailure("INVALID_IDEMPOTENCY_KEY","Некорректный ключ запроса",400)
    return codec.hash(token)
}
/** Enforce actual streamed bytes, including chunked/unknown Content-Length input. */
private suspend inline fun <reified T> ApplicationCall.earthBody(position: Boolean=false): T {
    if(!request.contentType().match(ContentType.Application.Json)) invalidEarthBody(position)
    val channel=receiveChannel();val out=ByteArrayOutputStream();val chunk=ByteArray(1024)
    while(true) {
        val count=channel.readAvailable(chunk,0,chunk.size)
        if(count<0) break
        if(count==0) continue
        if(out.size()+count>8192) {
            channel.cancel(null)
            throw AuthFailure("PAYLOAD_TOO_LARGE","Запрос слишком большой",413)
        }
        out.write(chunk,0,count)
    }
    return try { strictEarthJson.decodeFromString<T>(out.toString(Charsets.UTF_8)) }
    catch(_: SerializationException) { invalidEarthBody(position) }
    catch(_: IllegalArgumentException) { invalidEarthBody(position) }
}
private fun invalidEarthBody(position: Boolean): Nothing=if(position) invalidEarthPosition() else invalidEarthSharing()
private suspend inline fun <reified T: Any> ApplicationCall.earthResult(crossinline action: suspend ()->T) {
    try { respond(action()) }
    catch(error: EarthRateLimited) {
        response.header(HttpHeaders.RetryAfter,error.seconds.toString())
        respond(HttpStatusCode.TooManyRequests,ApiErrorResponse("EARTH_RATE_LIMITED","Слишком частое обновление. Повторите позже"))
    }
}
fun Route.earthLocationRoutes(repository: EarthLocationRepository,codec: TokenCodec,config: AppConfig) {
    route("/api/v1/earth") {
        install(EarthPrivacy)
        rateLimit(RateLimitName("earth-read")) {
            get("/sharing") { val hash=call.earthSession(config,codec);call.earthResult { repository.settings(hash) } }
            get("/people") { val hash=call.earthSession(config,codec);call.earthResult { repository.people(hash) } }
        }
        // Publication pacing lives after sequence/epoch checks in the repository.
        // Privacy commands have no shared GPS quota and never create notifications.
        put("/sharing") {
            val hash=call.earthSession(config,codec,true);val request=call.earthBody<EarthSharingWrite>()
            validateEarthSharing(request);call.earthResult { repository.share(hash,request) }
        }
        post("/sharing/resume") {
            val hash=call.earthSession(config,codec,true);val request=call.earthBody<EarthSharingResume>()
            validateEarthResume(request);call.earthResult { repository.resume(hash,request) }
        }
        put("/location") {
            val hash=call.earthSession(config,codec,true);val request=call.earthBody<EarthPositionWrite>(true)
            validateEarthPosition(request);call.earthResult { repository.publish(hash,request) }
        }
        delete("/location") {
            val hash=call.earthSession(config,codec,true);val request=call.earthBody<EarthPositionStop>(true)
            validateEarthStop(request);call.earthResult { repository.stop(hash,request) }
        }
    }
}
