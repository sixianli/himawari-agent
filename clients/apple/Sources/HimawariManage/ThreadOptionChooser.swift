import Foundation
import HimawariCore

public struct ThreadOptionChooser: Sendable {
    private let gateway: ManageGateway

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
    }

    init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func choose(threadId: String, messageId: String, setId: String, optionId: String) async throws {
        _ = try await gateway.command(
            .threadV3,
            "thread.option.choose",
            payload: [
                "threadId": .string(threadId),
                "messageId": .string(messageId),
                "setId": .string(setId),
                "optionId": .string(optionId),
            ],
            options: ManageCommandOptions(confirmReason: M.chooseOption)
        )
    }
}
