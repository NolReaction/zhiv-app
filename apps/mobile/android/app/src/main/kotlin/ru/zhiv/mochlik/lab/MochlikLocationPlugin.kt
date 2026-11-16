package ru.zhiv.mochlik.lab

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.lifecycle.Lifecycle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.function.Consumer

@CapacitorPlugin(
    name = "MochlikLocation",
    permissions = [
        Permission(
            alias = "location",
            strings = [Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION],
        ),
    ],
)
class MochlikLocationPlugin : Plugin() {
    private val listener = Consumer<JSObject> { value -> notifyListeners("stateChange", value) }
    private var pendingPermission: PluginCall? = null
    private val sessionChanged = Runnable {
        LocationPublishingService.cancelAllLaunches()
        activity.runOnUiThread(::cancelPermission)
    }

    override fun load() {
        LocationPublishingService.addListener(listener)
        NativeSessionEvents.add(sessionChanged)
    }

    override fun handleOnDestroy() {
        cancelPermission()
        NativeSessionEvents.remove(sessionChanged)
        LocationPublishingService.removeListener(listener)
    }

    override fun handleOnPause() {
        activity.runOnUiThread { LocationPublishingService.pause(context) }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(LocationPublishingService.snapshot(context))
    }

    @PluginMethod
    fun setBackgroundEnabled(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val enabled = call.getBoolean("enabled")
                check(
                    enabled != null && activity.hasWindowFocus() &&
                        (!enabled || LocationPublishingService.hasLocationPermission(context)),
                ) { "Permission required" }
                LocationPublishingService.setBackgroundEnabled(context, enabled)
                call.resolve(LocationPublishingService.snapshot(context))
            } catch (_: Exception) {
                call.reject("Сначала разрешите геопозицию и проверьте поиск", "LOCATION_PERMISSION_REQUIRED")
            }
        }
    }

    @PluginMethod
    fun adopt(call: PluginCall) {
        activity.runOnUiThread {
            if (!activity.hasWindowFocus()) {
                call.reject("Откройте приложение", "LOCATION_START_FAILED")
                return@runOnUiThread
            }
            cancelPermission()
            if (!LocationPublishingService.hasLocationPermission(context)) {
                if (call.getBoolean("allowPermissionPrompt") != true) {
                    call.reject("Сначала разрешите геопозицию", "LOCATION_PERMISSION_REQUIRED")
                    return@runOnUiThread
                }
                pendingPermission = call
                requestPermissionForAlias("location", call, "locationPermissionResult")
            } else {
                start(call, requireFocus = true)
            }
        }
    }

    @PermissionCallback
    private fun locationPermissionResult(call: PluginCall) {
        if (call !== pendingPermission) return
        pendingPermission = null
        if (LocationPublishingService.hasLocationPermission(context)) {
            start(call, requireFocus = false)
        } else {
            call.reject("Геопозиция запрещена", "LOCATION_PERMISSION_REQUIRED")
        }
    }

    private fun cancelPermission() {
        val old = pendingPermission
        pendingPermission = null
        old?.reject("Передача отменена", "LOCATION_CANCELLED")
    }

    private fun start(call: PluginCall, requireFocus: Boolean) {
        try {
            val settings = call.getObject("settings")
            check(
                settings != null && !activity.isFinishing && !activity.isDestroyed &&
                    activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                    (!requireFocus || activity.hasWindowFocus()),
            ) { "Visible app required" }
            val ticket = LocationPublishingService.authorizeLaunch(settings)
            val intent = Intent(context, LocationPublishingService::class.java)
                .putExtra("settings", settings.toString())
                .putExtra("launchTicket", ticket)
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            call.resolve()
        } catch (_: Exception) {
            call.reject("Не удалось начать передачу геопозиции", "LOCATION_START_FAILED")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        activity.runOnUiThread {
            val settings = pendingPermission?.getObject("settings")
            if (settings != null && call.getString("ownerPublicId") == settings.optString("ownerPublicId") &&
                call.getString("epoch") == settings.optString("publicationEpoch")
            ) {
                cancelPermission()
            }
            LocationPublishingService.stop(context, call.getString("ownerPublicId"), call.getString("epoch"))
            call.resolve()
        }
    }
}
