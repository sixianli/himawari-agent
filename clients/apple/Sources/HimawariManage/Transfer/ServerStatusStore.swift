import Foundation
import Observation

public struct ServerStatus: Decodable, Sendable, Equatable {
    public struct Dependency: Decodable, Sendable, Equatable {
        public let name: String
        public let required: Bool
        public let status: String
        public let reasonCode: String?
    }

    public struct Release: Decodable, Sendable, Equatable {
        public let commit: String
        public let installedAt: String?
    }

    public struct Disk: Decodable, Sendable, Equatable {
        public let availableBytes: Int64
        public let totalBytes: Int64
    }

    public let live: Bool
    public let ready: Bool
    public let status: String
    public let dependencies: [Dependency]
    public let release: Release?
    public let disk: Disk?
    public let generatedAt: String

    public var worker: Dependency? { dependencies.first { $0.name == "worker" } }
}

@MainActor
@Observable
public final class ServerStatusStore {
    public enum Phase: Equatable {
        case loading
        case loaded(ServerStatus)
        case failed
    }

    public private(set) var phase: Phase = .loading

    @ObservationIgnored private let gateway: ManageGateway

    public init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    init(status: ServerStatus?) {
        gateway = ManageGateway(transport: NoTransport())
        phase = status.map(Phase.loaded) ?? .failed
    }

    public func load() async {
        do {
            let data = try await gateway.read(.v2, "server.status.read")
            phase = .loaded(try JSONDecoder().decode(Snapshot<ServerStatus>.self, from: data).payload)
        } catch {
            phase = .failed
        }
    }
}

struct NoTransport: DeviceTransport {
    func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        DeviceResponse(status: 503, body: Data())
    }
}
