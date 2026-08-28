package ru.zhiv.http

import kotlinx.serialization.Serializable

@Serializable
data class PublicUserDto(
    val publicId: String,
    val displayName: String,
)

@Serializable
data class MeResponse(
    val user: PublicUserDto,
    val lastCheckInAt: String?,
    val serverTime: String,
)

@Serializable
data class BootstrapRequest(val displayName: String)

@Serializable
data class CheckInResponse(
    val eventId: String,
    val checkedAt: String,
    val serverTime: String,
    val nextAllowedAt: String,
    val replayed: Boolean,
)

@Serializable
data class CooldownResponse(
    val code: String = "CHECK_IN_COOLDOWN",
    val checkedAt: String,
    val serverTime: String,
    val nextAllowedAt: String,
)

@Serializable
data class ApiErrorResponse(val code: String, val message: String)
