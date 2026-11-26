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
    static let disconnectPath = "connections/disconnect"
    static let callbackHost = "connection-authorization"

    public private(set) var phase: Phase = .loading
    public private(set) var connections: [AppConnection] = []
    public private(set) var connecting: String?

    @ObservationIgnored private let gateway: ManageGateway?
    @ObservationIgnored private let callbackScheme: String?

    public init(gateway: ManageGateway, callbackScheme: String? = GmailStore.appCallbackScheme) {
        self.gateway = gateway
        self.callbackScheme = callbackScheme
    }

    init(connections: [AppConnection]?) {
        gateway = nil
        callbackScheme = nil
        self.connections = connections ?? []
        phase = connections == nil ? .unavailable : .loaded
    }

    public var shown: [AppConnection] { connections }

    public func connection(named name: String) -> AppConnection? {
        connections.first { $0.name == name }
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

    public func connect(_ name: String, signIn: @MainActor (URL, String) async throws -> URL?) async -> ConnectionOutcome {
        guard let gateway, let callbackScheme, connecting == nil else { return .failed }
        connecting = name
        defer { connecting = nil }
        let outcome = await ConnectionAuthorization.run(
            gateway: gateway,
            connection: name,
            callbackScheme: callbackScheme,
            callbackHost: Self.callbackHost,
            signIn: signIn
        )
        await load()
        return outcome
    }

    public func disconnect(_ name: String) async throws {
        guard let gateway else { return }
        _ = try await gateway.post(Self.disconnectPath, body: ["connection": .string(name)])
        await load()
    }
}
