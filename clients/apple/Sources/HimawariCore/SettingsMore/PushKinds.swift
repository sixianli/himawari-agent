import Foundation

public struct PushSubscriptionSummary: Decodable, Sendable, Equatable, Identifiable {
    public let subscriptionId: String
    public let deviceLabel: String
    public let state: String
    public let lastDeliveredAt: String?

    public var id: String { subscriptionId }
}

public struct PushStatus: Decodable, Sendable, Equatable {
    public let available: Bool
    public let kinds: [String]
    public let subscriptions: [PushSubscriptionSummary]

    public static let knownKinds = ["reminder", "approval", "run"]

    public var listedKinds: [String] {
        Self.knownKinds + kinds.filter { !Self.knownKinds.contains($0) }
    }

    public func isOn(_ kind: String) -> Bool { kinds.contains(kind) }

    public var activeDeviceCount: Int { subscriptions.filter { $0.state == "active" }.count }

    public func setting(_ kind: String, enabled: Bool) -> PushKindChange? {
        Self.knownKinds.contains(kind) && isOn(kind) != enabled ? PushKindChange(kind: kind, enabled: enabled) : nil
    }
}

public struct PushKindChange: Encodable, Sendable, Equatable {
    public let kind: String
    public let enabled: Bool
}
