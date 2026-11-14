import Foundation

struct CollectionPage: Decodable {
    let itemRefs: [String]
    let nextCursor: String?
}

public struct CapabilitySummary: Decodable, Sendable, Identifiable, Hashable {
    public let capabilityRef: String
    public let displayName: String
    public let lifecycle: String
    public let revision: Int
    public let updateAssessment: UpdateAssessment?

    public struct UpdateAssessment: Decodable, Sendable, Hashable {
        public let expansions: [String]
    }

    public var id: String { capabilityRef }
}

public enum CapabilityStanding: Sendable, Equatable {
    case waitingForYou
    case inUse
    case disabled

    static func of(_ lifecycle: String) -> CapabilityStanding? {
        switch lifecycle {
        case "review_required", "installation_proposed", "update_proposed": .waitingForYou
        case "active": .inUse
        case "disabled": .disabled
        default: nil
        }
    }
}
