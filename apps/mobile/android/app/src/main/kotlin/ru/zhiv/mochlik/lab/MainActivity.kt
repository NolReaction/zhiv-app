package ru.zhiv.mochlik.lab

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    public override fun onCreate(savedInstanceState: Bundle?) {
        // A cold start has no in-memory PKCE verifier. Do not expose the old proof to WebView.
        val incoming = intent
        if (incoming != null && isNativeAuthIntent(incoming)) {
            intent = sanitized(incoming)
        }
        // BridgeActivity forwards this intent to the non-null onNewIntent callback during load.
        intent = NativePushPolicy.cleanIntent(this, intent) ?: Intent()
        registerPlugin(MochlikNativePlugin::class.java)
        registerPlugin(MochlikStoragePlugin::class.java)
        registerPlugin(MochlikLocationPlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        if (isNativeAuthIntent(intent)) {
            val plugin = bridge?.getPlugin("MochlikNative")?.instance as? MochlikNativePlugin
            plugin?.handleOnNewIntent(intent)
            val clean = sanitized(intent)
            setIntent(clean)
            super.onNewIntent(clean)
            return
        }
        val cleanPush = NativePushPolicy.cleanIntent(this, intent) ?: intent
        setIntent(cleanPush)
        super.onNewIntent(cleanPush)
    }

    private fun isNativeAuthIntent(intent: Intent?): Boolean =
        intent?.data?.scheme == "ru.zhiv.mochlik.lab"

    private fun sanitized(intent: Intent): Intent =
        Intent(intent).setAction(Intent.ACTION_MAIN).setData(null)
}
