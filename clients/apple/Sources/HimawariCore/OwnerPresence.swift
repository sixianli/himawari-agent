import Foundation

public struct DeviceNotification: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let title: String
    public let body: String
    public let homeKey: String?
    public let createdAt: String

    public init(id: String, kind: String, title: String, body: String, homeKey: String?, createdAt: String) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.homeKey = homeKey
        self.createdAt = createdAt
    }
}

public struct PendingNotifications: Sendable, Equatable {
    public private(set) var items: [DeviceNotification] = []

    public init() {}

    @discardableResult
    public mutating func deliver(_ notification: DeviceNotification) -> Bool {
        if let index = items.firstIndex(where: { $0.id == notification.id }) {
            guard items[index] != notification else { return false }
            items[index] = notification
        } else {
            items.append(notification)
        }
        items.sort { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
        return true
    }

    @discardableResult
    public mutating func withdraw(_ id: String) -> DeviceNotification? {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        return items.remove(at: index)
    }
}

public struct PresenceReportPolicy: Sendable, Equatable {
    public let minimumInterval: TimeInterval
    public let keepAliveInterval: TimeInterval

    public static let standard = PresenceReportPolicy(minimumInterval: 60, keepAliveInterval: 240)

    public init(minimumInterval: TimeInterval, keepAliveInterval: TimeInterval) {
        self.minimumInterval = minimumInterval
        self.keepAliveInterval = keepAliveInterval
    }

    public func shouldReport(lastInputAt: Date, now: Date, lastReport: PresenceReport?, streamConnected: Bool) -> Bool {
        guard let lastReport else { return true }
        let elapsed = now.timeIntervalSince(lastReport.sentAt)
        if elapsed < minimumInterval { return false }
        if PresenceReport.wholeSeconds(lastInputAt) != lastReport.lastInputAt { return true }
        return streamConnected && elapsed >= keepAliveInterval
    }
}

public struct PresenceReport: Sendable, Equatable {
    public let lastInputAt: Date
    public let sentAt: Date

    public init(lastInputAt: Date, sentAt: Date) {
        self.lastInputAt = Self.wholeSeconds(lastInputAt)
        self.sentAt = sentAt
    }

    public static func wholeSeconds(_ date: Date) -> Date {
        Date(timeIntervalSince1970: date.timeIntervalSince1970.rounded(.down))
    }

    public static func lastInput(secondsSinceInput: TimeInterval, now: Date) -> Date {
        wholeSeconds(now.addingTimeInterval(-max(0, secondsSinceInput)))
    }
}

extension DeviceAPI {
    public func reportPresence(lastInputAt: Date) async throws {
        struct Body: Encodable { let lastInputAt: String }
        let body = try JSONEncoder().encode(Body(lastInputAt: MessageSensing.timestamp(PresenceReport.wholeSeconds(lastInputAt))))
        _ = try await http.send(DeviceRequest(method: "POST", path: "presence", body: body))
    }
}
