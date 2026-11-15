import Foundation

public struct DeliveredNotification: Sendable, Equatable {
    public let requestIdentifier: String
    public let notificationId: String?

    public init(requestIdentifier: String, notificationId: String?) {
        self.requestIdentifier = requestIdentifier
        self.notificationId = notificationId
    }
}

public protocol DeliveredNotificationCenter: Sendable {
    func delivered() async -> [DeliveredNotification]
    func remove(requestIdentifiers: [String]) async
}

public protocol NotificationSettlementSource: Sendable {
    func settledNotifications(ids: [String]) async throws -> [String]
}

extension DeviceAPI: NotificationSettlementSource {
    public func settledNotifications(ids: [String]) async throws -> [String] {
        struct Body: Encodable { let ids: [String] }
        struct Reply: Decodable { let settledIds: [String] }
        let data = try await http.send(DeviceRequest(method: "POST", path: "notifications/settled", body: try JSONEncoder().encode(Body(ids: ids))))
        return try decode(Reply.self, data).settledIds
    }
}

public enum SilentWithdrawPush {
    public static let idKey = "notificationId"

    public static func notificationId(in userInfo: [AnyHashable: Any]) -> String? {
        guard let aps = userInfo["aps"] as? [AnyHashable: Any], aps["alert"] == nil else { return nil }
        guard let flag = aps["content-available"] as? Int, flag == 1 else { return nil }
        guard let id = userInfo[idKey] as? String, !id.isEmpty else { return nil }
        return id
    }
}

public struct NotificationSettler: Sendable {
    public static let maxIdsPerCheck = 200
    public static let maxIdLength = 64

    static func isCheckable(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= maxIdLength && id.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (scalar.properties.isAlphabetic || ("0" ... "9").contains(Character(scalar)) || scalar == "_" || scalar == "-")
        }
    }

    private let center: any DeliveredNotificationCenter
    private let source: (any NotificationSettlementSource)?

    public init(center: any DeliveredNotificationCenter, source: (any NotificationSettlementSource)? = nil) {
        self.center = center
        self.source = source
    }

    public func withdraw(notificationId: String) async {
        let matching = await center.delivered().filter { $0.notificationId == notificationId }.map(\.requestIdentifier)
        guard !matching.isEmpty else { return }
        await center.remove(requestIdentifiers: matching)
    }

    @discardableResult
    public func reconcile() async -> Int {
        guard let source else { return 0 }
        let delivered = await center.delivered()
        var seen = Set<String>()
        let ids = delivered.compactMap(\.notificationId).filter { Self.isCheckable($0) && seen.insert($0).inserted }
        var removed = 0
        var start = 0
        while start < ids.count {
            let chunk = Array(ids[start ..< min(start + Self.maxIdsPerCheck, ids.count)])
            start += Self.maxIdsPerCheck
            guard let settled = try? await source.settledNotifications(ids: chunk) else { return removed }
            let settledSet = Set(settled).intersection(chunk)
            let requests = delivered.filter { $0.notificationId.map(settledSet.contains) == true }.map(\.requestIdentifier)
            guard !requests.isEmpty else { continue }
            await center.remove(requestIdentifiers: requests)
            removed += requests.count
        }
        return removed
    }
}

#if canImport(UserNotifications)
import UserNotifications

public struct SystemDeliveredNotifications: DeliveredNotificationCenter {
    public init() {}

    public func delivered() async -> [DeliveredNotification] {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                continuation.resume(returning: notifications.map { notification in
                    DeliveredNotification(
                        requestIdentifier: notification.request.identifier,
                        notificationId: notification.request.content.userInfo[SilentWithdrawPush.idKey] as? String
                    )
                })
            }
        }
    }

    public func remove(requestIdentifiers: [String]) async {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: requestIdentifiers)
    }
}
#endif
