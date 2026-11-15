import Foundation
import HimawariChat
import HimawariCore

actor DeviceHomeSource: HomeFeedSource {
    private let api: DeviceAPI
    private let confirmKey: any DeviceKeySigner
    private var requestIds: [String: String] = [:]

    init(api: DeviceAPI, confirmKey: any DeviceKeySigner) {
        self.api = api
        self.confirmKey = confirmKey
    }

    func read(locale: HomeLocale) async throws -> HomeFeedSnapshot {
        try await api.homeFeed(locale: locale)
    }

    func act(_ item: HomeFeedItem, action: HomeFeedAction, revision: String) async throws -> HomeActOutcome {
        let key = [item.key, action.action, action.binding ?? ""].joined(separator: "\n")
        let requestId = requestIds[key] ?? HomeRequestId.make()
        requestIds[key] = requestId
        let presence = action.ownerPresence ? OwnerPresenceSigner(key: confirmKey, reason: L.text("today.presenceReason")) : nil
        do {
            try await api.act(on: item, action: action, requestId: requestId, presence: presence)
            requestIds[key] = nil
        } catch OwnerPresenceError.declined {
            requestIds[key] = nil
            throw OwnerPresenceError.declined
        } catch let error as DeviceAPIError {
            if case let .server(status, _, _, _) = error, (400 ..< 500).contains(status) { requestIds[key] = nil }
            throw error
        }
        return HomeActOutcome(message: nil, undo: nil)
    }
}
