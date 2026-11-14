import AVFoundation
import Capacitor
import UserNotifications

class MainViewController: CAPBridgeViewController {
    private let nativePlugin = MochlikNativePlugin()
    var launchRemoteNotification: UNNotificationResponse?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // UIScene delivers cold-launch taps through connectionOptions, before JS listeners exist.
        // The official plugin retains this response until the application subscribes.
        if let response = launchRemoteNotification {
            launchRemoteNotification = nil
            bridge?.notificationRouter.pushNotificationHandler?.didReceive(response: response)
        }
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(nativePlugin)
        bridge?.registerPluginInstance(MochlikStoragePlugin())
        bridge?.registerPluginInstance(MochlikLocationPlugin())
        // Game audio respects the silent switch and other playing audio.
        try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        nativePlugin.safeAreaChanged(view.safeAreaInsets)
    }
}
