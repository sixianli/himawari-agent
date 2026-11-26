import Foundation

public enum ManageGatewayError: Error, Equatable, Sendable {
    case unknownType(ClientGateway, String)
    case notOnPhone(String)
    case rejected(status: Int, code: String?, reason: String? = nil)
    case malformedResponse
}

public struct ManageCommandOptions: Sendable {
    public var risk: String
    public var dataClassification: String
    public var confirmReason: String
    public var idempotencyKey: String?

    public init(risk: String = "low", dataClassification: String = "private", confirmReason: String, idempotencyKey: String? = nil) {
        self.risk = risk
        self.dataClassification = dataClassification
        self.confirmReason = confirmReason
        self.idempotencyKey = idempotencyKey
    }
}

public actor ManageGateway {
    public static let gatewayPath = "gateway"
    public static let challengePath = "approvals/challenge"
    public static let textPath = "payloads/text/new"

    private let transport: DeviceTransport
    private let makeIdentifier: @Sendable () -> String

    public init(
        transport: DeviceTransport,
        makeIdentifier: @escaping @Sendable () -> String = {
            UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        }
    ) {
        self.transport = transport
        self.makeIdentifier = makeIdentifier
    }

    public func read(_ gateway: ClientGateway, _ type: String, payload: JSONValue = [:]) async throws -> Data {
        let capability = try capability(gateway, type)
        guard capability.tier == .read else { throw ManageGatewayError.unknownType(gateway, type) }
        var body = envelope(gateway, type, payload: payload, dataClassification: "private", risk: "low")
        if capability.kind == .command { body["idempotencyKey"] = .string("device-\(makeIdentifier())") }
        return try await send(path: Self.gatewayPath, body: .object(body), nonce: nil, confirm: nil)
    }

    public func command(
        _ gateway: ClientGateway,
        _ type: String,
        payload: JSONValue,
        options: ManageCommandOptions
    ) async throws -> Data {
        let capability = try capability(gateway, type)
        guard capability.kind == .command else { throw ManageGatewayError.unknownType(gateway, type) }
        var body = envelope(
            gateway,
            type,
            payload: Self.withPlaceholders(payload),
            dataClassification: options.dataClassification,
            risk: options.risk
        )
        body["idempotencyKey"] = .string(options.idempotencyKey ?? "device-\(makeIdentifier())")
        switch capability.requiredTier(payload: payload) {
        case .read, .routine, .tighten:
            return try await send(path: Self.gatewayPath, body: .object(body), nonce: nil, confirm: nil)
        case .change:
            let challenge = try await issueChallenge()
            return try await send(
                path: Self.gatewayPath,
                body: .object(body),
                nonce: challenge,
                confirm: ConfirmPrompt(reason: options.confirmReason)
            )
        case .notOnPhone:
            throw ManageGatewayError.notOnPhone(type)
        }
    }

    public func post(_ path: String, body: JSONValue) async throws -> Data {
        try await send(path: path, body: body, nonce: nil, confirm: nil)
    }

    public func uploadText(_ content: String, dataClassification: String = "private") async throws -> String {
        let data = try await send(
            path: Self.textPath,
            body: [
                "idempotencyKey": .string("device-text-\(makeIdentifier())"),
                "content": .string(content),
                "dataClassification": .string(dataClassification),
            ],
            nonce: nil,
            confirm: nil
        )
        struct Uploaded: Decodable { let payloadRef: String }
        guard let uploaded = try? JSONDecoder().decode(Uploaded.self, from: data) else {
            throw ManageGatewayError.malformedResponse
        }
        return uploaded.payloadRef
    }

    static func withPlaceholders(_ payload: JSONValue) -> JSONValue {
        guard case .object(var fields) = payload else { return payload }
        for key in ClientCapabilities.serverFilledReferences where fields[key] != nil {
            fields[key] = .string(ClientCapabilities.referencePlaceholder)
        }
        return .object(fields)
    }

    private func envelope(
        _ gateway: ClientGateway,
        _ type: String,
        payload: JSONValue,
        dataClassification: String,
        risk: String
    ) -> [String: JSONValue] {
        var body: [String: JSONValue] = [
            "gateway": .string(gateway.rawValue),
            "type": .string(type),
            "messageId": .string("device-\(makeIdentifier())"),
            "payload": payload,
        ]
        if gateway != .threadV3 { body["dataClassification"] = .string(dataClassification) }
        if gateway == .v2 { body["risk"] = .string(risk) }
        return body
    }

    private func issueChallenge() async throws -> String {
        let data = try await send(path: Self.challengePath, body: [:], nonce: nil, confirm: nil)
        struct Issued: Decodable { let challenge: String }
        guard let issued = try? JSONDecoder().decode(Issued.self, from: data) else {
            throw ManageGatewayError.malformedResponse
        }
        return issued.challenge
    }

    private func capability(_ gateway: ClientGateway, _ type: String) throws -> ClientCapability {
        guard let capability = ClientCapabilities.find(gateway, type) else {
            throw ManageGatewayError.unknownType(gateway, type)
        }
        if capability.tier == .notOnPhone { throw ManageGatewayError.notOnPhone(type) }
        return capability
    }

    private func send(path: String, body: JSONValue, nonce: String?, confirm: ConfirmPrompt?) async throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let response = try await transport.post(
            path: path,
            json: try encoder.encode(body),
            nonce: nonce,
            confirm: confirm
        )
        guard (200..<300).contains(response.status) else {
            struct Failure: Decodable {
                struct Detail: Decodable {
                    let code: String
                    let reasonCode: String?
                }
                let error: Detail
            }
            let detail = (try? JSONDecoder().decode(Failure.self, from: response.body))?.error
            throw ManageGatewayError.rejected(
                status: response.status,
                code: detail?.code.nonEmpty,
                reason: detail?.reasonCode?.nonEmpty
            )
        }
        return response.body
    }
}
