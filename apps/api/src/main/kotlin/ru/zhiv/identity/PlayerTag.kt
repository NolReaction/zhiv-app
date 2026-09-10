package ru.zhiv.identity

import kotlinx.serialization.Serializable

/** Public profile metadata. Only administrator commands may change it. */
@Serializable
data class PlayerTag(val text: String, val color: String)
