import Foundation
import Observation

public struct AppConnection: Decodable, Sendable, Equatable, Identifiable {
    public let name: String
    public let title: String
    public let status: String
    public let account: String?
    public let connectedAt: String?
    public let added: Bool

    public var id: String { name }

    public init(name: String, title: String, status: String, account: String?, connectedAt: String?, added: Bool = false) {
        self.name = name
        self.title = title
        self.status = status
        self.account = account
        self.connectedAt = connectedAt
        self.added = added
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        title = try container.decode(String.self, forKey: .title)
        status = try container.decode(String.self, forKey: .status)
        account = try container.decodeIfPresent(String.self, forKey: .account)
        connectedAt = try container.decodeIfPresent(String.self, forKey: .connectedAt)
        added = try container.decodeIfPresent(Bool.self, forKey: .added) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case name, title, status, account, connectedAt, added
    }
}

public struct NewAppConnection: Equatable, Sendable {
    public var serverUrl: String
    public var title: String
    public var clientId: String
    public var clientSecret: String

    public init(serverUrl: String = "", title: String = "", clientId: String = "", clientSecret secret: String = "") {
        self.serverUrl = serverUrl
        self.title = title
        self.clientId = clientId
        self.clientSecret = secret
    }

    var body: JSONValue {
        var fields: [String: JSONValue] = ["serverUrl": .string(serverUrl.trimmingCharacters(in: .whitespacesAndNewlines))]
        for (key, value) in [("title", title), ("clientId", clientId), ("clientSecret", clientSecret)] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { fields[key] = .string(trimmed) }
        }
        return .object(fields)
    }

    public var ready: Bool {
        !serverUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}

public enum AddConnectionOutcome: Equatable, Sendable {
    case added(AppConnection)
    case invalidAddress
    case unreachable
    case failed
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
    static let addPath = "connections/add"
    static let removePath = "connections/remove"
    static let callbackHost = "connection-authorization"

    public private(set) var phase: Phase = .loading
    public private(set) var connections: [AppConnection] = []
    public private(set) var connecting: String?
    public private(set) var adding = false

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

    public func add(_ app: NewAppConnection, reason: String) async -> AddConnectionOutcome {
        guard let gateway, app.ready, !adding else { return .failed }
        adding = true
        defer { adding = false }
        struct Added: Decodable {
            let outcome: String
            let connection: AppConnection?
        }
        do {
            let data = try await gateway.confirmedPost(Self.addPath, body: app.body, reason: reason)
            let answer = try JSONDecoder().decode(Added.self, from: data)
            await load()
            switch answer.outcome {
            case "added": return answer.connection.map(AddConnectionOutcome.added) ?? .failed
            case "invalid_address": return .invalidAddress
            case "unreachable": return .unreachable
            default: return .failed
            }
        } catch ManageGatewayError.rejected(status: 400, code: _, reason: _) {
            return .invalidAddress
        } catch {
            return .failed
        }
    }

    public func remove(_ name: String) async throws {
        guard let gateway else { return }
        _ = try await gateway.post(Self.removePath, body: ["connection": .string(name)])
        await load()
    }
}
