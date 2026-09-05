
package ru.zhiv.recovery

interface CodeRecoveryRepository {
    suspend fun hasCode(sessionHash: ByteArray): Boolean?
    suspend fun activate(sessionHash: ByteArray, codeHash: ByteArray): Boolean
    suspend fun redeem(codeHash: ByteArray, retryHash: ByteArray, newSessionHash: ByteArray, sessionDays: Long): Boolean
}
