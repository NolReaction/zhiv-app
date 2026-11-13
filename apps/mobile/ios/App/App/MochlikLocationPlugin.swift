import Foundation
import Capacitor

@objc(MochlikLocationPlugin)
public final class MochlikLocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MochlikLocationPlugin"
    public let jsName = "MochlikLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBackgroundEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "adopt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private var observer: NSObjectProtocol?
    override public func load() {
        observer = NotificationCenter.default.addObserver(forName: MobileLocationPublisher.changed, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("stateChange", data: MobileLocationPublisher.shared.snapshot())
        }
    }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    @objc func getState(_ call: CAPPluginCall) { DispatchQueue.main.async { call.resolve(MobileLocationPublisher.shared.snapshot()) } }
    @objc func setBackgroundEnabled(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let enabled = call.getBool("enabled") else { call.reject("Некорректный выбор"); return }
            do { try MobileLocationPublisher.shared.setBackgroundEnabled(enabled); call.resolve(MobileLocationPublisher.shared.snapshot()) }
            catch { call.reject("Сначала разрешите геопозицию в настройках приложения и проверьте поиск", "LOCATION_PERMISSION_REQUIRED") }
        }
    }
    @objc func adopt(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let settings = call.getObject("settings") else { call.reject("Нет настроек доступа"); return }
            do { try MobileLocationPublisher.shared.adopt(settings, allowPermissionPrompt: call.getBool("allowPermissionPrompt") ?? false); call.resolve() }
            catch { call.reject("Не удалось начать передачу геопозиции", "LOCATION_START_FAILED") }
        }
    }
    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let owner = call.getString("ownerPublicId"), let epoch = call.getString("epoch") else { call.resolve(); return }
            MobileLocationPublisher.shared.stop(owner: owner, epoch: epoch, reason: nil); call.resolve()
        }
    }
}
