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

public struct PerceptionRecordBody: Codable, Sendable, Equatable {
    public let id: String
    public let type: String
    public let captureSource: String
    public let occurredAt: String
    public let confidence: Int
    public let text: String?
    public let evidence: [String: String]
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
        let seconds = abs(appleDate) >= 1_000_000_000_000 ? Double(appleDate) / 1_000_000_000 : Double(appleDate)
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

    public static func record(_ row: MessageRow) -> PerceptionRecordBody? {
        guard let service = service(row.service) else { return nil }
        guard let text = row.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        var evidence = ["service": service, "direction": row.fromMe ? "outgoing" : "incoming"]
        if let sender = row.sender?.trimmingCharacters(in: .whitespacesAndNewlines), !sender.isEmpty {
            evidence["sender"] = utf16Prefix(sender, limit: senderLimit)
        }
        return PerceptionRecordBody(
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

    public static func startingRow(enabled: Bool, saved: Int64?, newest: Int64) -> Int64? {
        guard enabled else { return nil }
        return saved ?? newest
    }
}

extension DeviceAPI {
    public func perceiveSkippingInvalid(_ records: [PerceptionRecordBody]) async throws -> [String] {
        guard !records.isEmpty else { return [] }
        do {
            _ = try await perceive(records)
            return []
        } catch DeviceAPIError.server(status: 400, _, _) where records.count > 1 {
            var skipped: [String] = []
            for record in records {
                do {
                    _ = try await perceive([record])
                } catch DeviceAPIError.server(status: 400, _, _) {
                    skipped.append(record.id)
                }
            }
            return skipped
        } catch DeviceAPIError.server(status: 400, _, _) {
            return records.map(\.id)
        }
    }

    public func perceive(_ records: [PerceptionRecordBody]) async throws -> PerceptionIngestReply {
        struct Body: Encodable { let records: [PerceptionRecordBody] }
        let data = try await http.send(DeviceRequest(method: "POST", path: "perception", body: try JSONEncoder().encode(Body(records: records))))
        return try decode(PerceptionIngestReply.self, data)
    }
}
