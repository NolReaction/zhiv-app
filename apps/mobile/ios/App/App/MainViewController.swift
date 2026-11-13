import AVFoundation
import Capacitor

class MainViewController: CAPBridgeViewController {
    private let nativePlugin = MochlikNativePlugin()

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
