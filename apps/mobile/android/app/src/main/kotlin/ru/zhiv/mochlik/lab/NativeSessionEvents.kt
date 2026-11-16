package ru.zhiv.mochlik.lab

import java.util.concurrent.CopyOnWriteArraySet

/** Native services stop immediately when their authenticated owner changes. */
internal object NativeSessionEvents {
    fun interface InvalidationListener {
        fun invalidate(expectedToken: String)
    }

    private val listeners = CopyOnWriteArraySet<Runnable>()
    private val invalidationListeners = CopyOnWriteArraySet<InvalidationListener>()

    fun addInvalidationListener(listener: InvalidationListener) {
        invalidationListeners.add(listener)
    }

    fun removeInvalidationListener(listener: InvalidationListener) {
        invalidationListeners.remove(listener)
    }

    fun invalidate(expectedToken: String) {
        for (listener in invalidationListeners) listener.invalidate(expectedToken)
    }

    fun add(listener: Runnable) {
        listeners.add(listener)
    }

    fun remove(listener: Runnable) {
        listeners.remove(listener)
    }

    fun changed() {
        for (listener in listeners) {
            try {
                listener.run()
            } catch (_: RuntimeException) {
                // One service cannot prevent session revocation.
            }
        }
    }
}
