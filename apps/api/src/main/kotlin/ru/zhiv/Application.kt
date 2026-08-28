package ru.zhiv

import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.defaultheaders.DefaultHeaders
import io.ktor.server.plugins.forwardedheaders.ForwardedHeaders
import io.ktor.server.plugins.forwardedheaders.XForwardedHeaders
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.ContentTransformationException
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.serialization.json.Json
import org.slf4j.event.Level
import java.sql.SQLException
import kotlin.time.Duration.Companion.hours
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.checkInRoutes
import ru.zhiv.config.AppConfig
import ru.zhiv.db.DatabaseFactory
import ru.zhiv.db.JdbcZhivRepository
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.identityRoutes
import ru.zhiv.security.TokenCodec

fun Application.module() {
    val config = AppConfig.fromEnvironment()
    val dataSource = DatabaseFactory.create(config)
    DatabaseFactory.migrate(dataSource)
    val repository = JdbcZhivRepository(dataSource)

    monitor.subscribe(io.ktor.server.application.ApplicationStopped) {
        dataSource.close()
    }
    installZhivApi(repository, repository, config)
}

fun Application.installZhivApi(
    identities: IdentityRepository,
    checkIns: CheckInRepository,
    config: AppConfig,
    tokenCodec: TokenCodec = TokenCodec(),
) {
    install(DefaultHeaders)
    install(ForwardedHeaders)
    install(XForwardedHeaders)
    install(CallLogging) {
        level = Level.INFO
        disableDefaultColors()
    }
    install(RateLimit) {
        register(RateLimitName("bootstrap")) {
            rateLimiter(limit = 10, refillPeriod = 1.hours)
            requestKey { call ->
                call.request.headers["X-Forwarded-For"]?.substringAfterLast(',')?.trim()
                    ?: call.request.headers["X-Real-IP"]
                    ?: "direct-client"
            }
        }
    }
    install(ContentNegotiation) {
        json(Json {
            ignoreUnknownKeys = false
            explicitNulls = true
            encodeDefaults = true
        })
    }
    install(StatusPages) {
        exception<ContentTransformationException> { call, _ ->
            call.respond(
                HttpStatusCode.BadRequest,
                ApiErrorResponse("INVALID_JSON", "Некорректный JSON"),
            )
        }
        exception<SQLException> { call, cause ->
            if (cause.sqlState in setOf("55P03", "57014")) {
                call.respond(
                    HttpStatusCode.ServiceUnavailable,
                    ApiErrorResponse("DATABASE_BUSY", "Сервер занят, повторите запрос"),
                )
            } else {
                this@installZhivApi.log.error("Database error", cause)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiErrorResponse("INTERNAL_ERROR", "Внутренняя ошибка сервера"),
                )
            }
        }
        exception<Throwable> { call, cause ->
            this@installZhivApi.log.error("Unhandled API error", cause)
            call.respond(
                HttpStatusCode.InternalServerError,
                ApiErrorResponse("INTERNAL_ERROR", "Внутренняя ошибка сервера"),
            )
        }
    }

    routing {
        get("/healthz") {
            call.respond(mapOf("status" to "ok"))
        }
        identityRoutes(identities, tokenCodec, config)
        checkInRoutes(checkIns, tokenCodec, config)
    }
}
