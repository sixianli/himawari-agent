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
    public var id: String { messageId }

    public init(messageId: String = OutgoingMessage.newId(), threadId: String, expectedRevision: Int, text: String, createdAt: Date) {
        self.messageId = messageId
        self.threadId = threadId
        self.expectedRevision = expectedRevision
        self.text = text
        self.createdAt = createdAt
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

    public func texts(for refs: [String]) async throws -> [String: String] {
        var result: [String: String] = [:]
        var seen = Set<String>()
        let unique = refs.filter { seen.insert($0).inserted }
        struct Body: Encodable { let refs: [String] }
        struct Item: Decodable { let text: String }
        struct Result: Decodable { let items: [String: Item?] }
        for start in stride(from: 0, to: unique.count, by: Self.textBatchLimit) {
            let batch = Array(unique[start..<min(start + Self.textBatchLimit, unique.count)])
            let data = try await http.send(DeviceRequest(method: "POST", path: "payloads/text", body: try JSONEncoder().encode(Body(refs: batch))))
            for (ref, item) in try decode(Result.self, data).items {
                if let item { result[ref] = item.text }
            }
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
        }
        let body = Body(messageId: message.messageId, threadId: message.threadId, expectedRevision: message.expectedRevision, text: message.text)
        let data = try await http.send(DeviceRequest(method: "POST", path: "messages", body: try JSONEncoder().encode(body)))
        return try outcome(data)
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
