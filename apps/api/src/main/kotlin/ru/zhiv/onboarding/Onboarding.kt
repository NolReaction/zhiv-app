package ru.zhiv.onboarding

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parsePublicId

@Serializable data class OnboardingView(val ownerPublicId: String, val app: String?, val world: String?)
@Serializable data class OnboardingDecision(val ownerPublicId: String, val course: String, val status: String)
interface OnboardingRepository {
    suspend fun read(hash: ByteArray, owner: String): OnboardingView
    suspend fun save(hash: ByteArray, decision: OnboardingDecision): OnboardingView
}
fun invalidOnboarding(): Nothing = throw AuthFailure("INVALID_ONBOARDING", "Некорректный запрос обучения", 400)
fun validateOnboarding(value: OnboardingDecision) {
    if (parsePublicId(value.ownerPublicId) != value.ownerPublicId || value.course !in setOf("app", "world")
        || value.status !in setOf("completed", "skipped")) invalidOnboarding()
}
fun decodeOnboarding(value: JsonElement): OnboardingDecision {
    val fields = value as? JsonObject ?: invalidOnboarding()
    if (fields.keys != setOf("ownerPublicId", "course", "status") || fields.values.any { it !is JsonPrimitive || !it.isString }) invalidOnboarding()
    return OnboardingDecision(fields.getValue("ownerPublicId").jsonPrimitive.content,
        fields.getValue("course").jsonPrimitive.content, fields.getValue("status").jsonPrimitive.content).also(::validateOnboarding)
}
