import Foundation
import Observation

public struct AppConnection: Decodable, Sendable, Equatable, Identifiable {
    public let name: String
    public let title: String
    public let status: String
    public let account: String?
    public let connectedAt: String?

    public var id: String { name }
}

@MainActor
@Observable
public final class ConnectionsStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case unavailable
    }

    static let listPath = "connections/list"
    static let pagesInThisApp: Set<String> = [GmailStore.source]

    public private(set) var phase: Phase = .loading
    public private(set) var connections: [AppConnection] = []

    @ObservationIgnored private let gateway: ManageGateway?

    public init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    init(connections: [AppConnection]?) {
        gateway = nil
        self.connections = connections ?? []
        phase = connections == nil ? .unavailable : .loaded
    }

    public var shown: [AppConnection] {
        connections.filter { Self.pagesInThisApp.contains($0.name) }
    }

    public var available: Bool { phase == .loaded && !shown.isEmpty }

    public var connectedTitles: [String] {
        shown.filter { $0.status == "connected" }.map(\.title)
    }

    public var needsReconnect: Bool {
        shown.contains { $0.status == "needs_reconnect" }
    }

    public func load() async {
        guard let gateway else { return }
        struct Listed: Decodable {
            let connections: [AppConnection]
        }
        do {
            let data = try await gateway.post(Self.listPath, body: [:])
            connections = try JSONDecoder().decode(Listed.self, from: data).connections
            phase = .loaded
        } catch {
            if phase != .loaded { phase = .unavailable }
        }
    }
}
