package ru.zhiv.mochlik.lab;

import java.util.concurrent.CopyOnWriteArraySet;

/** Native services stop immediately when their authenticated owner changes. */
final class NativeSessionEvents {
    interface InvalidationListener { void invalidate(String expectedToken); }
    private static final CopyOnWriteArraySet<Runnable> listeners = new CopyOnWriteArraySet<>();
    private static final CopyOnWriteArraySet<InvalidationListener> invalidationListeners = new CopyOnWriteArraySet<>();
    static void addInvalidationListener(InvalidationListener listener) { invalidationListeners.add(listener); }
    static void removeInvalidationListener(InvalidationListener listener) { invalidationListeners.remove(listener); }
    static void invalidate(String expectedToken) {
        for (InvalidationListener listener : invalidationListeners) listener.invalidate(expectedToken);
    }
    static void add(Runnable listener) { listeners.add(listener); }
    static void remove(Runnable listener) { listeners.remove(listener); }
    static void changed() {
        for (Runnable listener : listeners) {
            try { listener.run(); } catch (RuntimeException ignored) { /* One service cannot prevent session revocation. */ }
        }
    }
    private NativeSessionEvents() {}
}
