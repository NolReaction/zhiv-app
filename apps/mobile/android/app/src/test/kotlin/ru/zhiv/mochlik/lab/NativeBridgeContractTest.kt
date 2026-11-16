package ru.zhiv.mochlik.lab

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.PermissionCallback
import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** These names and JVM signatures are the installed TypeScript bridge contract. */
class NativeBridgeContractTest {
    @Test
    fun pluginsKeepPublicUnmangledBridgeMethods() {
        assertBridge(
            MochlikNativePlugin::class.java,
            "MochlikNative",
            setOf(
                "getState", "request", "cancelRequest", "login", "cancelLogin", "logout",
                "openWebsite", "getPushConfiguration", "registerRemotePush", "activateRemotePush",
                "stopRemotePush", "getSafeArea",
            ),
        )
        assertBridge(
            MochlikStoragePlugin::class.java,
            "MochlikStorage",
            setOf("list", "put", "remove", "listJournals", "writeJournal"),
        )
        assertBridge(
            MochlikLocationPlugin::class.java,
            "MochlikLocation",
            setOf("getState", "setBackgroundEnabled", "adopt", "stop"),
        )
    }

    @Test
    fun androidComponentsAndPluginsKeepPublicNoArgumentConstructors() {
        for (component in listOf(
            MainActivity::class.java,
            LocationPublishingService::class.java,
            MochlikMessagingService::class.java,
            MochlikNativePlugin::class.java,
            MochlikLocationPlugin::class.java,
            MochlikStoragePlugin::class.java,
        )) {
            assertTrue(component.name, Modifier.isPublic(component.modifiers))
            assertTrue(component.name, Modifier.isPublic(component.getDeclaredConstructor().modifiers))
        }
    }

    @Test
    fun locationPermissionCallbackKeepsItsRegisteredJvmName() {
        val method = MochlikLocationPlugin::class.java.getDeclaredMethod(
            "locationPermissionResult", PluginCall::class.java,
        )
        assertNotNull(method.getAnnotation(PermissionCallback::class.java))
        assertEquals(Void.TYPE, method.returnType)
        val plugin = requireNotNull(MochlikLocationPlugin::class.java.getAnnotation(CapacitorPlugin::class.java))
        val location = plugin.permissions.single { it.alias == "location" }
        assertEquals(
            setOf("android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"),
            location.strings.toSet(),
        )
    }

    private fun assertBridge(type: Class<out Plugin>, id: String, names: Set<String>) {
        assertEquals(id, requireNotNull(type.getAnnotation(CapacitorPlugin::class.java)).name)
        val methods = type.methods.filter { it.isAnnotationPresent(PluginMethod::class.java) }
            .filter { it.declaringClass == type }
        assertEquals(id, names, methods.map { it.name }.toSet())
        for (method in methods) {
            assertEquals(method.name, listOf(PluginCall::class.java), method.parameterTypes.toList())
            assertEquals(method.name, Void.TYPE, method.returnType)
            assertTrue(method.name, Modifier.isPublic(method.modifiers))
        }
    }
}
