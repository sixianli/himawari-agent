#if os(macOS)
import AppKit
import Foundation
import HimawariCore
import HimawariShell
import SQLite3

enum MessagesDatabaseError: Error, Equatable {
    case cannotOpen(String)
    case query(String)
}

final class MessagesDatabase {
    static var defaultFile: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/chat.db")
    }

    static func readable(_ file: URL = defaultFile) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? handle.close() }
        return (try? handle.read(upToCount: 16))?.isEmpty == false
    }

    struct Batch: Sendable {
        let missing: [String]
        let newest: Int64
        let rows: [MessageRow]
    }

    static func batch(after row: Int64?, limit: Int) throws -> Batch {
        let database = try MessagesDatabase()
        let schema = try database.schema()
        guard schema.missing.isEmpty else { return Batch(missing: schema.missing, newest: 0, rows: []) }
        guard let row else { return Batch(missing: [], newest: try database.newestRow(schema), rows: []) }
        return Batch(missing: [], newest: row, rows: try database.rows(after: row, limit: limit, schema: schema))
    }

    private let handle: OpaquePointer

    init(file: URL = defaultFile) throws {
        var connection: OpaquePointer?
        let uri = "file:\(file.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file.path)?mode=ro"
        guard sqlite3_open_v2(uri, &connection, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let connection else {
            let message = connection.map { String(cString: sqlite3_errmsg($0)) } ?? "open"
            sqlite3_close(connection)
            throw MessagesDatabaseError.cannotOpen(message)
        }
        sqlite3_busy_timeout(connection, 2000)
        handle = connection
    }

    deinit {
        sqlite3_close(handle)
    }

    func schema() throws -> MessagesSchema {
        MessagesSchema(message: try columns("message"), handle: try columns("handle"))
    }

    private func columns(_ table: String) throws -> [String] {
        let statement = try prepare("PRAGMA table_info(\(table))")
        defer { sqlite3_finalize(statement) }
        var names: [String] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw MessagesDatabaseError.query(lastError) }
            if let name = string(statement, 1) { names.append(name) }
        }
        return names
    }

    func newestRow(_ schema: MessagesSchema) throws -> Int64 {
        let statement = try prepare(schema.newestQuery)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw MessagesDatabaseError.query(lastError) }
        return sqlite3_column_int64(statement, 0)
    }

    func rows(after row: Int64, limit: Int, schema: MessagesSchema) throws -> [MessageRow] {
        guard let query = schema.rowsQuery else { return [] }
        let statement = try prepare(query)
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, row)
        sqlite3_bind_int64(statement, 2, Int64(limit))
        var rows: [MessageRow] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw MessagesDatabaseError.query(lastError) }
            rows.append(MessageRow(
                rowId: sqlite3_column_int64(statement, 0),
                guid: string(statement, 1) ?? "",
                text: string(statement, 2).flatMap { $0.isEmpty ? nil : $0 } ?? blob(statement, 3).flatMap(TypedStreamText.string),
                appleDate: sqlite3_column_int64(statement, 4),
                fromMe: sqlite3_column_int64(statement, 5) != 0,
                service: string(statement, 6),
                sender: string(statement, 7)
            ))
        }
        return rows
    }

    private var lastError: String { String(cString: sqlite3_errmsg(handle)) }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw MessagesDatabaseError.query(lastError)
        }
        return statement
    }

    private func string(_ statement: OpaquePointer, _ column: Int32) -> String? {
        guard sqlite3_column_type(statement, column) != SQLITE_NULL, let text = sqlite3_column_text(statement, column) else { return nil }
        return String(cString: text)
    }

    private func blob(_ statement: OpaquePointer, _ column: Int32) -> Data? {
        guard sqlite3_column_type(statement, column) != SQLITE_NULL, let bytes = sqlite3_column_blob(statement, column) else { return nil }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, column)))
    }
}

@MainActor
final class MessagesSensor {
    private let settings: MacSettingsStore
    private let app: AppModel
    private var loop: Task<Void, Never>?

    init(settings: MacSettingsStore, app: AppModel) {
        self.settings = settings
        self.app = app
    }

    func start() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.tick()
                let seconds = self.app.configuration?.heartbeatSeconds ?? 30
                try? await Task.sleep(for: .seconds(max(seconds, 1)))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func tick() async {
        guard settings.settings.seesMessages, app.phase == .active else { return }
        settings.refreshPermissions()
        guard settings.messagesReadable else { return }
        guard let limit = app.configuration?.limit(MessageSensing.batchLimitKey), limit > 0 else {
            settings.reportMessages(.serverNotReady)
            return
        }
        while settings.settings.seesMessages, !Task.isCancelled {
            let saved = settings.settings.messagesAfterRow
            let epoch = settings.messagesEpoch
            let batch: MessagesDatabase.Batch
            do {
                batch = try await Task.detached(priority: .utility) { try MessagesDatabase.batch(after: saved, limit: Int(limit)) }.value
            } catch {
                settings.reportMessages(.cannotRead)
                return
            }
            guard epoch == settings.messagesEpoch, settings.settings.seesMessages else { return }
            guard batch.missing.isEmpty else {
                settings.reportMessages(.unknownLayout(batch.missing))
                return
            }
            guard let saved else {
                settings.moveMessagesCursor(from: nil, to: batch.newest, epoch: epoch)
                settings.reportMessages(nil)
                return
            }
            guard let last = batch.rows.last else {
                settings.reportMessages(nil)
                return
            }
            let records = batch.rows.compactMap(MessageSensing.record)
            if !records.isEmpty {
                do {
                    _ = try await app.api.perceiveSkippingInvalid(records)
                } catch {
                    settings.reportMessages(.cannotSend)
                    return
                }
            }
            guard settings.moveMessagesCursor(from: saved, to: last.rowId, epoch: epoch) else { return }
        }
    }
}
#endif
