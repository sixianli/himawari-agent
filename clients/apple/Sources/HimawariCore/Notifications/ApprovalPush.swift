import Foundation

public struct HimawariPush: Sendable, Equatable {
    public static let actionsCategory = "himawari.actions"
    public static let plainCategory = "himawari.plain"
    public static let approvalKind = "approval"
    public static let agentGrantKind = "mcp_grant"
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

    public init?(userInfo: [AnyHashable: Any]) {
        guard let body = userInfo["himawari"] as? [String: Any],
              body["v"] as? Int == Self.version,
              let kind = body["kind"] as? String
        else { return nil }
        self.kind = kind
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
