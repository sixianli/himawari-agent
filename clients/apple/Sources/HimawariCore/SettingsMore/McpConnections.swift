import Foundation

public struct McpToolReads: Decodable, Sendable, Equatable {
    public let tool: String
    public let calls: Int
}

public struct McpUsage: Decodable, Sendable, Equatable {
    public let reads: Int
    public let readsByTool: [McpToolReads]
    public let delivered: Int
    public let empty: Int
    public let failed: Int
    public let rateLimited: Int
}

public struct McpConnection: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let capabilities: [String]
    public let readCeiling: String
    public let pushPolicy: String
    public let status: String
    public let reportedClient: String?
    public let lastSeenAt: String?
    public let usage: McpUsage

    public var isRevoked: Bool { status == "revoked" }
    public var isPaused: Bool { status == "paused" }

    public func renamed(_ draft: String) -> McpConnectionChange? {
        let trimmed = McpConnections.clampedName(draft.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !trimmed.isEmpty, trimmed != name, !isRevoked else { return nil }
        return McpConnectionChange(connectionId: id, name: trimmed, readCeiling: nil, status: nil)
    }

    public func ceiling(_ next: String) -> McpConnectionChange? {
        guard next != readCeiling, !isRevoked else { return nil }
        return McpConnectionChange(connectionId: id, name: nil, readCeiling: next, status: nil)
    }

    public func moving(to next: String) -> McpConnectionChange? {
        guard next != status, !isRevoked else { return nil }
        return McpConnectionChange(connectionId: id, name: nil, readCeiling: nil, status: next)
    }
}

public struct McpWindow: Decodable, Sendable, Equatable {
    public let fromDay: String
    public let toDay: String
    public let days: Int
}

public struct McpLimit: Decodable, Sendable, Equatable {
    public let key: String
    public let value: Int
    public let used: Int?
}

public struct McpConnections: Decodable, Sendable, Equatable {
    public let connections: [McpConnection]
    public let window: McpWindow
    public let limits: [McpLimit]

    public static let nameCharacters = 64
    public static let ceilings = ["public", "private", "sensitive"]
    public static let paused = "paused"
    public static let active = "active"
    public static let revoked = "revoked"

    public static func clampedName(_ text: String) -> String {
        String(text.prefix(nameCharacters))
    }

    public var live: [McpConnection] { connections.filter { !$0.isRevoked } }
    public var gone: [McpConnection] { connections.filter(\.isRevoked) }
    public var ordered: [McpConnection] { live + gone }

    public func connection(_ id: String) -> McpConnection? {
        connections.first { $0.id == id }
    }
}

public struct McpConnectionChange: Encodable, Sendable, Equatable {
    public let connectionId: String
    public let name: String?
    public let readCeiling: String?
    public let status: String?

    public init(connectionId: String, name: String?, readCeiling: String?, status: String?) {
        self.connectionId = connectionId
        self.name = name
        self.readCeiling = readCeiling
        self.status = status
    }

    private enum CodingKeys: String, CodingKey {
        case connectionId, name, capabilities, readCeiling, pushPolicy, status
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(connectionId, forKey: .connectionId)
        try container.encode(name, forKey: .name)
        try container.encode(String?.none, forKey: .capabilities)
        try container.encode(readCeiling, forKey: .readCeiling)
        try container.encode(String?.none, forKey: .pushPolicy)
        try container.encode(status, forKey: .status)
    }
}
