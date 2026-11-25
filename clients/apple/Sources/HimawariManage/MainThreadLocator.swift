import Foundation
import HimawariCore

public struct MainThreadLocator: Sendable {
    private struct Payload: Decodable {
        struct Thread: Decodable {
            let threadId: String
        }

        let thread: Thread
    }

    private let gateway: ManageGateway

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
    }

    init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func mainThreadId() async throws -> String {
        let data = try await gateway.read(.threadV3, "thread.main")
        return try JSONDecoder().decode(Snapshot<Payload>.self, from: data).payload.thread.threadId
    }
}
