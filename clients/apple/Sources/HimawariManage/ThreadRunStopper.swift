import Foundation
import HimawariCore

public struct ThreadRunStopper: Sendable {
    private let gateway: ManageGateway

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
    }

    init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func stop(threadId: String, run: ThreadRunSummary) async throws {
        let resultRef = try await gateway.uploadText("thread-action:stop")
        _ = try await gateway.command(
            .threadV3,
            "thread.run.cancel",
            payload: [
                "threadId": .string(threadId),
                "runId": .string(run.runId),
                "expectedRunRevision": .number(Double(run.revision)),
                "resultRef": .string(resultRef),
            ],
            options: ManageCommandOptions(confirmReason: M.stopRun)
        )
    }
}
