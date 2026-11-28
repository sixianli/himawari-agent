import Foundation

public struct HimawariPush: Sendable, Equatable {
    public static let actionsCategory = "himawari.actions"
    public static let plainCategory = "himawari.plain"
    public static let approvalKind = "approval"
    public static let agentGrantKind = "mcp_grant"
    public static let vaultApprovalKind = "vault_approval"
    public static let vaultCodeKind = "vault_code"
    public static let vaultCodeCategory = "himawari.vault-code"
    public static let vaultCodeAction = "himawari.vault-code.enter"
    static let version = 1

    public enum ActionKind: String, Sendable, Equatable, CaseIterable {
        case approve
        case deny
    }

    public struct Action: Sendable, Equatable {
        public let action: ActionKind
        public let label: String
        let token: String
        public let ownerPresence: Bool
    }

    public let kind: String
    public let actions: [Action]
    public let vaultRequestId: String?
    public let vaultCodeRequestId: String?

    public init?(userInfo: [AnyHashable: Any]) {
        guard let body = userInfo["himawari"] as? [String: Any],
              body["v"] as? Int == Self.version,
              let kind = body["kind"] as? String
        else { return nil }
        self.kind = kind
        vaultRequestId = body["vaultRequestId"] as? String
        vaultCodeRequestId = body["vaultCodeRequestId"] as? String
        actions = (body["actions"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let raw = entry["action"] as? String, let action = ActionKind(rawValue: raw),
                  let label = entry["label"] as? String, let token = entry["token"] as? String
            else { return nil }
            return Action(action: action, label: label, token: token, ownerPresence: entry["ownerPresence"] as? Bool ?? true)
        }
    }

    public func action(_ kind: ActionKind) -> Action? {
        actions.first { $0.action == kind }
    }
}

public protocol ApprovalPushTransport: Sendable {
    func respondToApproval(token: String) async throws
}

extension DeviceAPI: ApprovalPushTransport {
    public func respondToApproval(token: String) async throws {
        _ = try await http.send(DeviceRequest(method: "POST", path: "approvals/respond", body: try JSONEncoder().encode(["token": token])))
    }
}

public struct ApprovalPushReply: Sendable {
    public enum Outcome: Sendable, Equatable {
        case sent
        case openApp
    }

    private let transport: any ApprovalPushTransport

    public init(transport: any ApprovalPushTransport) {
        self.transport = transport
    }

    public func tap(_ kind: HimawariPush.ActionKind, in push: HimawariPush) async throws -> Outcome {
        guard let action = push.action(kind), !action.ownerPresence else { return .openApp }
        try await transport.respondToApproval(token: action.token)
        return .sent
    }
}

public struct VaultCodePushReply: Sendable {
    public enum Outcome: Sendable, Equatable {
        case sent
        case openApp
    }

    private let transport: any VaultCodeTransport

    public init(transport: any VaultCodeTransport) {
        self.transport = transport
    }

    public func typed(_ text: String, in push: HimawariPush) async -> Outcome {
        guard push.kind == HimawariPush.vaultCodeKind, let requestId = push.vaultCodeRequestId, let code = VaultCode.cleaned(text) else { return .openApp }
        guard let outcome = try? await transport.answerVaultCode(requestId: requestId, code: code) else { return .openApp }
        return outcome == .recorded ? .sent : .openApp
    }
}
