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

    func newestRow() throws -> Int64 {
        let statement = try prepare("SELECT IFNULL(MAX(ROWID), 0) FROM message")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw MessagesDatabaseError.query(lastError) }
        return sqlite3_column_int64(statement, 0)
    }

    func rows(after row: Int64, limit: Int) throws -> [MessageRow] {
        let statement = try prepare("""
            SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.service, h.id
            FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.ROWID > ? AND m.item_type = 0 AND m.associated_message_type = 0
            ORDER BY m.ROWID LIMIT ?
            """)
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
                text: string(statement, 2) ?? Self.attributedText(blob(statement, 3)),
                appleDate: sqlite3_column_int64(statement, 4),
                fromMe: sqlite3_column_int64(statement, 5) != 0,
                service: string(statement, 6),
                sender: string(statement, 7)
            ))
        }
        return rows
    }

    static func attributedText(_ data: Data?) -> String? {
        guard let data, !data.isEmpty else { return nil }
        return (NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString)?.string
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
        guard let batch = app.configuration?.limit(MessageSensing.batchLimitKey), batch > 0 else { return }
        guard let database = try? MessagesDatabase() else { return }
        guard let newest = try? database.newestRow(),
              let start = MessageSensing.startingRow(enabled: true, saved: settings.settings.messagesAfterRow, newest: newest)
        else { return }
        if settings.settings.messagesAfterRow == nil {
            settings.setMessagesAfterRow(start)
            return
        }
        var after = start
        while settings.settings.seesMessages, !Task.isCancelled {
            guard let rows = try? database.rows(after: after, limit: Int(batch)), let last = rows.last else { return }
            let records = rows.compactMap(MessageSensing.record)
            if !records.isEmpty {
                guard (try? await app.api.perceiveSkippingInvalid(records)) != nil else { return }
            }
            guard settings.settings.seesMessages else { return }
            after = last.rowId
            settings.setMessagesAfterRow(after)
        }
    }
}
#endif
