import Foundation

public struct PerceptionRetentionSetting: Codable, Sendable, Equatable {
    public let key: String
    public let days: Int
    public let defaultDays: Int
    public let minDays: Int?
    public let maxDays: Int?

    public func accepts(_ value: Int) -> Bool {
        value >= (minDays ?? 1) && maxDays.map { value <= $0 } ?? true
    }
}

public struct PerceptionStatusSnapshot: Codable, Sendable, Equatable {
    public let state: String
    public let pausedUntil: String?
    public let senses: [String]
    public let day: String
    public let todayCount: Int
    public let availableSenses: [String]
    public let retention: [PerceptionRetentionSetting]
    public let revision: Int

    public func retention(_ key: String?) -> PerceptionRetentionSetting? {
        guard let key else { return nil }
        return retention.first { $0.key == key }
    }
}

public struct PerceptionEvidencePair: Codable, Sendable, Equatable {
    public let name: String
    public let value: String
}

public struct PerceptionRecordView: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let type: String
    public let sense: String
    public let occurredAt: String
    public let deviceId: String
    public let text: String?
    public let textTruncated: Bool
    public let evidence: [PerceptionEvidencePair]

    public func value(_ name: String) -> String? {
        evidence.first { $0.name == name }?.value
    }

    public func number(_ name: String) -> Double? {
        value(name).flatMap(Double.init)
    }
}

public struct PerceptionEpisodeView: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let startedAt: String
    public let endedAt: String
    public let recordCount: Int
    public let senses: [String]
    public let types: [String]
    public let preview: String?
    public let summary: String?
}

public struct PerceptionDayRow: Codable, Sendable, Equatable {
    public let kind: String
    public let at: String
    public let episode: PerceptionEpisodeView?
    public let record: PerceptionRecordView?
}

public struct PerceptionDaySnapshot: Codable, Sendable, Equatable {
    public let day: String
    public let total: Int
    public let rows: [PerceptionDayRow]
    public let nextCursor: String?
}

public struct PerceptionEpisodeSnapshot: Codable, Sendable, Equatable {
    public let episode: PerceptionEpisodeView?
    public let records: [PerceptionRecordView]
    public let nextCursor: String?

    public init(episode: PerceptionEpisodeView?, records: [PerceptionRecordView], nextCursor: String?) {
        self.episode = episode
        self.records = records
        self.nextCursor = nextCursor
    }
}

public enum SensesGatewayError: Error, Sendable, Equatable {
    case notInstalled
    case confirmationCancelled
}

public protocol ConfirmationSigner: Sendable {
    func confirmKey() -> DeviceKeySigner
}

public final class SensesGateway: Sendable {
    public static let gateway = "v2"

    private let api: DeviceAPI
    private let confirmation: ConfirmationSigner?

    public init(api: DeviceAPI, confirmation: ConfirmationSigner?) {
        self.api = api
        self.confirmation = confirmation
    }

    public func status() async throws -> PerceptionStatusSnapshot {
        try await query("perception.status.read", payload: EmptyPayload())
    }

    public func day(types: [String], cursor: String? = nil) async throws -> PerceptionDaySnapshot {
        try await day(nil, types: types, cursor: cursor)
    }

    public func day(_ day: String?, types: [String]? = nil, cursor: String? = nil) async throws -> PerceptionDaySnapshot {
        struct Payload: Encodable {
            let day: String?
            let sense: String?
            let types: [String]?
            let cursor: String?

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(day, forKey: .day)
                try container.encode(sense, forKey: .sense)
                try container.encode(types, forKey: .types)
                try container.encode(cursor, forKey: .cursor)
            }

            enum CodingKeys: String, CodingKey { case day, sense, types, cursor }
        }
        return try await query("perception.day.read", payload: Payload(day: day, sense: nil, types: types, cursor: cursor))
    }

    public func episode(_ episodeId: String, cursor: String? = nil) async throws -> PerceptionEpisodeSnapshot {
        struct Payload: Encodable {
            let episodeId: String
            let cursor: String?

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(episodeId, forKey: .episodeId)
                try container.encode(cursor, forKey: .cursor)
            }

            enum CodingKeys: String, CodingKey { case episodeId, cursor }
        }
        return try await query("perception.episode.read", payload: Payload(episodeId: episodeId, cursor: cursor))
    }

    public func setSense(_ sense: String, enabled: Bool, expectedRevision: Int, reason: String) async throws {
        try await command("perception.settings.change", payload: SettingsPayload(
            expectedRevision: expectedRevision, kind: "sense", sense: sense, enabled: enabled, until: nil, key: nil, value: nil
        ), confirm: enabled, reason: reason)
    }

    public func setRetention(key: String, days: Int?, expectedRevision: Int, reason: String) async throws {
        try await command("perception.settings.change", payload: SettingsPayload(
            expectedRevision: expectedRevision, kind: "retention", sense: nil, enabled: nil, until: nil, key: key, value: days
        ), confirm: true, reason: reason)
    }

    public func planDeletion(_ target: PerceptionDeletionTarget) async throws -> PerceptionDeletionSnapshot {
        try await query("perception.deletion.plan", payload: target)
    }

    public func readDeletion(_ planId: String) async throws -> PerceptionDeletionSnapshot {
        try await query("perception.deletion.read", payload: PlanPayload(planId: planId))
    }

    public func delete(_ target: PerceptionDeletionTarget, reason: String) async throws -> PerceptionDeletionSnapshot {
        let plan = try await planDeletion(target)
        guard let planId = plan.planId else { throw DeviceAPIError.invalidResponse }
        try await command("perception.records.delete", payload: PlanPayload(planId: planId), confirm: true, reason: reason)
        return try await readDeletion(planId)
    }

    struct PlanPayload: Encodable { let planId: String }

    struct EmptyPayload: Encodable {}

    struct Challenge: Decodable { let challenge: String }

    struct SettingsPayload: Encodable {
        let expectedRevision: Int
        let kind: String
        let sense: String?
        let enabled: Bool?
        let until: String?
        let key: String?
        let value: Int?

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(expectedRevision, forKey: .expectedRevision)
            try container.encode(kind, forKey: .kind)
            try container.encode(sense, forKey: .sense)
            try container.encode(enabled, forKey: .enabled)
            try container.encode(until, forKey: .until)
            try container.encode(key, forKey: .key)
            try container.encode(value, forKey: .value)
        }

        enum CodingKeys: String, CodingKey { case expectedRevision, kind, sense, enabled, until, key, value }
    }

    struct Body<Payload: Encodable>: Encodable {
        let gateway: String
        let type: String
        let messageId: String
        let idempotencyKey: String?
        let dataClassification: String
        let risk: String
        let payload: Payload

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(gateway, forKey: .gateway)
            try container.encode(type, forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encodeIfPresent(idempotencyKey, forKey: .idempotencyKey)
            try container.encode(dataClassification, forKey: .dataClassification)
            try container.encode(risk, forKey: .risk)
            try container.encode(payload, forKey: .payload)
        }

        enum CodingKeys: String, CodingKey { case gateway, type, messageId, idempotencyKey, dataClassification, risk, payload }
    }

    static let dataClassification = "private"
    static let risk = "low"

    func query<Payload: Encodable, Result: Decodable>(_ type: String, payload: Payload) async throws -> Result {
        let body = Body(gateway: Self.gateway, type: type, messageId: Self.messageId(), idempotencyKey: nil, dataClassification: Self.dataClassification, risk: Self.risk, payload: payload)
        let data = try await send(DeviceRequest(method: "POST", path: "gateway", body: try JSONEncoder().encode(body)))
        return try decodePayload(Result.self, data)
    }

    @discardableResult
    func command<Payload: Encodable>(_ type: String, payload: Payload, confirm: Bool, reason: String) async throws -> Data {
        let id = Self.messageId()
        let body = Body(gateway: Self.gateway, type: type, messageId: id, idempotencyKey: id, dataClassification: Self.dataClassification, risk: Self.risk, payload: payload)
        let encoded = try JSONEncoder().encode(body)
        guard confirm else {
            return try await send(DeviceRequest(method: "POST", path: "gateway", body: encoded))
        }
        guard let confirmation else { throw SensesGatewayError.confirmationCancelled }
        let challenge = try api.decode(Challenge.self, try await api.http.send(DeviceRequest(method: "POST", path: "approvals/challenge")))
        return try await send(DeviceRequest(
            method: "POST",
            path: "gateway",
            body: encoded,
            nonce: challenge.challenge,
            confirmSigner: confirmation.confirmKey(),
            confirmReason: reason
        ))
    }

    private func send(_ request: DeviceRequest) async throws -> Data {
        do {
            return try await api.http.send(request)
        } catch let error as DeviceAPIError {
            if case let .server(status, code, _, _) = error,
               status == 404 || code == "DEVICE_GATEWAY_TYPE_UNKNOWN" || code == "DEVICE_GATEWAY_NOT_ON_PHONE" {
                throw SensesGatewayError.notInstalled
            }
            throw error
        }
    }

    func decodePayload<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try api.decode(GatewayEnvelope<T>.self, data).payload
    }

    static func messageId() -> String {
        "device-" + RandomToken.base64URL(byteCount: 18)
    }
}
