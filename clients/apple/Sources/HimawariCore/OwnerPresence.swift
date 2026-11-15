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

    public var createdDate: Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: createdAt) ?? ISO8601DateFormatter().date(from: createdAt)
    }
}

public struct PendingNotifications: Sendable {
    public static let settledLimit = 500
    public static let settledName = "settled-notices.json"

    public private(set) var items: [DeviceNotification] = []
    private var settled: [String] = []
    private var store: LocalStore?

    public init() {}

    public init(rememberingIn store: LocalStore) {
        remember(in: store)
    }

    public mutating func remember(in store: LocalStore) {
        let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
        var merged = saved.filter { !settled.contains($0) }
        merged.append(contentsOf: settled)
        settled = Array(merged.suffix(Self.settledLimit))
        self.store = store
        save()
        items.removeAll { settled.contains($0.id) }
    }

    @discardableResult
    public mutating func deliver(_ notification: DeviceNotification) -> Bool {
        guard !settled.contains(notification.id) else { return false }
        if let index = items.firstIndex(where: { $0.id == notification.id }) {
            guard items[index] != notification else { return false }
            items[index] = notification
        } else {
            items.append(notification)
        }
        items = items
            .map { (instant: Self.instant($0), notice: $0) }
            .sorted { ($0.instant, $0.notice.id) > ($1.instant, $1.notice.id) }
            .map(\.notice)
        return true
    }

    @discardableResult
    public mutating func withdraw(_ id: String) -> DeviceNotification? {
        if !settled.contains(id) {
            settled.append(id)
            if settled.count > Self.settledLimit { settled.removeFirst(settled.count - Self.settledLimit) }
            save()
        }
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        return items.remove(at: index)
    }

    private func save() {
        guard let store, let data = try? JSONEncoder().encode(settled) else { return }
        try? store.write(Self.settledName, data)
    }

    static func instant(_ notice: DeviceNotification) -> Date {
        notice.createdDate ?? .distantPast
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

    public func secondsUntilNextCheck(now: Date, lastReport: PresenceReport?) -> TimeInterval {
        let tick = max(minimumInterval / 4, 1)
        guard let lastReport else { return tick }
        let untilKeepAlive = keepAliveInterval - now.timeIntervalSince(lastReport.sentAt)
        return untilKeepAlive > 0 ? min(tick, untilKeepAlive) : tick
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

    public static func lastInput(secondsSinceInput: TimeInterval, now: Date) -> Date? {
        guard secondsSinceInput.isFinite, secondsSinceInput >= 0 else { return nil }
        return wholeSeconds(now.addingTimeInterval(-secondsSinceInput))
    }
}

extension DeviceAPI {
    public func reportPresence(lastInputAt: Date) async throws {
        struct Body: Encodable { let lastInputAt: String }
        let body = try JSONEncoder().encode(Body(lastInputAt: MessageSensing.timestamp(PresenceReport.wholeSeconds(lastInputAt))))
        _ = try await http.send(DeviceRequest(method: "POST", path: "presence", body: body))
    }
}
