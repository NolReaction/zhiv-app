import Foundation

enum MobileBridgeError: Error {
    case invalidRequest, configuration, tooLarge, responseTooLarge, network, cancelled, sessionChanged, storage, auth

    var code: String {
        switch self {
        case .invalidRequest: return "INVALID_REQUEST"
        case .configuration: return "CONFIG_REQUIRED"
        case .tooLarge: return "REQUEST_TOO_LARGE"
        case .responseTooLarge: return "RESPONSE_TOO_LARGE"
        case .network: return "MOBILE_REQUEST_FAILED"
        case .cancelled: return "ABORT_ERR"
        case .sessionChanged: return "SESSION_CHANGED"
        case .storage: return "STORAGE_UNAVAILABLE"
        case .auth: return "AUTH_FAILED"
        }
    }
}

enum MobileRequestPolicy {
    static let requestLimit = 6 * 1024 * 1024
    static let responseLimit = 16 * 1024 * 1024
    static let callbackScheme = "ru.zhiv.mochlik.lab"
    static let callbackURL = "ru.zhiv.mochlik.lab://auth/callback"
    static let requestHeaders: Set<String> = [
        "accept", "content-type", "if-none-match", "if-modified-since", "idempotency-key",
        "x-idempotency-key", "x-client-version", "x-game-presence", "x-game-generation",
        "x-economy-catalog", "x-zhiv-profile", "x-zhiv-fishing-profile"
    ]
    static let responseHeaders: Set<String> = [
        "content-type", "retry-after", "x-request-id", "etag", "last-modified", "cache-control",
        "content-length", "x-economy-catalog", "x-zhiv-profile", "x-zhiv-fishing-profile"
    ]

    static func origin(_ raw: String?) -> URL? {
        guard let raw, raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              let parts = URLComponents(string: raw), parts.scheme == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else { return nil }
        return url
    }

    static func url(origin: URL, path: String, api: Bool = true) throws -> URL {
        guard path.utf8.count <= 8192, path.hasPrefix("/"), !path.hasPrefix("//"),
              !path.contains("\\"), !path.contains("#"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let relative = URLComponents(string: path), relative.scheme == nil, relative.host == nil,
              relative.user == nil, relative.password == nil else { throw MobileBridgeError.invalidRequest }
        let encoded = relative.percentEncodedPath.lowercased()
        guard !encoded.contains("//"), !["%2e", "%2f", "%5c", "%25"].contains(where: encoded.contains),
              !relative.path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !relative.path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
              !api || (relative.path.hasPrefix("/api/v1/") && relative.path != "/api/v1/auth/mobile" && !relative.path.hasPrefix("/api/v1/auth/mobile/")),
              api || !relative.path.hasPrefix("/api/")
        else { throw MobileBridgeError.invalidRequest }
        var result = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        result.percentEncodedPath = relative.percentEncodedPath
        result.percentEncodedQuery = relative.percentEncodedQuery
        guard let url = result.url else { throw MobileBridgeError.invalidRequest }
        return url
    }

    static func headers(_ raw: [String: Any]) throws -> [String: String] {
        guard raw.count <= 24 else { throw MobileBridgeError.invalidRequest }
        var result = [String: String]()
        for (name, value) in raw {
            let lower = name.lowercased()
            guard requestHeaders.contains(lower), let text = value as? String,
                  text.utf8.count <= 8192, !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  result[lower] == nil else { throw MobileBridgeError.invalidRequest }
            result[lower] = text
        }
        return result
    }

    static func body(_ raw: String?) throws -> Data? {
        guard let raw else { return nil }
        guard raw.utf8.count <= ((requestLimit + 2) / 3) * 4,
              let data = Data(base64Encoded: raw), data.count <= requestLimit else { throw MobileBridgeError.tooLarge }
        return data
    }
}
