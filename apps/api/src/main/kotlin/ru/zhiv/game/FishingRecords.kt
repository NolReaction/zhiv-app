package ru.zhiv.game

import kotlinx.serialization.Serializable

@Serializable
data class FishingRecordLeader(
    val fishId: String,
    val weightGrams: Int,
    val displayName: String,
    val isMe: Boolean,
    val tiedCount: Long,
)

@Serializable
data class FishingRecordVisibility(val ownerPublicId: String, val leaderboardOptIn: Boolean, val visibilityVersion: Long)

@Serializable
data class FishingRecordsBoard(
    val ownerPublicId: String,
    val scope: String,
    val leaderboardOptIn: Boolean,
    val visibilityVersion: Long,
    val entries: List<FishingRecordLeader>,
)
