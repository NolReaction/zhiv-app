package ru.zhiv.mochlik.lab;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.function.Consumer;

@CapacitorPlugin(name = "MochlikLocation", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
})
public final class MochlikLocationPlugin extends Plugin {
    private final Consumer<JSObject> listener = value -> notifyListeners("stateChange", value);
    private PluginCall pendingPermission;
    private final Runnable sessionChanged = () -> { LocationPublishingService.cancelAllLaunches(); getActivity().runOnUiThread(this::cancelPermission); };
    @Override public void load() { LocationPublishingService.addListener(listener); NativeSessionEvents.add(sessionChanged); }
    @Override protected void handleOnDestroy() { cancelPermission(); NativeSessionEvents.remove(sessionChanged); LocationPublishingService.removeListener(listener); }
    @Override protected void handleOnPause() { getActivity().runOnUiThread(() -> LocationPublishingService.pause(getContext())); }
    @PluginMethod public void getState(PluginCall call) { call.resolve(LocationPublishingService.snapshot(getContext())); }
    @PluginMethod public void setBackgroundEnabled(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                Boolean enabled = call.getBoolean("enabled");
                if (enabled == null || !getActivity().hasWindowFocus() || enabled && !LocationPublishingService.hasLocationPermission(getContext())) throw new IllegalStateException("Permission required");
                LocationPublishingService.setBackgroundEnabled(getContext(), enabled); call.resolve(LocationPublishingService.snapshot(getContext()));
            } catch (Exception error) { call.reject("Сначала разрешите геопозицию и проверьте поиск", "LOCATION_PERMISSION_REQUIRED"); }
        });
    }
    @PluginMethod public void adopt(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!getActivity().hasWindowFocus()) { call.reject("Откройте приложение", "LOCATION_START_FAILED"); return; }
            cancelPermission();
            if (!LocationPublishingService.hasLocationPermission(getContext())) {
                if (!Boolean.TRUE.equals(call.getBoolean("allowPermissionPrompt"))) { call.reject("Сначала разрешите геопозицию", "LOCATION_PERMISSION_REQUIRED"); return; }
                pendingPermission = call; requestPermissionForAlias("location", call, "locationPermissionResult");
            }
            else start(call, true);
        });
    }
    @PermissionCallback private void locationPermissionResult(PluginCall call) {
        if (call != pendingPermission) return;
        pendingPermission = null;
        if (LocationPublishingService.hasLocationPermission(getContext())) start(call, false);
        else call.reject("Геопозиция запрещена", "LOCATION_PERMISSION_REQUIRED");
    }
    private void cancelPermission() {
        PluginCall old = pendingPermission; pendingPermission = null;
        if (old != null) old.reject("Передача отменена", "LOCATION_CANCELLED");
    }
    private void start(PluginCall call, boolean requireFocus) {
        try {
            JSObject settings = call.getObject("settings");
            if (settings == null || getActivity().isFinishing() || getActivity().isDestroyed()
                || !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)
                || requireFocus && !getActivity().hasWindowFocus()) throw new IllegalStateException("Visible app required");
            long ticket = LocationPublishingService.authorizeLaunch(settings);
            Intent intent = new Intent(getContext(), LocationPublishingService.class).putExtra("settings", settings.toString()).putExtra("launchTicket", ticket);
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent); else getContext().startService(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Не удалось начать передачу геопозиции", "LOCATION_START_FAILED"); }
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pendingPermission != null) {
                JSObject settings = pendingPermission.getObject("settings");
                if (settings != null && java.util.Objects.equals(call.getString("ownerPublicId"), settings.optString("ownerPublicId")) && java.util.Objects.equals(call.getString("epoch"), settings.optString("publicationEpoch"))) cancelPermission();
            }
            LocationPublishingService.stop(getContext(), call.getString("ownerPublicId"), call.getString("epoch")); call.resolve();
        });
    }
}
