import Foundation

public struct MessageRow: Sendable, Equatable {
    public let rowId: Int64
    public let guid: String
    public let text: String?
    public let appleDate: Int64
    public let fromMe: Bool
    public let service: String?
    public let sender: String?

    public init(rowId: Int64, guid: String, text: String?, appleDate: Int64, fromMe: Bool, service: String?, sender: String?) {
        self.rowId = rowId
        self.guid = guid
        self.text = text
        self.appleDate = appleDate
        self.fromMe = fromMe
        self.service = service
        self.sender = sender
    }
}

public struct PerceptionIngestReply: Decodable, Sendable, Equatable {
    public struct Outcome: Decodable, Sendable, Equatable {
        public let id: String
        public let outcome: String
    }

    public let outcomes: [Outcome]
    public let reached: [String]
}

public enum MessageSensing {
    public static let recordType = "message.text"
    public static let captureSource = "system_api"
    public static let batchLimitKey = "device.perception.batch_records"
    public static let textLimit = 32 * 1024
    public static let senderLimit = 128

    public static func service(_ raw: String?) -> String? {
        switch raw?.lowercased() {
        case "imessage": "imessage"
        case "sms", "rcs": "sms"
        default: nil
        }
    }

    public static func date(_ appleDate: Int64) -> Date {
        let seconds = appleDate.magnitude >= 1_000_000_000_000 ? Double(appleDate) / 1_000_000_000 : Double(appleDate)
        return Date(timeIntervalSinceReferenceDate: seconds)
    }

    public static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    public static func recordId(guid: String) -> String {
        "perception:" + Hashing.sha256(Data("message.text\n\(guid)".utf8)).prefix(24).base64URLEncodedString()
    }

    public static func record(_ row: MessageRow) -> PerceptionRecordUpload? {
        guard !row.guid.isEmpty, let service = service(row.service) else { return nil }
        guard let text = row.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        var evidence: [String: JSONScalar] = ["service": .string(service), "direction": row.fromMe ? "outgoing" : "incoming"]
        if !row.fromMe, let sender = row.sender?.trimmingCharacters(in: .whitespacesAndNewlines), !sender.isEmpty {
            evidence["sender"] = .string(utf16Prefix(sender, limit: senderLimit))
        }
        return PerceptionRecordUpload(
            id: recordId(guid: row.guid),
            type: recordType,
            captureSource: captureSource,
            occurredAt: timestamp(date(row.appleDate)),
            confidence: 1000,
            text: utf16Prefix(text, limit: textLimit),
            evidence: evidence
        )
    }

    static func utf16Prefix(_ text: String, limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var result = ""
        var used = 0
        for character in text {
            let size = character.utf16.count
            if used + size > limit { break }
            result.append(character)
            used += size
        }
        return result
    }
}

public enum PerceptionUploadError: Error, Sendable, Equatable {
    case allRejected(ids: [String])
}

extension DeviceAPI {
    public func perceiveSkippingInvalid(_ records: [PerceptionRecordUpload]) async throws -> [String] {
        guard !records.isEmpty else { return [] }
        do {
            _ = try await perceive(records)
            return []
        } catch DeviceAPIError.server(status: 400, _, _, _) where records.count > 1 {
            var skipped: [String] = []
            for record in records {
                do {
                    _ = try await perceive([record])
                } catch DeviceAPIError.server(status: 400, _, _, _) {
                    skipped.append(record.id)
                }
            }
            guard skipped.count < records.count else { throw PerceptionUploadError.allRejected(ids: skipped) }
            return skipped
        } catch DeviceAPIError.server(status: 400, _, _, _) {
            throw PerceptionUploadError.allRejected(ids: records.map(\.id))
        }
    }

    public func perceive(_ records: [PerceptionRecordUpload]) async throws -> PerceptionIngestReply {
        struct Body: Encodable { let records: [PerceptionRecordUpload] }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try await http.send(DeviceRequest(method: "POST", path: "perception", body: try encoder.encode(Body(records: records))))
        return try decode(PerceptionIngestReply.self, data)
    }
}

public struct MessagesSchema: Sendable, Equatable {
    public static let requiredMessageColumns = ["guid", "date", "service"]

    public let message: Set<String>
    public let handle: Set<String>

    public init(message: [String], handle: [String]) {
        self.message = Set(message.map { $0.lowercased() })
        self.handle = Set(handle.map { $0.lowercased() })
    }

    public var missing: [String] {
        Self.requiredMessageColumns.filter { !message.contains($0) }
    }

    public var newestQuery: String {
        "SELECT IFNULL(MAX(ROWID), 0) FROM message"
    }

    public var rowsQuery: String? {
        guard missing.isEmpty else { return nil }
        let joinsHandle = message.contains("handle_id") && handle.contains("id")
        let columns: [String] = [
            "m.ROWID",
            "m.guid",
            column("text", fallback: "NULL"),
            column("attributedbody", fallback: "NULL", name: "attributedBody"),
            "m.date",
            column("is_from_me", fallback: "0"),
            "m.service",
            joinsHandle ? "h.id" : "NULL",
        ]
        var filters = ["m.ROWID > ?"]
        if message.contains("item_type") { filters.append("IFNULL(m.item_type, 0) = 0") }
        if message.contains("associated_message_type") { filters.append("IFNULL(m.associated_message_type, 0) = 0") }
        var parts: [String] = ["SELECT", columns.joined(separator: ", "), "FROM message m"]
        if joinsHandle { parts.append("LEFT JOIN handle h ON h.ROWID = m.handle_id") }
        parts.append("WHERE")
        parts.append(filters.joined(separator: " AND "))
        parts.append("ORDER BY m.ROWID LIMIT ?")
        return parts.joined(separator: " ")
    }

    private func column(_ key: String, fallback: String, name: String? = nil) -> String {
        message.contains(key) ? "m." + (name ?? key) : fallback
    }
}
