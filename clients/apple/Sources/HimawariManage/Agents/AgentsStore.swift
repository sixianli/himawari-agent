import Foundation
import Observation

public enum AgentReadCeiling: String, Codable, Sendable, CaseIterable, Identifiable {
    case `public`
    case `private`
    case sensitive

    public var id: String { rawValue }
}

public enum AgentPushPolicy: String, Codable, Sendable, CaseIterable, Identifiable {
    case ask
    case direct

    public var id: String { rawValue }
}

public enum AgentStatus: String, Codable, Sendable {
    case active
    case paused
    case revoked
}

public struct ConnectedAgent: Decodable, Sendable, Equatable, Identifiable {
    public struct Usage: Decodable, Sendable, Equatable {
        public let reads: Int
        public let memoryPushes: Int
        public let ruleProposals: Int
    }

    public let id: String
    public let name: String
    public let readCeiling: AgentReadCeiling
    public let pushPolicy: AgentPushPolicy
    public let status: AgentStatus
    public let clientHost: String?
    public let lastSeenAt: String?
    public let createdAt: String
    public let usage: Usage
}

public struct AgentGrant: Decodable, Sendable, Equatable, Identifiable {
    public struct Existing: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let readCeiling: AgentReadCeiling
        public let pushPolicy: AgentPushPolicy
    }

    public let id: String
    public let clientName: String
    public let clientHost: String
    public let redirectHost: String
    public let localRedirect: Bool
    public let wantsWrite: Bool
    public let existingConnection: Existing?
    public let expiresAt: String
}

public struct AgentGrantChoice: Sendable, Equatable {
    public var name: String
    public var readCeiling: AgentReadCeiling
    public var pushPolicy: AgentPushPolicy
    public var write: Bool
}

@MainActor
@Observable
public final class AgentsStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case unavailable
    }

    static let nameCharacters = 64

    public private(set) var phase: Phase = .loading
    public private(set) var agents: [ConnectedAgent] = []
    public private(set) var grants: [AgentGrant] = []
    public private(set) var defaults = AgentGrantDefaults(readCeiling: .private, pushPolicy: .ask)
    public private(set) var working = false

    @ObservationIgnored private let gateway: ManageGateway?

    public init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    init(agents: [ConnectedAgent]?, grants: [AgentGrant] = []) {
        gateway = nil
        self.agents = agents ?? []
        self.grants = grants
        phase = agents == nil ? .unavailable : .loaded
    }

    public var shown: [ConnectedAgent] { agents.filter { $0.status != .revoked } }

    public var available: Bool { phase == .loaded && !shown.isEmpty }

    public func agent(_ id: String) -> ConnectedAgent? {
        agents.first { $0.id == id }
    }

    public func load() async {
        guard let gateway else { return }
        struct Snapshot: Decodable {
            struct Payload: Decodable { let connections: [ConnectedAgent] }
            let payload: Payload
        }
        do {
            agents = try JSONDecoder().decode(Snapshot.self, from: try await gateway.read(.v2, "mcp.connections.read")).payload.connections
            phase = .loaded
        } catch {
            if phase != .loaded { phase = .unavailable }
        }
    }

    public func loadGrants() async {
        guard let gateway else { return }
        struct Snapshot: Decodable {
            struct Payload: Decodable {
                let grants: [AgentGrant]
                let defaults: AgentGrantDefaults
            }
            let payload: Payload
        }
        do {
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: try await gateway.read(.v2, "mcp.grants.read"))
            grants = snapshot.payload.grants
            defaults = snapshot.payload.defaults
        } catch {
            return
        }
    }

    public func choice(for grant: AgentGrant) -> AgentGrantChoice {
        AgentGrantChoice(
            name: String((grant.existingConnection?.name ?? grant.clientName).prefix(Self.nameCharacters)),
            readCeiling: grant.existingConnection?.readCeiling ?? defaults.readCeiling,
            pushPolicy: grant.existingConnection?.pushPolicy ?? defaults.pushPolicy,
            write: grant.wantsWrite
        )
    }

    public func approve(_ grant: AgentGrant, _ choice: AgentGrantChoice) async throws {
        guard let gateway else { return }
        working = true
        defer { working = false }
        let name = choice.name.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await gateway.command(
            .v2,
            "mcp.grant.approve",
            payload: [
                "grantId": .string(grant.id),
                "name": name.isEmpty ? .null : .string(name),
                "readCeiling": .string(choice.readCeiling.rawValue),
                "pushPolicy": .string(choice.pushPolicy.rawValue),
                "write": .bool(choice.write),
            ],
            options: ManageCommandOptions(confirmReason: M.agentApproveReason(name.isEmpty ? grant.clientName : name))
        )
        grants.removeAll { $0.id == grant.id }
        await load()
    }

    public func deny(_ grant: AgentGrant) async throws {
        guard let gateway else { return }
        working = true
        defer { working = false }
        _ = try await gateway.command(
            .v2,
            "mcp.grant.deny",
            payload: ["grantId": .string(grant.id)],
            options: ManageCommandOptions(confirmReason: M.agentDenyReason(grant.clientName))
        )
        grants.removeAll { $0.id == grant.id }
    }

    public func change(
        _ agent: ConnectedAgent,
        readCeiling: AgentReadCeiling? = nil,
        pushPolicy: AgentPushPolicy? = nil,
        status: AgentStatus? = nil
    ) async throws {
        guard let gateway else { return }
        working = true
        defer { working = false }
        _ = try await gateway.command(
            .v2,
            "mcp.connection.change",
            payload: [
                "connectionId": .string(agent.id),
                "name": .null,
                "capabilities": .null,
                "readCeiling": readCeiling.map { JSONValue.string($0.rawValue) } ?? .null,
                "pushPolicy": pushPolicy.map { JSONValue.string($0.rawValue) } ?? .null,
                "status": status.map { JSONValue.string($0.rawValue) } ?? .null,
            ],
            options: ManageCommandOptions(confirmReason: M.agentChangeReason(agent.name))
        )
        await load()
    }
}

public struct AgentGrantDefaults: Decodable, Sendable, Equatable {
    public let readCeiling: AgentReadCeiling
    public let pushPolicy: AgentPushPolicy
}
