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

    public func approvals(status: ApprovalStatus) async throws -> [PendingApproval] {
        struct Body: Decodable { let approvals: [PendingApproval] }
        let data = try await http.send(DeviceRequest(method: "GET", path: "approvals", query: [URLQueryItem(name: "status", value: status.rawValue)]))
        return try decode(Body.self, data).approvals
    }

    public func respond(to approval: PendingApproval, approved: Bool, confirm: DeviceKeySigner?, reason: String?) async throws -> ApprovalResponse {
        struct Body: Encodable {
            let expectedRevision: Int
            let decision: String
            let semanticSnapshotHash: String
        }
        let body = try JSONEncoder().encode(Body(
            expectedRevision: approval.revision,
            decision: approved ? "approved" : "denied",
            semanticSnapshotHash: approval.semanticSnapshotHash
        ))
        let signer = approved && approval.recentAuthenticationRequired ? confirm : nil
        do {
            let challenge = signer == nil ? nil : try await issueConfirmChallenge()
            let data = try await http.send(DeviceRequest(
                method: "POST",
                path: "approvals/\(approval.id)/respond",
                body: body,
                nonce: challenge,
                confirmSigner: signer,
                confirmReason: signer == nil ? nil : reason
            ))
            struct Reply: Decodable { let status: String }
            return .recorded(status: try decode(Reply.self, data).status)
        } catch let DeviceAPIError.server(status, _, _, _) where status == 409 {
            return .changed
        }
    }
}
