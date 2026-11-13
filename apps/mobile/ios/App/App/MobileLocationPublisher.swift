import Foundation
import UIKit
import CoreLocation

/// One native publisher owns a server-granted epoch. It never creates consent or a new epoch.
final class MobileLocationPublisher: NSObject, CLLocationManagerDelegate {
    static let shared = MobileLocationPublisher()
    static let changed = Notification.Name("mochlikLocationChanged")
    private let manager = CLLocationManager()
    private let store = MobileSessionStore()
    private var observers = [NSObjectProtocol]()
    private var record: MobileSessionRecord?
    private var settings: [String: Any]?
    private var transfer: MobileHTTPTransfer?
    private var stopping = [UUID: MobileHTTPTransfer]()
    private var generation = 0
    private var sequence = 0
    private var started = Date.distantFuture
    private var deadline = Double.infinity
    private var lastAttempt = -Double.infinity
    private var usedTimestamp = Date.distantPast
    private var timer: Timer?
    private var lastEpoch: String?
    private var lastOwner: String?
    private var lastPublishedAt: String?
    private var error: String?
    private var sessionLost = false
    private var active = false

    private var origin: URL? { MobileRequestPolicy.origin(Bundle.main.object(forInfoDictionaryKey: "MobileBackendOrigin") as? String) }
    private var uptime: Double { ProcessInfo.processInfo.systemUptime }
    private func preferenceKey(_ user: String) -> String { "mochlik.background-location.v1.\(user)" }
    private func currentRecord() -> MobileSessionRecord? {
        guard let origin else { return nil }
        return try? store.load(origin: origin.absoluteString)
    }
    var backgroundEnabled: Bool {
        guard let record = currentRecord() else { return false }
        return UserDefaults.standard.bool(forKey: preferenceKey(record.userId))
    }
    private func sameSession() -> Bool {
        guard let record, let current = currentRecord() else { return false }
        return record.userId == current.userId && record.token == current.token
    }
    private func date(_ value: Any?) -> Date? {
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
    private func iso(_ value: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }

    private override init() {
        super.init()
        manager.delegate = self
        manager.pausesLocationUpdatesAutomatically = true
        manager.activityType = .other
        manager.showsBackgroundLocationIndicator = true
        observers.append(NotificationCenter.default.addObserver(forName: Notification.Name("mochlikNativeSessionWillChange"), object: nil, queue: .main) { [weak self] _ in
            self?.stop(reason: nil, lost: true)
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            if !self.backgroundEnabled { self.stop(reason: nil) }
        })
    }

    func snapshot() -> [String: Any] {
        ["active": active, "backgroundEnabled": backgroundEnabled, "ownerPublicId": lastOwner as Any? ?? NSNull(),
         "epoch": lastEpoch as Any? ?? NSNull(), "lastPublishedAt": lastPublishedAt as Any? ?? NSNull(),
         "error": error as Any? ?? NSNull(), "sessionLost": sessionLost]
    }
    private func emit() { NotificationCenter.default.post(name: Self.changed, object: nil, userInfo: snapshot()) }

    func setBackgroundEnabled(_ enabled: Bool) throws {
        guard UIApplication.shared.applicationState == .active, let current = currentRecord() else { throw MobileBridgeError.auth }
        if enabled {
            guard CLLocationManager.locationServicesEnabled(), manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse else {
                throw MobileBridgeError.invalidRequest
            }
        }
        UserDefaults.standard.set(enabled, forKey: preferenceKey(current.userId))
        manager.allowsBackgroundLocationUpdates = enabled && active
        emit()
    }

    func adopt(_ value: [String: Any], allowPermissionPrompt: Bool) throws {
        guard UIApplication.shared.applicationState == .active, let current = currentRecord(),
              let owner = value["ownerPublicId"] as? String,
              owner.range(of: "^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$", options: .regularExpression) != nil,
              let epoch = value["publicationEpoch"] as? String, UUID(uuidString: epoch) != nil,
              let serverTime = date(value["serverTime"]), eligible(value),
              CLLocationManager.locationServicesEnabled(),
              manager.authorizationStatus != .denied && manager.authorizationStatus != .restricted,
              manager.authorizationStatus != .notDetermined || allowPermissionPrompt
        else { throw MobileBridgeError.invalidRequest }
        if active, record?.token == current.token, lastOwner == owner, lastEpoch == epoch {
            guard settings?["precision"] as? String == value["precision"] as? String,
                  settings?["sharingUntil"] as? String == value["sharingUntil"] as? String else { throw MobileBridgeError.invalidRequest }
            return
        }
        stop(reason: nil)
        generation += 1; record = current; settings = value; lastOwner = owner; lastEpoch = epoch
        started = Date(); usedTimestamp = .distantPast; lastAttempt = -.infinity; sequence = 0
        lastPublishedAt = nil; error = nil; sessionLost = false; active = true
        deadline = date(value["sharingUntil"]).map { uptime + max(0, $0.timeIntervalSince(serverTime)) } ?? .infinity
        manager.desiredAccuracy = value["precision"] as? String == "APPROXIMATE" ? kCLLocationAccuracyKilometer : kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 25
        manager.allowsBackgroundLocationUpdates = backgroundEnabled
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.checkExpiry() }
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else { manager.startUpdatingLocation() }
        emit()
    }

    private func eligible(_ value: [String: Any]) -> Bool {
        guard value["mode"] as? String == "SHARING", let recipients = value["recipientCircleIds"] as? [String],
              let frozen = value["frozenCircleIds"] as? [String], ["PRECISE", "APPROXIMATE"].contains(value["precision"] as? String ?? "") else { return false }
        return recipients.contains { !frozen.contains($0) }
    }
    private func checkExpiry() {
        guard active else { return }
        if !sameSession() { stop(reason: "Сеанс завершён", lost: true) }
        else if uptime >= deadline { stop(reason: "Срок обмена геопозицией истёк") }
    }

    func stop(owner: String? = nil, epoch: String? = nil, reason: String?, lost: Bool = false) {
        if let owner, owner != lastOwner { return }
        if let epoch, epoch != lastEpoch { return }
        let old = settings, oldRecord = record
        generation += 1; active = false; settings = nil; record = nil
        timer?.invalidate(); timer = nil
        manager.stopUpdatingLocation(); manager.allowsBackgroundLocationUpdates = false
        let pending = transfer; transfer = nil; pending?.cancel()
        error = reason; sessionLost = lost
        // No coordinates are persisted or queued. DELETE only retires this exact epoch.
        if let old, let oldRecord, let origin, let owner = old["ownerPublicId"] as? String, let epoch = old["publicationEpoch"] as? String,
           oldRecord.valid, currentRecord()?.token == oldRecord.token,
           let url = try? MobileRequestPolicy.url(origin: origin, path: "/api/v1/earth/location") {
            var request = URLRequest(url: url); request.httpMethod = "DELETE"
            request.setValue("Bearer \(oldRecord.token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["expectedOwnerPublicId": owner, "publicationEpoch": epoch])
            let id = UUID()
            let stop = MobileHTTPTransfer(request: request, limit: 16_384) { [weak self] _ in self?.stopping.removeValue(forKey: id) }
            stopping[id] = stop; stop.start()
        }
        emit()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if !active { return }
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse { manager.startUpdatingLocation() }
        else if manager.authorizationStatus != .notDetermined { stop(reason: "Доступ к геопозиции отозван") }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError problem: Error) {
        if (problem as? CLError)?.code == .denied { stop(reason: "Геопозиция недоступна") }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, active, transfer == nil, uptime - lastAttempt >= 30 else { return }
        checkExpiry()
        guard active, let settings, valid(location) else { return }
        lastAttempt = uptime
        let readStarted = uptime
        let currentGeneration = generation
        request(path: "/api/v1/earth/sharing", method: "GET", body: nil, generation: currentGeneration) { [weak self] result in
            guard let self, self.active, self.generation == currentGeneration else { return }
            switch result {
            case .failure: self.error = "Нет связи: новые координаты пока не отправлены"; self.emit()
            case .success(let fresh):
                if let until = self.date(fresh["sharingUntil"]), let serverTime = self.date(fresh["serverTime"]) {
                    self.deadline = min(self.deadline, self.uptime + max(0, until.timeIntervalSince(serverTime) - (self.uptime - readStarted)))
                }
                guard self.eligible(fresh), fresh["ownerPublicId"] as? String == self.lastOwner,
                      self.date(fresh["serverTime"]) != nil,
                      fresh["precision"] as? String == settings["precision"] as? String,
                      (fresh["sharingUntil"] as? String) == (settings["sharingUntil"] as? String),
                      self.valid(location), self.uptime < self.deadline else { self.stop(reason: "Обмен остановлен настройками доступа"); return }
                self.upload(location, generation: currentGeneration)
            }
        }
    }
    private func valid(_ location: CLLocation) -> Bool {
        let age = Date().timeIntervalSince(location.timestamp)
        return location.timestamp >= started && location.timestamp > usedTimestamp && age >= -10 && age <= 60 &&
            location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 100_000 && CLLocationCoordinate2DIsValid(location.coordinate)
    }
    private func upload(_ location: CLLocation, generation: Int) {
        guard let owner = lastOwner, let epoch = lastEpoch, let settings, sameSession() else { stop(reason: "Сеанс завершён", lost: true); return }
        sequence += 1; usedTimestamp = location.timestamp
        let approximate = settings["precision"] as? String == "APPROXIMATE"
        let latitude = approximate ? floor(location.coordinate.latitude * 100 + 0.5) / 100 : location.coordinate.latitude
        let longitude = approximate ? floor(location.coordinate.longitude * 100 + 0.5) / 100 : location.coordinate.longitude
        let body: [String: Any] = ["expectedOwnerPublicId": owner, "publicationEpoch": epoch, "sequence": sequence,
            "latitude": latitude, "longitude": longitude, "accuracyMeters": approximate ? max(1_500, location.horizontalAccuracy) : location.horizontalAccuracy,
            "capturedAt": iso(location.timestamp)]
        request(path: "/api/v1/earth/location", method: "PUT", body: body, generation: generation) { [weak self] result in
            guard let self, self.active, self.generation == generation else { return }
            switch result {
            case .failure: self.error = "Нет связи: новые координаты пока не отправлены"
            case .success(let receipt):
                guard receipt["ownerPublicId"] as? String == owner, self.date(receipt["acceptedAt"]) != nil else { self.stop(reason: "Сервер не подтвердил координаты"); return }
                self.lastPublishedAt = receipt["acceptedAt"] as? String; self.error = nil
            }
            self.emit()
        }
    }
    private func request(path: String, method: String, body: [String: Any]?, generation: Int,
                         completion: @escaping (Result<[String: Any], MobileBridgeError>) -> Void) {
        guard sameSession(), let record, let origin, let url = try? MobileRequestPolicy.url(origin: origin, path: path) else { stop(reason: "Сеанс завершён", lost: true); return }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("Bearer \(record.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        }
        let task = MobileHTTPTransfer(request: request, limit: 65_536) { [weak self] result in
            guard let self, self.active, self.generation == generation else { return }
            self.transfer = nil
            guard self.sameSession() else { self.stop(reason: "Сеанс завершён", lost: true); return }
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let response):
                if response.status == 401 {
                    self.stop(reason: "Сеанс завершён", lost: true)
                    NotificationCenter.default.post(name: Notification.Name("mochlikNativeSessionInvalidated"), object: nil, userInfo: ["token": record.token])
                    return
                }
                if response.status == 403 || response.status == 409 { self.stop(reason: "Право передачи геопозиции изменилось"); return }
                guard response.status >= 200, response.status < 300,
                      let value = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any] else { completion(.failure(.network)); return }
                completion(.success(value))
            }
        }
        transfer = task; task.start()
    }
}
