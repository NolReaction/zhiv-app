package ru.zhiv.mochlik.lab

import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage

/** The only MESSAGING_EVENT receiver; display is gated before notifying the WebView. */
class MochlikMessagingService : MessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (NativePushPolicy.receive(this, message.data)) super.onMessageReceived(message)
    }
}
