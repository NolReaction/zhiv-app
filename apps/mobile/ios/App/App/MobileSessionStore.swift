import Foundation
import Security

struct MobileSessionRecord: Codable {
    let token: String
    let userId: String
    let expiresAt: String
    let origin: String

    var expiry: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: expiresAt) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: expiresAt)
    }

    var valid: Bool {
        token.range(of: "^m1_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil &&
        UUID(uuidString: userId) != nil && (expiry ?? .distantPast) > Date()
    }
}

/// The WebView can observe session metadata, never these credentials.
final class MobileSessionStore {
    private let service = "ru.zhiv.mochlik.mobile-session.v1"
    private let account = "current"
    private let installMarker = "mochlik.native-session-install.v1"
    private let revokedMarker = "mochlik.native-session-revoked.v1"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load(origin: String) throws -> MobileSessionRecord? {
        // Keychain can outlive uninstall. A fresh install must not resurrect an account.
        if !UserDefaults.standard.bool(forKey: installMarker) {
            try clear()
            UserDefaults.standard.set(true, forKey: installMarker)
        }
        if UserDefaults.standard.bool(forKey: revokedMarker) { try clear(); return nil }
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw MobileBridgeError.storage }
        guard let record = try? JSONDecoder().decode(MobileSessionRecord.self, from: data),
              record.valid, record.origin == origin else { try clear(); return nil }
        return record
    }

    func save(_ record: MobileSessionRecord) throws {
        guard record.valid else { throw MobileBridgeError.auth }
        let data = try JSONEncoder().encode(record)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { UserDefaults.standard.set(false, forKey: revokedMarker); return }
        guard updated == errSecItemNotFound else { throw MobileBridgeError.storage }
        var create = query
        attributes.forEach { create[$0.key] = $0.value }
        guard SecItemAdd(create as CFDictionary, nil) == errSecSuccess else { throw MobileBridgeError.storage }
        UserDefaults.standard.set(false, forKey: revokedMarker)
    }

    func clear() throws {
        // Preserve logout across relaunch even if the device temporarily denies Keychain access.
        UserDefaults.standard.set(true, forKey: revokedMarker)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MobileBridgeError.storage }
    }
}
