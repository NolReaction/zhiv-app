package ru.zhiv.observability

import io.ktor.http.HttpHeaders
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import kotlinx.serialization.Serializable
import ru.zhiv.admin.AdminRepository
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.time.Instant

@Serializable
data class ApiRequestUsage(val startedAt: String, val requests: Long, val errors: Long, val throttled: Long)

@Serializable
data class ApiUsageSnapshot(
    val actorPublicId: String, val serverTime: String,
    val api: ApiRequestUsage, val maptiler: MapTilerUsageSnapshot,
)

/** Both session checks precede disclosure, including after a slow upstream response. */
fun Route.apiUsageRoutes(
    repository: AdminRepository, codec: TokenCodec, config: AppConfig,
    metrics: RuntimeMetrics, service: MapTilerUsageService,
) {
    rateLimit(RateLimitName("admin-read")) {
        get("/api/v1/admin/api-usage") {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            call.response.header("X-Robots-Tag", "noindex, nofollow")
            val raw = call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
            val hash = codec.hash(raw)
            val actor = repository.access(hash)
            val parameters = call.request.queryParameters
            val period = parameters.getAll("period")?.singleOrNull() ?: if (parameters["period"] == null) "current_billing_period" else ""
            if (parameters.names().any { it != "period" } || period !in MAPTILER_USAGE_PERIODS)
                throw AuthFailure("INVALID_ADMIN_QUERY", "Выберите период", 400)
            val usage = service.snapshot(period)
            if (repository.access(hash).publicId != actor.publicId)
                throw AuthFailure("ADMIN_FORBIDDEN", "Аккаунт администратора сменился. Откройте панель заново", 403)
            call.respond(ApiUsageSnapshot(actor.publicId, Instant.now().toString(), metrics.usageSnapshot(), usage))
        }
    }
}
