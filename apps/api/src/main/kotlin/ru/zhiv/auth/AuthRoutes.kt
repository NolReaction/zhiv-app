package ru.zhiv.auth

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondRedirect
import io.ktor.server.routing.*
import io.ktor.server.application.install
import ru.zhiv.config.AppConfig
import ru.zhiv.http.*
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.security.TokenCodec
import java.security.SecureRandom
import java.util.Base64

fun Route.authRoutes(repository: AuthRepository, identities: IdentityRepository, tokens: TokenCodec, app: AppConfig, config: AuthConfig, telegram: TelegramVerifier?, mailer: LoginMailer?) {
    val browserCookie = if (app.production) "__Host-zhiv_login" else "zhiv_login_dev"
    val random = SecureRandom()
    fun ApplicationCall.noStore() {
        response.header(HttpHeaders.CacheControl, "no-store")
        response.header("Referrer-Policy", "no-referrer")
    }
    fun ApplicationCall.trusted() { if (!isTrustedWrite(app)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403) }
    fun ApplicationCall.sessionHash(): ByteArray = sessionCookie(app)?.let(tokens::hash) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    fun ApplicationCall.browserHash(): ByteArray = request.cookies[browserCookie]?.takeIf { Regex("^[A-Za-z0-9_-]{43}$").matches(it) }?.let(tokens::hash) ?: throw AuthFailure("AUTH_EXPIRED", "Откройте вход заново в этом браузере")
    fun ApplicationCall.setBrowser(raw: String) {
        response.headers.append(HttpHeaders.SetCookie, "$browserCookie=$raw; Max-Age=600; Path=/; HttpOnly; SameSite=Lax" + if (app.production) "; Secure" else "")
    }
    suspend fun ApplicationCall.start(provider: String) {
        noStore(); trusted()
        if ((provider == "telegram" && telegram == null) || (provider == "email" && mailer == null)) throw AuthFailure("AUTH_UNAVAILABLE", "Этот способ входа пока недоступен", 503)
        val body = receive<AuthStartRequest>()
        if (body.intent !in setOf("login", "register", "link")) throw AuthFailure("INVALID_REQUEST", "Некорректный запрос")
        val currentHash = sessionCookie(app)?.let(tokens::hash)
        val currentUser = currentHash?.let { identities.findSessionUserId(it) }
        if (body.intent == "link" && currentUser == null) throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
        if (body.intent != "link" && currentUser != null) throw AuthFailure("AUTH_USE_LINK", "Привяжите способ входа в открытом профиле", 409)
        val name = if (body.intent == "register") loginDisplayName(body.displayName) ?: throw AuthFailure("INVALID_DISPLAY_NAME", "Введите имя длиной до 50 символов") else null
        val email = if (provider == "email") normalizedEmail(body.email.orEmpty()) ?: throw AuthFailure("INVALID_EMAIL", "Введите адрес почты") else null
        val state = tokens.issue(); val browser = tokens.issue(); val verifier = tokens.issue().raw; val nonce = tokens.issue().raw
        val code = (100_000 + random.nextInt(900_000)).toString()
        val flow = LoginFlow(state.hash, browser.hash, provider, body.intent, if (body.intent == "link") currentHash else null, name, email, if (provider == "telegram") verifier else null, if (provider == "telegram") nonce else null, if (provider == "email") codeDigest(config.codeSecret, state.raw, code) else null)
        repository.create(flow)
        if (email != null) requireNotNull(mailer).send(email, code)
        setBrowser(browser.raw)
        val url = if (provider == "telegram") "https://oauth.telegram.org/auth?" + formEncode(mapOf(
            "client_id" to config.telegramClientId, "redirect_uri" to config.callback, "response_type" to "code", "scope" to "openid",
            "state" to state.raw, "nonce" to nonce, "code_challenge" to Base64.getUrlEncoder().withoutPadding().encodeToString(tokens.hash(verifier)), "code_challenge_method" to "S256",
        )) else null
        respond(AuthStartResponse(state.raw, url))
    }

    route("/api/v1/auth") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        get("/options") { call.noStore(); call.respond(AuthOptions(telegram != null, mailer != null)) }
        rateLimit(RateLimitName("auth-entry")) {
            post("/telegram/start") { call.start("telegram") }
            post("/email/start") { call.start("email") }
            post("/email/verify") {
                call.noStore(); call.trusted()
                if (mailer == null) throw AuthFailure("AUTH_UNAVAILABLE", "Вход по почте пока недоступен", 503)
                val body = call.receive<EmailVerifyRequest>()
                if (!Regex("^[A-Za-z0-9_-]{43}$").matches(body.flow) || !Regex("^[0-9]{6}$").matches(body.code)) throw AuthFailure("INVALID_REQUEST", "Введите шестизначный код из письма")
                val flow = repository.verifyEmail(tokens.hash(body.flow), call.browserHash(), codeDigest(config.codeSecret, body.flow, body.code))
                val token = tokens.issue()
                repository.finish(flow, requireNotNull(flow.subject), token.hash, app.sessionDays, deviceLabel(call.request.headers[HttpHeaders.UserAgent].orEmpty()))
                if (flow.intent != "link") call.response.headers.append(HttpHeaders.SetCookie, sessionCookieHeader(app, token.raw))
                call.respond(AuthDone())
            }
            get("/telegram/callback") {
                call.noStore()
                val outcome = try {
                    if (telegram == null) throw AuthFailure("AUTH_UNAVAILABLE", "Telegram недоступен")
                    val state = call.request.queryParameters["state"].orEmpty()
                    if (!Regex("^[A-Za-z0-9_-]{43}$").matches(state)) throw AuthFailure("AUTH_EXPIRED", "Запрос входа недействителен")
                    val flow = repository.takeTelegram(tokens.hash(state), call.browserHash())
                    val code = call.request.queryParameters["code"].orEmpty()
                    if (code.isBlank() || code.length > 4096) throw AuthFailure("TELEGRAM_LOGIN_FAILED", "Вход отменён")
                    val identity = telegram.verify(code, flow)
                    val token = tokens.issue()
                    repository.finish(flow, identity.subject, token.hash, app.sessionDays, deviceLabel(call.request.headers[HttpHeaders.UserAgent].orEmpty()))
                    if (flow.intent != "link") call.response.headers.append(HttpHeaders.SetCookie, sessionCookieHeader(app, token.raw))
                    if (flow.intent == "link") "linked" else "signed-in"
                } catch (failure: AuthFailure) { failure.code.lowercase(java.util.Locale.ROOT) }
                call.respondRedirect("/?auth=$outcome")
            }
        }
        rateLimit(RateLimitName("profile-read")) {
            get("/account") { call.noStore(); call.respond(repository.access(call.sessionHash())) }
            delete("/sessions/{id}") {
                call.noStore(); call.trusted()
                val id = parseCanonicalUuid(call.parameters["id"]) ?: throw AuthFailure("INVALID_REQUEST", "Некорректный сеанс")
                repository.revoke(call.sessionHash(), target = id); call.respond(AuthDone())
            }
            post("/sessions/revoke-others") { call.noStore(); call.trusted(); repository.revoke(call.sessionHash(), others = true); call.respond(AuthDone()) }
            post("/logout") {
                call.noStore(); call.trusted(); repository.revoke(call.sessionHash())
                call.response.headers.append(HttpHeaders.SetCookie, "${app.cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax" + if (app.production) "; Secure" else "")
                call.respond(AuthDone())
            }
        }
    }
}
