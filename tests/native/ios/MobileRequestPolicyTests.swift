import Foundation

/// Runs against the production bridge policy on macOS without a signing identity or simulator.
@main
struct MobileRequestPolicyTests {
    static func main() throws {
        var checks = 0
        func expect(_ value: Bool, _ label: String) throws {
            checks += 1
            if !value { throw NSError(domain: "MobileRequestPolicyTests", code: checks, userInfo: [NSLocalizedDescriptionKey: label]) }
        }
        func rejects(_ label: String, _ block: () throws -> Void) throws {
            var rejected = false
            do { try block() } catch { rejected = true }
            try expect(rejected, label)
        }

        guard let origin = MobileRequestPolicy.origin("https://im-alive.ru") else { fatalError("Valid origin rejected") }
        try expect(MobileRequestPolicy.origin("https://staging.example.com:8443/") != nil, "HTTPS staging origin")
        for invalid in ["http://im-alive.ru", "https://user:pass@im-alive.ru", "https://im-alive.ru/path",
                        "https://im-alive.ru?x=1", "https://im-alive.ru#fragment", "//im-alive.ru", " https://im-alive.ru"] {
            try expect(MobileRequestPolicy.origin(invalid) == nil, "Reject origin \(invalid)")
        }
        let valid = try MobileRequestPolicy.url(origin: origin, path: "/api/v1/earth/location?value=a%2Fb")
        try expect(valid.absoluteString == "https://im-alive.ru/api/v1/earth/location?value=a%2Fb", "Query value does not alter path")
        for invalid in ["https://evil.example/api/v1/me", "//evil.example/api/v1/me", "/api/v1/../auth",
                        "/api/v1/%2e%2e/auth", "/api/v1/foo%2fbar", "/api/v1/foo%5cbar", "/api/v1/%252e%252e/auth",
                        "/api/v1/\u{0000}bad", "/api/v1/%00bad", "/api/v1/%0Abad", "/api/v1/%0Dbad",
                        "/api/v1//auth/mobile/exchange", "/api/v1/me#fragment", "/api/v1\\evil", "/outside",
                        "/api/v1/auth/mobile", "/api/v1/auth/mobile/authorize", "/api/v1/auth/mobile/exchange",
                        "/api/v1/auth/mobile%2Fexchange"] {
            try rejects("Reject path \(invalid)") { _ = try MobileRequestPolicy.url(origin: origin, path: invalid) }
        }
        let website = try MobileRequestPolicy.url(origin: origin, path: "/?profile=1", api: false)
        try expect(website.host == "im-alive.ru", "Website stays on pinned host")
        try rejects("Website cannot expose API") { _ = try MobileRequestPolicy.url(origin: origin, path: "/api/v1/auth/mobile/exchange", api: false) }

        let headers = try MobileRequestPolicy.headers(["Accept": "application/json", "X-Game-Generation": "42", "Idempotency-Key": "test"])
        try expect(headers["x-game-generation"] == "42", "Game headers preserved")
        for forbidden in ["Authorization", "Cookie", "Host", "Origin", "Referer", "Connection", "Content-Length"] {
            try rejects("Reject header \(forbidden)") { _ = try MobileRequestPolicy.headers([forbidden: "value"]) }
        }
        try rejects("Reject header newlines") { _ = try MobileRequestPolicy.headers(["Accept": "application/json\r\nCookie: injected"]) }
        try rejects("Reject header controls") { _ = try MobileRequestPolicy.headers(["Accept": "\u{0000}"]) }
        try rejects("Reject duplicate case header") { _ = try MobileRequestPolicy.headers(["Accept": "a", "accept": "b"]) }
        try rejects("Reject nonstring header") { _ = try MobileRequestPolicy.headers(["Accept": 1]) }
        try rejects("Reject oversized header") { _ = try MobileRequestPolicy.headers(["Accept": String(repeating: "a", count: 8193)]) }
        let bytes = Data([0, 255, 128, 65])
        try expect(try MobileRequestPolicy.body(bytes.base64EncodedString()) == bytes, "Binary request roundtrip")
        try expect(try MobileRequestPolicy.body(nil) == nil, "Absent request body")
        try rejects("Reject malformed base64") { _ = try MobileRequestPolicy.body("not-base64!!") }
        try rejects("Reject oversized body") {
            _ = try MobileRequestPolicy.body(Data(repeating: 0, count: MobileRequestPolicy.requestLimit + 1).base64EncodedString())
        }
        try expect(!MobileRequestPolicy.responseHeaders.contains("set-cookie"), "No cookie leaks")
        try expect(!MobileRequestPolicy.responseHeaders.contains("authorization"), "No credential headers")
        print("Mobile request policy: \(checks) assertions passed")
    }
}
