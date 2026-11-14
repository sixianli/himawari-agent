import Foundation

struct CollectionPage: Decodable {
    let itemRefs: [String]
    let nextCursor: String?
}

public struct CapabilitySummary: Decodable, Sendable, Identifiable, Hashable {
    public let capabilityRef: String
    public let displayName: String
    public let lifecycle: String

    public var id: String { capabilityRef }
}

public enum CapabilityStanding: Sendable, Equatable {
    case waitingForYou
    case inUse

    static func of(_ lifecycle: String) -> CapabilityStanding? {
        switch lifecycle {
        case "review_required", "installation_proposed", "update_proposed": .waitingForYou
        case "active": .inUse
        default: nil
        }
    }
}
