import Foundation
import UIKit
import AuthenticationServices
import CryptoKit
import Security
import Capacitor

@objc(MochlikNativePlugin)
public final class MochlikNativePlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "MochlikNativePlugin"
    public let jsName = "MochlikNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelLogin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openWebsite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSafeArea", returnType: CAPPluginReturnPromise)
    ]

    private let sessionStore = MobileSessionStore()
    private var sessionRecord: MobileSessionRecord?
    private var loaded = false
    private var generation = 0
    private var requests = [String: MobileHTTPTransfer]()
    private var authSession: ASWebAuthenticationSession?
    private var authCall: CAPPluginCall?
    private var authState: String?
    private var authVerifier: String?
    private var authGeneration = 0
    private var authTimer: Timer?
    private var exchange: MobileHTTPTransfer?
    private var logoutTransfer: MobileHTTPTransfer?
    private var memoryObserver: NSObjectProtocol?
    private var invalidationObserver: NSObjectProtocol?
    private var lastInsets = UIEdgeInsets.zero

    private var origin: URL? { MobileRequestPolicy.origin(Bundle.main.object(forInfoDictionaryKey: "MobileBackendOrigin") as? String) }

    override public func load() {
        memoryObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.notifyListeners("memoryWarning", data: ["level": "critical"]) }
        invalidationObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("mochlikNativeSessionInvalidated"), object: nil, queue: .main
        ) { [weak self] event in
            guard let self, let expectedToken = event.userInfo?["token"] as? String else { return }
            do {
                try self.prepareSession()
                guard self.sessionRecord?.token == expectedToken else { return }
                try self.invalidateSession()
            } catch { /* Do not clear an unverified owner when protected storage is unavailable. */ }
        }
    }

    deinit {
        if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
        if let invalidationObserver { NotificationCenter.default.removeObserver(invalidationObserver) }
    }

    private func prepareSession() throws {
        guard let origin else { throw MobileBridgeError.configuration }
        if !loaded {
            sessionRecord = try sessionStore.load(origin: origin.absoluteString)
            loaded = true
        }
        if let record = sessionRecord, !record.valid { try invalidateSession() }
    }

    private func snapshot() -> JSObject {
        var value: JSObject = ["configured": origin != nil, "authenticated": sessionRecord != nil]
        if let record = sessionRecord { value["userId"] = record.userId; value["expiresAt"] = record.expiresAt }
        return value
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let problem = error as? MobileBridgeError ?? .network
        call.reject("Не удалось выполнить запрос приложения", problem.code)
    }

    private func invalidateSession() throws {
        NotificationCenter.default.post(name: Notification.Name("mochlikNativeSessionWillChange"), object: nil)
        generation += 1
        sessionRecord = nil
        let pending = Array(requests.values)
        requests.removeAll()
        pending.forEach { $0.cancel(.sessionChanged) }
        notifyListeners("sessionChange", data: snapshot())
        try sessionStore.clear()
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.origin == nil { call.resolve(self.snapshot()); return }
            do { try self.prepareSession(); call.resolve(self.snapshot()) }
            catch { self.reject(call, error) }
        }
    }

    @objc func request(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.prepareSession()
                guard let origin = self.origin, let id = call.getString("id"),
                      id.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil,
                      self.requests[id] == nil, self.requests.count < 32,
                      let path = call.getString("path"), let method = call.getString("method"),
                      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(method)
                else { throw MobileBridgeError.invalidRequest }
                let owner = call.getString("expectedUserId")
                guard owner == self.sessionRecord?.userId else { throw MobileBridgeError.sessionChanged }
                var request = URLRequest(url: try MobileRequestPolicy.url(origin: origin, path: path))
                request.httpMethod = method
                request.httpBody = try MobileRequestPolicy.body(call.getString("body"))
                guard request.httpBody == nil || !["GET", "HEAD"].contains(method) else { throw MobileBridgeError.invalidRequest }
                let supplied = call.getObject("headers") ?? [:]
                request.allHTTPHeaderFields = try MobileRequestPolicy.headers(supplied.mapValues { $0 as Any })
                if let record = self.sessionRecord { request.setValue("Bearer \(record.token)", forHTTPHeaderField: "Authorization") }
                request.httpShouldHandleCookies = false
                let expectedGeneration = self.generation
                let transfer = MobileHTTPTransfer(request: request) { [weak self] result in
                    guard let self else { call.reject("Приложение закрыто", "ABORT_ERR"); return }
                    self.requests.removeValue(forKey: id)
                    guard expectedGeneration == self.generation, owner == self.sessionRecord?.userId else {
                        self.reject(call, MobileBridgeError.sessionChanged); return
                    }
                    switch result {
                    case .failure(let error): self.reject(call, error)
                    case .success(let response):
                        let endpoint = request.url?.path
                        let removesSession = (method == "POST" && endpoint == "/api/v1/auth/logout") ||
                            (method == "DELETE" && endpoint == "/api/v1/auth/account/profile")
                        if self.sessionRecord != nil && (response.status == 401 || (removesSession && (200..<300).contains(response.status))) {
                            try? self.invalidateSession()
                        }
                        call.resolve(["status": response.status, "headers": response.headers,
                                      "body": response.data.base64EncodedString()])
                    }
                }
                self.requests[id] = transfer
                transfer.start()
            } catch { self.reject(call, error) }
        }
    }

    @objc func cancelRequest(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("id") { self.requests.removeValue(forKey: id)?.cancel() }
            call.resolve()
        }
    }

    @objc func logout(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var previous = self.sessionRecord
            do { try self.prepareSession(); previous = self.sessionRecord }
            catch { /* A failed read must not prevent a requested local logout. */ }
            self.finishAuth(code: "AUTH_CANCELLED")
            var cleanupError: Error?
            do { try self.invalidateSession() } catch { cleanupError = error }
            // Local logout is immediate. The captured old credential can only revoke itself.
            if let previous, let origin = self.origin {
                var request = URLRequest(url: origin.appendingPathComponent("api/v1/auth/logout"))
                request.httpMethod = "POST"
                request.setValue("Bearer \(previous.token)", forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = Data("{}".utf8)
                self.logoutTransfer?.cancel()
                self.logoutTransfer = MobileHTTPTransfer(request: request, limit: 64 * 1024) { [weak self] _ in self?.logoutTransfer = nil }
                self.logoutTransfer?.start()
            }
            if let cleanupError { self.reject(call, cleanupError) } else { call.resolve() }
        }
    }

    private func randomProof() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw MobileBridgeError.auth }
        return Self.base64URL(Data(bytes))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    @objc func login(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.prepareSession()
                guard self.authCall == nil else { call.reject("Вход уже открыт", "AUTH_BUSY"); return }
                guard self.sessionRecord == nil else { call.resolve(self.snapshot()); return }
                guard let origin = self.origin else { throw MobileBridgeError.configuration }
                let verifier = try self.randomProof()
                let state = try self.randomProof()
                var url = URLComponents(url: origin.appendingPathComponent("mobile/connect"), resolvingAgainstBaseURL: false)!
                url.queryItems = [URLQueryItem(name: "challenge", value: Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))),
                                  URLQueryItem(name: "state", value: state), URLQueryItem(name: "platform", value: "ios")]
                guard let startURL = url.url else { throw MobileBridgeError.configuration }
                self.authCall = call
                self.authState = state
                self.authVerifier = verifier
                self.authGeneration = self.generation
                let session = ASWebAuthenticationSession(url: startURL, callbackURLScheme: MobileRequestPolicy.callbackScheme) { [weak self] url, error in
                    DispatchQueue.main.async {
                        guard let self, self.authState == state else { return }
                        guard error == nil, let url else { self.finishAuth(code: "AUTH_CANCELLED"); return }
                        self.completeAuth(url)
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                self.authSession = session
                self.authTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: false) { [weak self] _ in self?.finishAuth(code: "AUTH_EXPIRED") }
                if !session.start() { self.finishAuth(code: "AUTH_FAILED") }
            } catch { self.reject(call, error) }
        }
    }

    private func completeAuth(_ callback: URL) {
        guard let origin, let verifier = authVerifier, let state = authState,
              authGeneration == generation, let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parts.scheme == MobileRequestPolicy.callbackScheme, parts.host == "auth", parts.path == "/callback",
              parts.port == nil, parts.user == nil, parts.password == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 2,
              items.filter({ $0.name == "state" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { finishAuth(code: "AUTH_FAILED"); return }
        guard exchange == nil else { return }
        var request = URLRequest(url: origin.appendingPathComponent("api/v1/auth/mobile/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier, "state": state, "platform": "ios"])
        let expectedGeneration = generation
        exchange = MobileHTTPTransfer(request: request, limit: 64 * 1024) { [weak self] result in
            guard let self, self.authState == state, self.generation == expectedGeneration else { return }
            guard case .success(let response) = result, response.status == 200,
                  let body = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let token = body["token"] as? String, let userId = body["userId"] as? String,
                  let expiresAt = body["expiresAt"] as? String else { self.finishAuth(code: "AUTH_FAILED"); return }
            do {
                let record = MobileSessionRecord(token: token, userId: userId, expiresAt: expiresAt, origin: origin.absoluteString)
                NotificationCenter.default.post(name: Notification.Name("mochlikNativeSessionWillChange"), object: nil)
                try self.sessionStore.save(record)
                self.sessionRecord = record
                self.generation += 1
                self.notifyListeners("sessionChange", data: self.snapshot())
                let call = self.authCall
                self.authCall = nil
                self.finishAuth(code: nil)
                call?.resolve(self.snapshot())
            } catch { self.finishAuth(code: "STORAGE_UNAVAILABLE") }
        }
        exchange?.start()
    }

    private func finishAuth(code: String?) {
        let call = authCall
        authCall = nil
        authState = nil
        authVerifier = nil
        authTimer?.invalidate()
        authTimer = nil
        authSession?.cancel()
        authSession = nil
        exchange?.cancel()
        exchange = nil
        if let call, let code { call.reject("Вход не завершён. Попробуйте ещё раз", code) }
    }

    @objc func cancelLogin(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.finishAuth(code: "AUTH_CANCELLED"); call.resolve() }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    @objc func openWebsite(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                guard let origin = self.origin, let path = call.getString("path") else { throw MobileBridgeError.configuration }
                let url = try MobileRequestPolicy.url(origin: origin, path: path, api: false)
                UIApplication.shared.open(url, options: [:]) { opened in
                    if opened { call.resolve() } else { call.reject("Не удалось открыть браузер", "MOBILE_REQUEST_FAILED") }
                }
            } catch { self.reject(call, error) }
        }
    }

    private func insets(_ value: UIEdgeInsets) -> JSObject {
        ["top": Double(value.top), "right": Double(value.right), "bottom": Double(value.bottom), "left": Double(value.left)]
    }

    @objc func getSafeArea(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.insets(self.bridge?.viewController?.view.safeAreaInsets ?? .zero)) }
    }

    func safeAreaChanged(_ value: UIEdgeInsets) {
        guard value != lastInsets else { return }
        lastInsets = value
        notifyListeners("safeAreaChange", data: insets(value))
    }
}
