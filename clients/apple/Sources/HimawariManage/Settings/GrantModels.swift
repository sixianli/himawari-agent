import Foundation

struct LocalizedLines: Decodable, Sendable, Hashable {
    let lines: [String]

    init(from decoder: Decoder) throws {
        let table = try decoder.singleValueContainer().decode([String: [String]].self)
        lines = table[ManageLanguage.current.serverTag] ?? table["en"] ?? []
    }
}

public struct GrantSummary: Decodable, Sendable, Identifiable, Hashable {
    public let grantId: String
    public let revision: Int
    public let status: String
    public let capabilityRef: String
    public let validFrom: String
    public let expiresAt: String
    public let uses: Int
    public let affectedTaskRefs: [String]
    public let label: String?
    let detail: LocalizedLines

    public var id: String { grantId }
    public var detailLines: [String] { detail.lines }
    public var isActive: Bool { status == "active" }
    public var grantedAt: Date? { Timestamp.parse(validFrom) }
    public var endsAt: Date? { Timestamp.parse(expiresAt) }
}

public enum GrantRevokeOutcome: Sendable, Equatable {
    case revoked(affectedTasks: Int)
    case gone
}
