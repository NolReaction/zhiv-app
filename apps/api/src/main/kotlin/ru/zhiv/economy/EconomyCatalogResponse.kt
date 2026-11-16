package ru.zhiv.economy

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import kotlinx.serialization.KSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.SerializersModule
import java.security.MessageDigest
import java.util.HexFormat

private const val CATALOG_HEADER = "X-Economy-Catalog"
private val catalogTag by lazy {
    val bytes = economyJson.encodeToString(EconomyRules.catalog).toByteArray(Charsets.UTF_8)
    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))
}

// Override only the catalog in an opt-in response. All changing player fields use
// their normal serializers, without first materializing a full catalog JSON tree.
private val compactJson = Json(economyJson) {
    serializersModule = SerializersModule {
        contextual(EconomyCatalog::class, object : KSerializer<EconomyCatalog> by EconomyCatalog.serializer() {
            override fun serialize(encoder: Encoder, value: EconomyCatalog) = encoder.encodeString(catalogTag)
        })
    }
}

internal suspend inline fun <reified T : Any> ApplicationCall.respondEconomySnapshot(value: T, catalog: EconomyCatalog) {
    response.header(HttpHeaders.Vary, CATALOG_HEADER)
    if (catalog === EconomyRules.catalog) {
        response.header(CATALOG_HEADER, catalogTag)
        if (request.headers[CATALOG_HEADER] == catalogTag) {
            respondText(compactJson.encodeToString(value), ContentType.Application.Json)
            return
        }
    }
    respond(value)
}
