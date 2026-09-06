package ru.zhiv

import io.ktor.http.HttpStatusCode
import io.ktor.http.HttpHeaders
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.PayloadTooLargeException
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.defaultheaders.DefaultHeaders
import io.ktor.server.plugins.forwardedheaders.ForwardedHeaders
import io.ktor.server.plugins.forwardedheaders.XForwardedHeaders
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.ContentTransformationException
import io.ktor.server.request.httpMethod
import io.ktor.server.response.header
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
import ru.zhiv.db.JdbcRelationshipRepository
import ru.zhiv.db.JdbcGroupRepository
import ru.zhiv.db.JdbcDirectInviteRepository
import ru.zhiv.db.JdbcCodeRecoveryRepository
import ru.zhiv.db.JdbcZhivRepository
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.sessionCookie
import io.ktor.server.application.ApplicationCall
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.identityRoutes
import ru.zhiv.groups.GroupRepository
import ru.zhiv.groups.groupRoutes
import ru.zhiv.health.JdbcReadinessProbe
import ru.zhiv.health.ReadinessProbe
import ru.zhiv.invites.DirectInviteRepository
import ru.zhiv.invites.directInviteRoutes
import ru.zhiv.recovery.CodeRecoveryRepository
import ru.zhiv.recovery.codeRecoveryRoutes
import ru.zhiv.game.gameEventRoutes
import ru.zhiv.observability.GameEventSink
import ru.zhiv.observability.Slf4jGameEventSink
import ru.zhiv.relationships.RelationshipRepository
import ru.zhiv.relationships.relationshipRoutes
import ru.zhiv.security.TokenCodec
import ru.zhiv.auth.*
import ru.zhiv.db.JdbcAuthRepository
import io.ktor.server.application.log

fun Application.module() {
    val config = AppConfig.fromEnvironment()
    val dataSource = DatabaseFactory.create(config)
    val repository = JdbcZhivRepository(dataSource)
    val relationships = JdbcRelationshipRepository(dataSource)
    val groups = JdbcGroupRepository(dataSource)
    val directInvites = JdbcDirectInviteRepository(dataSource)
    val recovery = JdbcCodeRecoveryRepository(dataSource)
    val authConfig = AuthConfig.fromEnvironment(System.getenv(), config.allowedOrigins)
    val telegram = if (authConfig.telegramEnabled) TelegramOidc(authConfig) else null
    val vk = if (authConfig.vkEnabled) VkId(authConfig) else null
    val mailer = if (authConfig.emailEnabled) SmtpLoginMailer(authConfig) else null

    monitor.subscribe(io.ktor.server.application.ApplicationStopped) {
        telegram?.close()
        vk?.close()
        dataSource.close()
    }
    installZhivApi(
        repository,
        repository,
        config,
        relationships = relationships,
        groups = groups,
        directInvites = directInvites,
        recovery = recovery,
        readiness = JdbcReadinessProbe(dataSource),
        auth = JdbcAuthRepository(dataSource),
        authConfig = authConfig,
        telegram = telegram,
        mailer = mailer,
        vk = vk,
    )
}

fun Application.installZhivApi(
    identities: IdentityRepository,
    checkIns: CheckInRepository,
    config: AppConfig,
    tokenCodec: TokenCodec = TokenCodec(),
    relationships: RelationshipRepository? = null,
    groups: GroupRepository? = null,
    directInvites: DirectInviteRepository? = null,
    recovery: CodeRecoveryRepository? = null,
    readiness: ReadinessProbe = ReadinessProbe { true },
    gameEvents: GameEventSink = Slf4jGameEventSink(),
    auth: AuthRepository? = null,
    authConfig: AuthConfig = AuthConfig(),
    telegram: TelegramVerifier? = null,
    mailer: LoginMailer? = null,
    vk: VkVerifier? = null,
) {
    install(DefaultHeaders)
    install(ForwardedHeaders)
    install(XForwardedHeaders)
    install(CallLogging) {
        level = Level.INFO
        disableDefaultColors()
        format { call ->
            "http_request method=${call.request.httpMethod.value} status=${call.response.status()?.value ?: 0}"
        }
    }
    install(RateLimit) {
        // Bound authentication lookups before the narrower account-specific buckets.
        global {
            rateLimiter(limit = 12_000, refillPeriod = 1.hours)
            requestKey { call -> clientIpKey(call) }
        }
        for ((name, limit) in listOf(
            "profile-read" to 600,
            "check-in-attempt" to 240,
            "relationships" to 2_400,
            "game-events" to 2_400,
            "account-recovery-write" to 30,
            "account-recovery-read" to 600,
        )) {
            register(RateLimitName(name)) {
                rateLimiter(limit = limit, refillPeriod = 1.hours)
                requestKey { call ->
                    val userId = call.sessionCookie(config)?.let { raw ->
                        identities.findSessionUserId(tokenCodec.hash(raw))
                    }
                    // Forged cookies share one anonymous budget; they cannot create new buckets.
                    userId?.let { "user:$it" } ?: "anonymous:${clientIpKey(call)}"
                }
            }
        }
        register(RateLimitName("bootstrap")) {
            rateLimiter(limit = 60, refillPeriod = 1.hours)
            requestKey { call -> clientIpKey(call) }
        }
        register(RateLimitName("auth-entry")) {
            rateLimiter(limit = 60, refillPeriod = 1.hours)
            requestKey { call -> clientIpKey(call) }
        }
        register(RateLimitName("account-recovery-redeem")) {
            rateLimiter(limit = 120, refillPeriod = 1.hours)
            requestKey { call -> clientIpKey(call) }
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
        exception<AuthFailure> { call, failure ->
            call.response.header(HttpHeaders.CacheControl, "no-store")
            call.respond(HttpStatusCode.fromValue(failure.status), ApiErrorResponse(failure.code, failure.message))
        }
        exception<BadRequestException> { call, _ ->
            call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_REQUEST", "Некорректный запрос"))
        }
        exception<PayloadTooLargeException> { call, _ ->
            call.respond(HttpStatusCode.PayloadTooLarge, ApiErrorResponse("PAYLOAD_TOO_LARGE", "Запрос слишком большой"))
        }
        exception<ContentTransformationException> { call, _ ->
            call.respond(
                HttpStatusCode.BadRequest,
                ApiErrorResponse("INVALID_JSON", "Некорректный JSON"),
            )
        }
        exception<SQLException> { call, cause ->
            if (cause.sqlState in setOf("40001", "40P01", "55P03", "57014")) {
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
            call.response.header(HttpHeaders.CacheControl, "no-store")
            call.respond(mapOf("status" to "ok"))
        }
        get("/readyz") {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            if (readiness.isReady()) {
                call.respond(mapOf("status" to "ready"))
            } else {
                call.respond(HttpStatusCode.ServiceUnavailable, mapOf("status" to "unavailable"))
            }
        }
        identityRoutes(identities, tokenCodec, config)
        auth?.let { authRoutes(it, identities, tokenCodec, config, authConfig, telegram, mailer, vk) }
        rateLimit(RateLimitName("check-in-attempt")) { checkInRoutes(checkIns, tokenCodec, config) }
        gameEventRoutes(identities, tokenCodec, config, gameEvents)
        relationships?.let { relationshipRoutes(it, tokenCodec, config) }
        groups?.let { groupRoutes(it, tokenCodec, config) }
        directInvites?.let { directInviteRoutes(it, tokenCodec, config) }
        recovery?.let { codeRecoveryRoutes(it, identities, tokenCodec, config) }
    }
}

private fun clientIpKey(call: ApplicationCall): String =
    call.request.headers["X-Forwarded-For"]?.substringAfterLast(',')?.trim()
        ?: call.request.headers["X-Real-IP"] ?: "direct-client"
