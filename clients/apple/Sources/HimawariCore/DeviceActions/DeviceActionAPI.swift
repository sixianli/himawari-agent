import Foundation

public protocol DeviceActionTransport: Sendable {
    func claimActions() async throws -> [DeviceActionDelivery]
    func reopenActions() async throws -> [DeviceActionDelivery]
    func reportAction(_ report: DeviceActionReport) async throws -> DeviceActionReportReply
    func reportSupportedActions(_ names: [String]) async throws -> [String]
    func actionPolicy() async throws -> DevicePolicyView
}

extension DeviceAPI: DeviceActionTransport {
    struct ActionsBody: Decodable { let actions: [DeviceActionDelivery] }

    public func claimActions() async throws -> [DeviceActionDelivery] {
        let data = try await http.send(DeviceRequest(method: "POST", path: "actions/claim", body: Data("{}".utf8)))
        return try decode(ActionsBody.self, data).actions
    }

    public func reopenActions() async throws -> [DeviceActionDelivery] {
        let data = try await http.send(DeviceRequest(method: "POST", path: "actions/open", body: Data("{}".utf8)))
        return try decode(ActionsBody.self, data).actions
    }

    public func reportAction(_ report: DeviceActionReport) async throws -> DeviceActionReportReply {
        do {
            let data = try await http.send(DeviceRequest(method: "POST", path: "actions/result", body: try JSONEncoder().encode(report)))
            struct Body: Decodable { let state: String; let replayed: Bool }
            let body = try decode(Body.self, data)
            return .recorded(state: body.state, replayed: body.replayed)
        } catch let DeviceAPIError.server(status, code, _, _) where status == 404 || status == 409 || status == 400 {
            return .refused(status: status, code: code)
        }
    }

    public func reportSupportedActions(_ names: [String]) async throws -> [String] {
        struct Body: Encodable { let actions: [String] }
        struct Reply: Decodable { let actions: [String] }
        let data = try await http.send(DeviceRequest(method: "POST", path: "actions/supported", body: try JSONEncoder().encode(Body(actions: names.sorted()))))
        return try decode(Reply.self, data).actions
    }

    public func actionPolicy() async throws -> DevicePolicyView {
        try decode(DevicePolicyView.self, try await http.send(DeviceRequest(method: "GET", path: "actions/policy")))
    }

    public func issueConfirmChallenge() async throws -> String {
        struct Reply: Decodable { let challenge: String }
        let data = try await http.send(DeviceRequest(method: "POST", path: "approvals/challenge", body: Data("{}".utf8)))
        return try decode(Reply.self, data).challenge
    }

    public func changeActionPolicy(expectedRevision: Int, blocked: [String], confirm: DeviceKeySigner, reason: String) async throws -> DevicePolicyChange {
        struct Body: Encodable { let expectedRevision: Int; let blockedActions: [String] }
        let body = try JSONEncoder().encode(Body(expectedRevision: expectedRevision, blockedActions: blocked.sorted()))
        do {
            let challenge = try await issueConfirmChallenge()
            let data = try await http.send(DeviceRequest(method: "POST", path: "actions/policy", body: body, nonce: challenge, confirmSigner: confirm, confirmReason: reason))
            return .written(try decode(DevicePolicyView.self, data))
        } catch let DeviceAPIError.server(status, _, _, _) where status == 403 {
            return .ownerPresenceRequired
        } catch let DeviceAPIError.server(status, _, _, _) where status == 409 {
            return .conflict(try await actionPolicy())
        }
    }

    public func actionViews(finishedSince: Date? = nil) async throws -> [DeviceActionView] {
        struct Body: Decodable { let actions: [DeviceActionView] }
        let query = finishedSince.map { [URLQueryItem(name: "finishedSince", value: DeviceActionTime.stamp($0))] } ?? []
        return try decode(Body.self, try await http.send(DeviceRequest(method: "GET", path: "actions", query: query))).actions
    }

    static let approvalPageSize = 100
    static let approvalPageLimit = 5

    private struct GatewayEnvelope<Payload: Encodable>: Encodable {
        let gateway = "v2"
        let type: String
        let messageId: String
        let idempotencyKey: String?
        let dataClassification = "private"
        let risk: String
        let payload: Payload
    }

    private struct ListPayload: Encodable {
        let status: String
        let afterCursor: String?
        let limit: Int

        enum CodingKeys: String, CodingKey { case status, afterCursor, limit }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(status, forKey: .status)
            if let afterCursor { try container.encode(afterCursor, forKey: .afterCursor) } else { try container.encodeNil(forKey: .afterCursor) }
            try container.encode(limit, forKey: .limit)
        }
    }

    private struct DetailPayload: Encodable { let approvalRequestId: String }

    private struct RespondPayload: Encodable {
        let approvalRequestId: String
        let expectedRevision: Int
        let decision: String
        let semanticSnapshotHash: String
        let recentAuthenticationRef = "device"

        enum CodingKeys: String, CodingKey {
            case approvalRequestId, expectedRevision, decision, semanticSnapshotHash, editedPayloadRef, recentAuthenticationRef
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(approvalRequestId, forKey: .approvalRequestId)
            try container.encode(expectedRevision, forKey: .expectedRevision)
            try container.encode(decision, forKey: .decision)
            try container.encode(semanticSnapshotHash, forKey: .semanticSnapshotHash)
            try container.encodeNil(forKey: .editedPayloadRef)
            try container.encode(recentAuthenticationRef, forKey: .recentAuthenticationRef)
        }
    }

    private func gatewayCall<Payload: Encodable>(_ type: String, risk: String = "low", command: Bool = false, _ payload: Payload, nonce: String? = nil, confirm: DeviceKeySigner? = nil, reason: String? = nil) async throws -> Data {
        let identifier = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let envelope = GatewayEnvelope(type: type, messageId: "device-\(identifier)", idempotencyKey: command ? "device-\(identifier)" : nil, risk: risk, payload: payload)
        return try await http.send(DeviceRequest(method: "POST", path: "gateway", body: try JSONEncoder().encode(envelope), nonce: nonce, confirmSigner: confirm, confirmReason: reason))
    }

    public func approvals(status: ApprovalStatus) async throws -> [PendingApproval] {
        struct Page: Decodable {
            struct Payload: Decodable { let itemRefs: [String]; let nextCursor: String? }
            let payload: Payload
        }
        struct Detail: Decodable { let payload: PendingApproval }
        var refs: [String] = []
        var cursor: String?
        for _ in 0..<Self.approvalPageLimit {
            let page = try decode(Page.self, try await gatewayCall("approval.list", ListPayload(status: status.rawValue, afterCursor: cursor, limit: Self.approvalPageSize)))
            refs += page.payload.itemRefs
            guard let next = page.payload.nextCursor else { break }
            cursor = next
        }
        var found: [PendingApproval] = []
        for ref in refs {
            let data = try await gatewayCall("approval.detail", DetailPayload(approvalRequestId: ref))
            found.append(try decode(Detail.self, data).payload)
        }
        return found
    }

    public func respond(to approval: PendingApproval, approved: Bool, confirm: DeviceKeySigner?, reason: String?) async throws -> ApprovalResponse {
        guard let confirm else { throw DeviceAPIError.server(status: 403, code: "CONFIRM_REQUIRED") }
        let payload = RespondPayload(
            approvalRequestId: approval.id,
            expectedRevision: approval.revision,
            decision: approved ? "approved" : "denied",
            semanticSnapshotHash: approval.semanticSnapshotHash
        )
        do {
            let challenge = try await issueConfirmChallenge()
            _ = try await gatewayCall("approval.respond", risk: approval.finalRisk, command: true, payload, nonce: challenge, confirm: confirm, reason: reason)
            return .recorded(status: payload.decision)
        } catch let DeviceAPIError.server(status, _, _, _) where status == 409 {
            return .changed
        }
    }
}
