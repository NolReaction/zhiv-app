package ru.zhiv.economy

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.*
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayPresence
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.neighborSession(config: AppConfig,codec: TokenCodec,write: Boolean=false): ByteArray {
    response.header(HttpHeaders.CacheControl,"no-store")
    if(write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
    return codec.hash(sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401))
}
private fun invalidNeighbor(): Nothing = throw AuthFailure("INVALID_NEIGHBOR_SETTINGS","Некорректный запрос соседа",400)
private fun JsonElement.strictNeighborNumbers() {
    when(this) {
        is JsonObject -> for((key,value) in this) {
            if(key in setOf("expectedVersion","expectedTotalPrice","offerSlots","offerQuantity","sellPriceBps","buyPriceBps",
                "firstDelaySeconds","staleAfterSeconds","maxLotsPerDay","dailyBudgetCoins","maxLotCoins","globalDailyBudgetCoins","activeFromHourUtc","activeUntilHourUtc")) {
                val p=value as? JsonPrimitive ?: invalidNeighbor()
                if(p.isString || p.longOrNull==null) invalidNeighbor()
            }
            if(key=="buildings") {
                val b=value as? JsonObject ?: invalidNeighbor()
                if(b.values.any { (it as? JsonPrimitive)?.let { p -> p.isString || p.intOrNull==null } != false }) invalidNeighbor()
            }
            if(key in setOf("enabled","autoBuyEnabled")) {
                val p=value as? JsonPrimitive ?: invalidNeighbor()
                if(p.isString || p.booleanOrNull==null) invalidNeighbor()
            }
            value.strictNeighborNumbers()
        }
        is JsonArray -> forEach { it.strictNeighborNumbers() }
        else -> Unit
    }
}
fun decodeNeighborSettings(element: JsonElement): NeighborSettingsCommand {
    element.strictNeighborNumbers()
    return try { economyJson.decodeFromJsonElement<NeighborSettingsCommand>(element) }
    catch(_: SerializationException) { invalidNeighbor() }
}
fun decodeNeighborBuy(element: JsonElement): NeighborBuyCommand {
    element.strictNeighborNumbers()
    return try { economyJson.decodeFromJsonElement<NeighborBuyCommand>(element) }
    catch(_: SerializationException) { invalidNeighbor() }
}
fun Route.neighborRoutes(repository: NeighborRepository,codec: TokenCodec,config: AppConfig,presence: PresenceRepository?=null) {
    route("/api/v1/economy/neighbor") {
        install(RequestBodyLimit) { bodyLimit { 4096 } }
        rateLimit(RateLimitName("world-read")) {
            get {
                val hash=call.neighborSession(config,codec)
                if(!call.request.queryParameters.isEmpty()) invalidNeighbor()
                call.respond(repository.neighbor(hash))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/commands") {
                val hash=call.neighborSession(config,codec,true)
                call.requireGameplayPresence(presence,hash)
                val command=decodeEconomyCommand(call.receive<JsonElement>())
                NeighborRules.validatePurchase(command)
                call.respond(repository.purchase(hash,command))
            }
        }
    }
    route("/api/v1/admin/neighbor") {
        install(RequestBodyLimit) { bodyLimit { 16384 } }
        rateLimit(RateLimitName("admin-read")) {
            get {
                val hash=call.neighborSession(config,codec)
                if(call.request.queryParameters.entries().any { (k,v) -> k!="publicId" || v.size!=1 }) invalidNeighbor()
                call.respond(repository.admin(hash,call.request.queryParameters["publicId"]))
            }
        }
        rateLimit(RateLimitName("admin-write")) {
            post("/settings") { val hash=call.neighborSession(config,codec,true);call.respond(repository.settings(hash,decodeNeighborSettings(call.receive<JsonElement>()))) }
            post("/buy") { val hash=call.neighborSession(config,codec,true);call.respond(repository.buy(hash,decodeNeighborBuy(call.receive<JsonElement>()))) }
        }
    }
}
