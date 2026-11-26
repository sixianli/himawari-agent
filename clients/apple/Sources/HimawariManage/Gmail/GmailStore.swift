import Foundation
import Observation

public struct GmailOverview: Decodable, Sendable, Equatable {
    public struct Connection: Decodable, Sendable, Equatable {
        public let status: String
        public let account: String?
        public let connectedAt: String?
    }

    public struct Check: Decodable, Sendable, Equatable {
        public let checkedAt: String
        public let verdict: String
    }

    public let source: String
    public let connection: Connection
    public let dailyLimitReached: Bool
    public let decisions: [Check]
}

public enum GmailConnectOutcome: Equatable, Sendable {
    case connected
    case denied
    case failed
    case cancelled
}

@MainActor
@Observable
public final class GmailStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case unavailable
    }

    public enum Status: Equatable {
        case disconnected
        case connected(account: String?, since: Date?, lastRead: Date?)
        case needsReconnect(unreadSince: Date?)
    }

    public static let source = "gmail"
    static let startPath = "connections/authorization"
    static let completePath = "connections/authorization/complete"
    static let callbackHost = "gmail-authorization"
    private static let notReadVerdicts: Set<String> = ["needs_owner", "failed"]

    public private(set) var phase: Phase = .loading
    public private(set) var overview: GmailOverview?
    public private(set) var connecting = false

    @ObservationIgnored private let gateway: ManageGateway
    @ObservationIgnored private let callbackScheme: String?

    public init(gateway: ManageGateway, callbackScheme: String? = GmailStore.appCallbackScheme) {
        self.gateway = gateway
        self.callbackScheme = callbackScheme
    }

    init(overview: GmailOverview?) {
        gateway = ManageGateway(transport: UnreachableTransport())
        callbackScheme = nil
        self.overview = overview
        phase = overview == nil ? .unavailable : .loaded
    }

    public static var appCallbackScheme: String? {
        Bundle.main.bundleIdentifier?.lowercased()
    }

    public var available: Bool { phase == .loaded && overview != nil }

    public var status: Status? {
        guard let overview else { return nil }
        switch overview.connection.status {
        case "connected":
            return .connected(
                account: overview.connection.account,
                since: overview.connection.connectedAt.flatMap(Timestamp.parse),
                lastRead: overview.decisions.first { !Self.notReadVerdicts.contains($0.verdict) }.flatMap { Timestamp.parse($0.checkedAt) }
            )
        case "needs_reconnect":
            let unread = overview.decisions.prefix { $0.verdict == "needs_owner" }.last
            return .needsReconnect(unreadSince: unread.flatMap { Timestamp.parse($0.checkedAt) })
        default:
            return .disconnected
        }
    }

    public func load() async {
        do {
            let data = try await gateway.read(.v2, "proactive.overview.read")
            let loaded = try JSONDecoder().decode(Snapshot<GmailOverview>.self, from: data).payload
            guard loaded.source == Self.source else {
                overview = nil
                phase = .unavailable
                return
            }
            overview = loaded
            phase = .loaded
        } catch {
            if overview == nil { phase = .unavailable }
        }
    }

    public func connect(signIn: @MainActor (URL, String) async throws -> URL?) async -> GmailConnectOutcome {
        guard let callbackScheme, !connecting else { return .failed }
        connecting = true
        defer { connecting = false }
        let outcome = await run(callbackScheme: callbackScheme, signIn: signIn)
        await load()
        return outcome
    }

    public func disconnect(reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "proactive.source.manage",
            payload: ["source": .string(Self.source), "action": .string("disconnect")],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await load()
    }

    private func run(callbackScheme: String, signIn: @MainActor (URL, String) async throws -> URL?) async -> GmailConnectOutcome {
        struct Started: Decodable {
            let kind: String
            let authorizationUrl: String?
        }
        struct Finished: Decodable {
            let outcome: String
        }
        do {
            let startedData = try await gateway.post(Self.startPath, body: ["connection": .string(Self.source), "callbackScheme": .string(callbackScheme)])
            let started = try JSONDecoder().decode(Started.self, from: startedData)
            guard started.kind == "browser", let page = started.authorizationUrl.flatMap(URL.init(string:)) else { return .failed }
            guard let returned = try await signIn(page, callbackScheme) else { return .cancelled }
            guard let state = Self.state(in: returned, scheme: callbackScheme) else { return .failed }
            let finishedData = try await gateway.post(Self.completePath, body: ["state": .string(state)])
            switch try JSONDecoder().decode(Finished.self, from: finishedData).outcome {
            case "connected": return .connected
            case "denied": return .denied
            default: return .failed
            }
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failed
        }
    }

    static func state(in url: URL, scheme: String) -> String? {
        guard url.scheme?.lowercased() == scheme, url.host() == callbackHost,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "state" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }
}

private struct UnreachableTransport: DeviceTransport {
    func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        throw CancellationError()
    }
}
