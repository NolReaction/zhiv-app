package ru.zhiv.game

import io.ktor.http.HttpHeaders
import io.ktor.http.Parameters
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
import ru.zhiv.economy.EconomyRules
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
                val catalog = requestedRewardCatalog(call.request.queryParameters)
                call.respond(rewardCatalogView(repository.snapshot(hash), catalog))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/claims") {
                call.response.header(HttpHeaders.CacheControl,"no-store")
                if(!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
                val hash=codec.hash(call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401))
                call.requireGameplayPresence(presence, hash)
                val catalog = requestedRewardCatalog(call.request.queryParameters)
                requireCurrentRewardClaimCatalog(catalog)
                val result = repository.claim(hash,decodeRewardClaim(call.receive<JsonElement>()))
                call.respond(result.copy(rewards = rewardCatalogView(result.rewards, catalog)))
            }
        }
    }
}

/** Cached clients retain readable 21/33-row previews while their bundle updates. */
internal fun requestedRewardCatalog(parameters: Parameters): Int {
    if (parameters.isEmpty()) return 4
    if (parameters.names() != setOf("catalog") || parameters.getAll("catalog")?.size != 1) invalidRewardClaim()
    return when (parameters["catalog"]) { "4" -> 4; "5" -> 5; "6" -> 6; "7" -> 7; "8" -> 8; else -> invalidRewardClaim() }
}
internal fun rewardCatalogView(value: ProgressionRewardsView, catalog: Int): ProgressionRewardsView =
    if (catalog >= 8) value.copy(catalogVersion = catalog)
    else value.copy(catalogVersion = catalog, achievementRewards = value.achievementRewards
        .filter { it.level <= GameRewards.legacyTiers.getValue(it.achievementId).size }.take(if (catalog >= 5) 33 else 21))

/** A catalog <=7 client cannot parse the mandatory economy 15 claim snapshot.
 * Fail before repository.claim so a rejected response never hides a new payout. */
internal fun requireCurrentRewardClaimCatalog(catalog: Int, economyVersion: Int = EconomyRules.catalog.version) {
    if (catalog < 8 && economyVersion >= 15) rewardFailure("APP_UPDATE_REQUIRED",
        "Обновите приложение, чтобы получить награду. Сохранённые награды останутся доступны.")
}
