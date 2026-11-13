import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        // Authentication callbacks belong to ASWebAuthenticationSession, never the JS app-url bridge.
        // A cold launch has no in-memory verifier and must start a new login attempt.
        if !connectionOptions.urlContexts.contains(where: { $0.url.scheme == MobileRequestPolicy.callbackScheme }) {
            SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let publicURLs = Set(URLContexts.filter { $0.url.scheme != MobileRequestPolicy.callbackScheme })
        if !publicURLs.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: publicURLs) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
