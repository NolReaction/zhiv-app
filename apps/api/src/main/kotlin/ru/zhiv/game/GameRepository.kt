package ru.zhiv.game

import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
data class GameProgress(
    val ownerPublicId: String,
    val lifetimeTaps: Long,
    val bestSeries: Long,
    val month: String,
    val monthlyTaps: Long,
    val leaderboardOptIn: Boolean,
    val visibilityVersion: Long,
    val serverTime: String,
)

@Serializable
data class GameSessionRequest(val requestId: String, val ownerPublicId: String)

@Serializable
data class GameSessionResponse(
    val sessionId: String,
    val nextSequence: Long,
    val expiresAt: String,
    val progress: GameProgress,
)

@Serializable
data class GameBatchRequest(val sessionId: String, val sequence: Long, val tapCount: Int, val runId: String)

@Serializable
data class GameBatchResponse(
    val sessionId: String,
    val sequence: Long,
    val acceptedTaps: Int,
    val rejectedTaps: Int,
    val replayed: Boolean,
    val progress: GameProgress,
    val runTaps: Long,
)

@Serializable
data class GameVisibilityRequest(val leaderboardOptIn: Boolean, val expectedVersion: Long, val ownerPublicId: String)

@Serializable
data class GameLeaderboardEntry(val rank: Long, val displayName: String, val taps: Long, val isMe: Boolean)

@Serializable
data class GameLeaderboard(
    val ownerPublicId: String,
    val month: String,
    val serverTime: String,
    val entries: List<GameLeaderboardEntry>,
    val myRank: Long?,
    val monthlyTaps: Long,
    val leaderboardOptIn: Boolean,
    val scope: String,
)

@Serializable
data class GameAchievement(val id: String, val progress: Long, val target: Long, val unlockedAt: String?)

@Serializable
data class GameAchievements(val ownerPublicId: String, val serverTime: String, val achievements: List<GameAchievement>)

interface GameRepository {
    suspend fun progress(sessionHash: ByteArray): GameProgress
    suspend fun openSession(sessionHash: ByteArray, requestId: UUID, ownerPublicId: String): GameSessionResponse
    suspend fun submitBatch(sessionHash: ByteArray, sessionId: UUID, sequence: Long, tapCount: Int, runId: UUID): GameBatchResponse
    suspend fun setVisibility(sessionHash: ByteArray, visible: Boolean, expectedVersion: Long, ownerPublicId: String): GameProgress
    suspend fun leaderboard(sessionHash: ByteArray, scope: String = "global"): GameLeaderboard
    suspend fun achievements(sessionHash: ByteArray): GameAchievements
}
