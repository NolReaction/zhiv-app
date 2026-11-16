package ru.zhiv.economy

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayPresence
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

@Serializable
private data class ReleaseFeatures(val boatFishingEnabled: Boolean, val boatFishingPlayActions: Set<String>)

private val releaseFeatures: ReleaseFeatures = checkNotNull(
    ReleaseFeatures::class.java.getResourceAsStream("/world/release-features.json")
).bufferedReader().use { economyJson.decodeFromString<ReleaseFeatures>(it.readText()) }

private fun ApplicationCall.economySession(config: AppConfig, codec: TokenCodec, write: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    if (write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val token = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(token)
}
fun Route.economyRoutes(
    repository: EconomyRepository,
    codec: TokenCodec,
    config: AppConfig,
    presence: PresenceRepository? = null,
    boatFishingEnabled: Boolean = releaseFeatures.boatFishingEnabled,
) {
    route("/api/v1/economy") {
        rateLimit(RateLimitName("world-read")) {
            get {
                val hash = call.economySession(config, codec)
                if (!call.request.queryParameters.isEmpty()) invalidEconomy()
                val snapshot = repository.snapshot(hash)
                call.respondEconomySnapshot(snapshot, snapshot.catalog)
            }
        }
        rateLimit(RateLimitName("economy-write")) {
            route("/commands") {
                // A bounded 600-tick boat trace is larger than ordinary command payloads.
                install(RequestBodyLimit) { bodyLimit { 32_768 } }
                post {
                    val hash = call.economySession(config, codec, true)
                    call.requireGameplayPresence(presence, hash)
                    val command = decodeEconomyCommand(call.receive<JsonElement>())
                    if (!boatFishingEnabled && command.action in releaseFeatures.boatFishingPlayActions)
                        economyFailure("ECONOMY_BOAT_PAUSED", "Лодочная рыбалка временно закрыта")
                    val result = repository.command(hash, command)
                    call.respondEconomySnapshot(result, result.state.catalog)
                }
            }
        }
    }
}
