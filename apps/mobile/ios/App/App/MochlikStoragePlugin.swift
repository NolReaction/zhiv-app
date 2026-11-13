import Foundation
import Capacitor
import SQLite3

/// Durable, bounded command receipts. Authentication secrets never enter this database.
@objc(MochlikStoragePlugin)
public final class MochlikStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MochlikStoragePlugin"
    public let jsName = "MochlikStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "put", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]
    private let worker = DispatchQueue(label: "ru.zhiv.mochlik.storage", qos: .userInitiated)
    private var database: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private struct StorageFailure: Error {}

    deinit { if let database { sqlite3_close(database) } }

    private func open() throws -> OpaquePointer {
        if let database { return database }
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: true)
            .appendingPathComponent("MochlikStorage", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        var handle: OpaquePointer?
        guard sqlite3_open_v2(directory.appendingPathComponent("receipts.sqlite").path, &handle,
                              SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let handle else {
            if let handle { sqlite3_close(handle) }
            throw StorageFailure()
        }
        do {
            sqlite3_busy_timeout(handle, 5000)
            try execute(handle, "PRAGMA journal_mode=WAL")
            try execute(handle, "PRAGMA synchronous=FULL")
            let version = try statement(handle, "PRAGMA user_version") { statement -> Int32 in
                guard sqlite3_step(statement) == SQLITE_ROW else { throw StorageFailure() }
                return sqlite3_column_int(statement, 0)
            }
            guard version <= 1 else { throw StorageFailure() }
            try execute(handle, "CREATE TABLE IF NOT EXISTS receipts (owner TEXT NOT NULL, receipt_key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner, receipt_key))")
            try execute(handle, "PRAGMA user_version=1")
            database = handle
            return handle
        } catch { sqlite3_close(handle); throw error }
    }
    private func execute(_ database: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw StorageFailure() }
    }
    private func statement<T>(_ database: OpaquePointer, _ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var pointer: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &pointer, nil) == SQLITE_OK, let pointer else { throw StorageFailure() }
        defer { sqlite3_finalize(pointer) }
        return try body(pointer)
    }
    private func bind(_ statement: OpaquePointer, _ index: Int32, _ value: String) throws {
        guard sqlite3_bind_text(statement, index, value, -1, transient) == SQLITE_OK else { throw StorageFailure() }
    }
    private func validate(_ call: CAPPluginCall, needsValue: Bool = false) throws -> (String, String?, String?) {
        guard let owner = call.getString("owner"), UUID(uuidString: owner) != nil else { throw StorageFailure() }
        let key = call.getString("key")
        if let key, key.range(of: "^[0-9]{1,16}:[0-9a-fA-F-]{36}$", options: .regularExpression) == nil { throw StorageFailure() }
        let value = call.getString(needsValue ? "value" : "expectedValue")
        if needsValue && (key == nil || value == nil) { throw StorageFailure() }
        if let value, value.utf8.count > 512_000 { throw StorageFailure() }
        return (owner, key, value)
    }
    private func perform(_ call: CAPPluginCall, _ body: @escaping (OpaquePointer) throws -> JSObject) {
        worker.async {
            do { call.resolve(try body(self.open())) }
            catch { call.reject("Не удалось прочитать или сохранить очередь устройства", "STORAGE_FAILED") }
        }
    }
    @objc public func list(_ call: CAPPluginCall) {
        perform(call) { database in
            let (owner, _, _) = try self.validate(call)
            let records = try self.statement(database, "SELECT receipt_key, value FROM receipts WHERE owner=? ORDER BY created_at, receipt_key") { statement -> [JSObject] in
                try self.bind(statement, 1, owner)
                var rows: [JSObject] = []
                while true {
                    let result = sqlite3_step(statement)
                    if result == SQLITE_DONE { break }
                    guard result == SQLITE_ROW, rows.count < 64,
                          let key = sqlite3_column_text(statement, 0), let value = sqlite3_column_text(statement, 1) else { throw StorageFailure() }
                    rows.append(["key": String(cString: key), "value": String(cString: value)])
                }
                return rows
            }
            return ["records": records]
        }
    }
    @objc public func put(_ call: CAPPluginCall) {
        perform(call) { database in
            let (owner, key, value) = try self.validate(call, needsValue: true)
            guard let key, let value else { throw StorageFailure() }
            try self.execute(database, "BEGIN IMMEDIATE")
            do {
                let previous = try self.statement(database, "SELECT value FROM receipts WHERE owner=? AND receipt_key=?") { statement -> String? in
                    try self.bind(statement, 1, owner); try self.bind(statement, 2, key)
                    let result = sqlite3_step(statement)
                    if result == SQLITE_DONE { return nil }
                    guard result == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw StorageFailure() }
                    return String(cString: text)
                }
                if let previous {
                    guard previous == value else { throw StorageFailure() }
                } else {
                    let count = try self.statement(database, "SELECT count(*) FROM receipts") { statement -> Int32 in
                        guard sqlite3_step(statement) == SQLITE_ROW else { throw StorageFailure() }
                        return sqlite3_column_int(statement, 0)
                    }
                    guard count < 64 else { throw StorageFailure() }
                    try self.statement(database, "INSERT INTO receipts(owner,receipt_key,value,created_at) VALUES(?,?,?,?)") { statement in
                        try self.bind(statement, 1, owner); try self.bind(statement, 2, key); try self.bind(statement, 3, value)
                        sqlite3_bind_int64(statement, 4, Int64(Date().timeIntervalSince1970 * 1000))
                        guard sqlite3_step(statement) == SQLITE_DONE else { throw StorageFailure() }
                    }
                }
                try self.execute(database, "COMMIT")
                return [:]
            } catch { try? self.execute(database, "ROLLBACK"); throw error }
        }
    }
    @objc public func remove(_ call: CAPPluginCall) {
        perform(call) { database in
            let (owner, key, value) = try self.validate(call)
            guard let key, let value else { throw StorageFailure() }
            try self.statement(database, "DELETE FROM receipts WHERE owner=? AND receipt_key=? AND value=?") { statement in
                try self.bind(statement, 1, owner); try self.bind(statement, 2, key); try self.bind(statement, 3, value)
                guard sqlite3_step(statement) == SQLITE_DONE else { throw StorageFailure() }
            }
            return [:]
        }
    }
}
