package ru.zhiv.onboarding

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
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.http.parsePublicId
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayGeneration
import ru.zhiv.security.TokenCodec

fun Route.onboardingRoutes(repository: OnboardingRepository, codec: TokenCodec, config: AppConfig, presence: PresenceRepository? = null) {
    route("/api/v1/onboarding") {
        install(RequestBodyLimit) { bodyLimit { 1_024 } }
        rateLimit(RateLimitName("world-read")) {
            get {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                val hash = codec.hash(call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401))
                call.requireGameplayGeneration(presence, hash)
                if (call.request.queryParameters.names() != setOf("ownerPublicId") || call.request.queryParameters.getAll("ownerPublicId")?.size != 1) invalidOnboarding()
                val owner = call.request.queryParameters["ownerPublicId"] ?: invalidOnboarding()
                if (parsePublicId(owner) != owner) invalidOnboarding()
                call.respond(repository.read(hash, owner))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
                val hash = codec.hash(call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401))
                call.requireGameplayGeneration(presence, hash)
                if (!call.request.queryParameters.isEmpty()) invalidOnboarding()
                call.respond(repository.save(hash, decodeOnboarding(call.receive<JsonElement>())))
            }
        }
    }
}
