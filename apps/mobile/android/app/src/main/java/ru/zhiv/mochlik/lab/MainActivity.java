package ru.zhiv.mochlik.lab;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        // A cold start has no in-memory PKCE verifier. Do not expose the old proof to WebView.
        if (isNativeAuthIntent(getIntent())) setIntent(sanitized(getIntent()));
        registerPlugin(MochlikNativePlugin.class);
        registerPlugin(MochlikStoragePlugin.class);
        registerPlugin(MochlikLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override protected void onNewIntent(Intent intent) {
        if (isNativeAuthIntent(intent)) {
            PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("MochlikNative");
            if (handle != null && handle.getInstance() instanceof MochlikNativePlugin) {
                ((MochlikNativePlugin) handle.getInstance()).handleOnNewIntent(intent);
            }
            Intent clean = sanitized(intent);
            setIntent(clean);
            super.onNewIntent(clean);
            return;
        }
        super.onNewIntent(intent);
    }

    private static boolean isNativeAuthIntent(Intent intent) {
        return intent != null && intent.getData() != null && "ru.zhiv.mochlik.lab".equals(intent.getData().getScheme());
    }

    private static Intent sanitized(Intent intent) {
        return new Intent(intent).setAction(Intent.ACTION_MAIN).setData(null);
    }
}
