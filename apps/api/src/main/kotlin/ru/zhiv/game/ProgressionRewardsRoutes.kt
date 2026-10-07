package ru.zhiv.game

import io.ktor.http.HttpHeaders
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.*
import kotlinx.serialization.json.JsonElement
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayPresence
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

fun Route.progressionRewardsRoutes(repository: ProgressionRewardsRepository,codec: TokenCodec,config: AppConfig, presence: PresenceRepository? = null) {
    route("/api/v1/game/rewards") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        rateLimit(RateLimitName("world-read")) {
            get {
                call.response.header(HttpHeaders.CacheControl,"no-store")
                val hash=codec.hash(call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401))
                if(!call.request.queryParameters.isEmpty()) invalidRewardClaim()
                call.respond(repository.snapshot(hash))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/claims") {
                call.response.header(HttpHeaders.CacheControl,"no-store")
                if(!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
                val hash=codec.hash(call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401))
                call.requireGameplayPresence(presence, hash)
                call.respond(repository.claim(hash,decodeRewardClaim(call.receive<JsonElement>())))
            }
        }
    }
}
