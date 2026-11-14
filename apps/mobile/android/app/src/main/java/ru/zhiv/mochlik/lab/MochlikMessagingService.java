package ru.zhiv.mochlik.lab;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** The only MESSAGING_EVENT receiver; display is gated before notifying the WebView. */
public final class MochlikMessagingService extends MessagingService {
    @Override public void onMessageReceived(@NonNull RemoteMessage message) {
        if (NativePushPolicy.receive(this, message.getData())) super.onMessageReceived(message);
    }
}
