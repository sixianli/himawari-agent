import Foundation

public struct PairingRequest: Encodable, Sendable {
    public let pairingCode: String
    public let kind: DeviceKind
    public let name: String
    public let releaseChannel: ReleaseChannel
    public let devicePublicKey: String
    public let confirmPublicKey: String
}

public struct OutgoingMessage: Codable, Sendable, Equatable, Identifiable {
    public let messageId: String
    public let threadId: String
    public var expectedRevision: Int
    public let text: String
    public let createdAt: Date
    public let spoken: Bool?
    public var id: String { messageId }

    public init(messageId: String = OutgoingMessage.newId(), threadId: String, expectedRevision: Int, text: String, createdAt: Date, spoken: Bool = false) {
        self.messageId = messageId
        self.threadId = threadId
        self.expectedRevision = expectedRevision
        self.text = text
        self.createdAt = createdAt
        self.spoken = spoken ? true : nil
    }

    public static func newId() -> String {
        RandomToken.base64URL(byteCount: 16)
    }
}

public final class DeviceAPI: Sendable {
    public let http: DeviceHTTPClient

    public init(http: DeviceHTTPClient) {
        self.http = http
    }

    public func pair(
        invitation: PairingInvitation,
        kind: DeviceKind,
        name: String,
        releaseChannel: ReleaseChannel,
        deviceKey: DeviceKeySigner,
        confirmKey: DeviceKeySigner
    ) async throws -> PairedDeviceInfo {
        let request = PairingRequest(
            pairingCode: invitation.code,
            kind: kind,
            name: name,
            releaseChannel: releaseChannel,
            devicePublicKey: try deviceKey.publicKeySPKI().base64EncodedString(),
            confirmPublicKey: try confirmKey.publicKeySPKI().base64EncodedString()
        )
        let data = try await http.pair(origin: invitation.origin, access: invitation.access, body: try JSONEncoder().encode(request))
        struct Body: Decodable { let device: PairedDeviceInfo }
        return try decode(Body.self, data).device
    }

    public func configuration() async throws -> DeviceConfiguration {
        try decode(DeviceConfiguration.self, try await http.send(DeviceRequest(method: "GET", path: "config")))
    }

    public func threads(after cursor: String? = nil) async throws -> ThreadCollection {
        let query = cursor.map { [URLQueryItem(name: "after", value: $0)] } ?? []
        let data = try await http.send(DeviceRequest(method: "GET", path: "threads", query: query))
        return try decode(GatewayEnvelope<ThreadCollection>.self, data).payload
    }

    public func thread(_ threadId: String, afterSequence: Int = 0) async throws -> ThreadDetail {
        let data = try await http.send(DeviceRequest(
            method: "GET",
            path: "threads/\(threadId)",
            query: [URLQueryItem(name: "after", value: String(afterSequence))]
        ))
        return try decode(GatewayEnvelope<ThreadDetail>.self, data).payload
    }

    public static let textBatchLimit = 100

    public func execution(threadId: String, runId: String, afterSequence: Int = 0) async throws -> ExecutionPage {
        let data = try await http.send(DeviceRequest(
            method: "GET",
            path: "threads/\(threadId)/runs/\(runId)/execution",
            query: [URLQueryItem(name: "after", value: String(afterSequence))]
        ))
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom(Self.timestamp)
            return try decoder.decode(GatewayEnvelope<ExecutionPage>.self, from: data).payload
        } catch {
            throw DeviceAPIError.invalidResponse
        }
    }

    static func timestamp(_ decoder: Decoder) throws -> Date {
        let value = try decoder.singleValueContainer().decode(String.self)
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) { return date }
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "timestamp"))
    }

    public static let pageLimit = 100

    public func executionRecords(threadId: String, runId: String, known: [ExecutionRecord]) async throws -> [ExecutionRecord] {
        var records = known
        var after = records.map(\.sequence).max() ?? 0
        for _ in 0..<Self.pageLimit {
            let page = try await execution(threadId: threadId, runId: runId, afterSequence: after)
            let seen = Set(records.map(\.id))
            records += page.records.filter { !seen.contains($0.id) }
            guard let next = page.nextSequence else { return records.sorted { $0.sequence < $1.sequence } }
            guard next > after else { throw DeviceAPIError.invalidResponse }
            after = next
        }
        throw DeviceAPIError.invalidResponse
    }

    public func fullThread(_ threadId: String) async throws -> ThreadDetail {
        var page = try await thread(threadId)
        var messages = page.messages
        var after = 0
        var pages = 1
        while let next = page.nextSequence {
            guard next > after, !page.messages.isEmpty, pages < Self.pageLimit else { throw DeviceAPIError.invalidResponse }
            after = next
            pages += 1
            page = try await thread(threadId, afterSequence: next)
            let known = Set(messages.map(\.messageId))
            messages += page.messages.filter { !known.contains($0.messageId) }
        }
        return ThreadDetail(thread: page.thread, messages: messages.sorted { $0.sequence < $1.sequence }, runs: page.runs, nextSequence: nil)
    }

    public func texts(for refs: [String]) async throws -> [String: String] {
        var result: [String: String] = [:]
        var seen = Set<String>()
        let unique = refs.filter { seen.insert($0).inserted }
        struct Body: Encodable { let refs: [String] }
        struct Item: Decodable { let text: String }
        struct Result: Decodable {
            let items: [String: Item?]
            let deferred: [String]?
        }
        var pending = unique[...]
        while !pending.isEmpty {
            let batch = Array(pending.prefix(Self.textBatchLimit))
            pending = pending.dropFirst(batch.count)
            let data = try await http.send(DeviceRequest(method: "POST", path: "payloads/text", body: try JSONEncoder().encode(Body(refs: batch))))
            let page = try decode(Result.self, data)
            for (ref, item) in page.items {
                if let item { result[ref] = item.text }
            }
            let requested = Set(batch)
            let deferred = (page.deferred ?? []).filter { requested.contains($0) && page.items[$0] == nil }
            if deferred.count == batch.count { break }
            pending = deferred[...] + pending
        }
        return result
    }

    public func createThread(requestId: String, answerLocale: AnswerLocale) async throws -> CreatedThread {
        struct Body: Encodable {
            let requestId: String
            let answerLocale: AnswerLocale
        }
        let body = try JSONEncoder().encode(Body(requestId: requestId, answerLocale: answerLocale))
        let data = try await http.send(DeviceRequest(method: "POST", path: "threads", body: body))
        struct Head: Decodable { let type: String }
        guard try decode(Head.self, data).type == "thread.command_result" else { throw DeviceAPIError.invalidResponse }
        let payload = try decode(GatewayEnvelope<CommandResultPayload>.self, data).payload
        guard let threadId = payload.threadId else { throw DeviceAPIError.invalidResponse }
        return CreatedThread(threadId: threadId, threadRevision: payload.threadRevision)
    }

    public func send(_ message: OutgoingMessage) async throws -> CommandOutcome {
        struct Body: Encodable {
            let messageId: String
            let threadId: String
            let expectedRevision: Int
            let text: String
            let spoken: Bool?
        }
        let body = Body(messageId: message.messageId, threadId: message.threadId, expectedRevision: message.expectedRevision, text: message.text, spoken: message.spoken)
        let data = try await http.send(DeviceRequest(method: "POST", path: "messages", body: try JSONEncoder().encode(body)))
        return try outcome(data)
    }

    public func ingest(_ records: [PerceptionRecordUpload]) async throws -> [String: PerceptionIngestOutcome] {
        var outcomes: [String: PerceptionIngestOutcome] = [:]
        for item in try await perceive(records).outcomes where outcomes[item.id] == nil {
            guard let outcome = PerceptionIngestOutcome(rawValue: item.outcome) else { throw DeviceAPIError.invalidResponse }
            outcomes[item.id] = outcome
        }
        return outcomes
    }

    public func uploadMedia(_ data: Data, kind: String, batchId: String, contentType: String) async throws {
        struct Begin: Encodable {
            let purpose: String
            let sha256: String
            let bytes: Int
            let batchId: String
            let mediaKind: String
        }
        struct Granted: Decodable {
            let grant: String
            let path: String
            let header: String
        }
        let begin = Begin(purpose: "media", sha256: Hashing.sha256(data).map { String(format: "%02x", $0) }.joined(), bytes: data.count, batchId: batchId, mediaKind: kind)
        let granted = try decode(Granted.self, try await http.send(DeviceRequest(method: "POST", path: "uploads/begin", body: try JSONEncoder().encode(begin))))
        _ = try await http.upload(path: granted.path, header: granted.header, grant: granted.grant, body: data, contentType: contentType)
    }

    func outcome(_ data: Data) throws -> CommandOutcome {
        struct Head: Decodable { let type: String }
        let head = try decode(Head.self, data)
        switch head.type {
        case "thread.command_result":
            let payload = try decode(GatewayEnvelope<CommandResultPayload>.self, data).payload
            return .accepted(threadRevision: payload.threadRevision, replayed: payload.replayed)
        case "thread.conflict":
            let payload = try decode(GatewayEnvelope<ConflictPayload>.self, data).payload
            return .conflict(reasonCode: payload.reasonCode, latest: payload.latest)
        default:
            throw DeviceAPIError.invalidResponse
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw DeviceAPIError.invalidResponse
        }
    }
}
