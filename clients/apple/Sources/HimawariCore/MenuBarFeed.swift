import Foundation

public struct HomeAction: Codable, Sendable, Equatable {
    public let action: String
    public let label: String
    public let polarity: String
    public let ownerPresence: Bool
    public let binding: String?

    public init(action: String, label: String, polarity: String, ownerPresence: Bool, binding: String?) {
        self.action = action
        self.label = label
        self.polarity = polarity
        self.ownerPresence = ownerPresence
        self.binding = binding
    }
}

public struct HomeItem: Codable, Sendable, Equatable, Identifiable {
    public let key: String
    public let kind: String
    public let awaitsOwner: Bool
    public let sentence: String?
    public let actions: [HomeAction]
    public var id: String { key }

    public static let shownActionLimit = 2

    public var shownActions: [HomeAction] { Array(actions.prefix(Self.shownActionLimit)) }
}

public struct HomeSnapshot: Codable, Sendable, Equatable {
    public let items: [HomeItem]
    public let awaitingCount: Int
    public let revision: String

    public var mostPressing: HomeItem? {
        items.first { $0.awaitsOwner && $0.sentence?.isEmpty == false }
    }
}

public typealias LocalizedDetail = [String: String]

public enum DetailLocale {
    public static func pick(_ detail: LocalizedDetail, preferred: [String] = Locale.preferredLanguages) -> String? {
        for language in preferred {
            let lower = language.lowercased()
            let key = lower.hasPrefix("zh") ? "zh-CN" : lower.hasPrefix("ja") ? "ja" : lower.hasPrefix("en") ? "en" : nil
            if let key, let text = detail[key], !text.isEmpty { return text }
        }
        return detail["zh-CN"] ?? detail["en"] ?? detail["ja"] ?? detail.values.sorted().first
    }
}

public struct DeviceActionSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let state: String
    public let detail: LocalizedDetail
    public let risk: String
    public let ownerPresence: Bool
    public let reversible: Bool
    public let reason: String?
    public let createdAt: String

    public static let runningStates: Set<String> = ["delivered", "running"]
    public static let waitingStates: Set<String> = ["waiting_owner"]

    public var isRunning: Bool { Self.runningStates.contains(state) }
}

public struct DeviceProgress: Sendable, Equatable {
    public let done: Int
    public let total: Int

    public init(done: Int, total: Int) {
        self.done = max(0, min(done, total))
        self.total = max(0, total)
    }

    public var fraction: Double { total == 0 ? 0 : Double(done) / Double(total) }
}

extension DeviceAPI {
    public func deviceActions() async throws -> [DeviceActionSummary] {
        struct Body: Decodable { let actions: [DeviceActionSummary] }
        return try decode(Body.self, try await http.send(DeviceRequest(method: "GET", path: "actions"))).actions
    }

    public func home(locale: String) async throws -> HomeSnapshot {
        let data = try await http.send(DeviceRequest(method: "GET", path: "home", query: [URLQueryItem(name: "locale", value: locale)]))
        return try decode(HomeSnapshot.self, data)
    }

    public func watchHome(locale: String) async throws -> WatchHome {
        let data = try await http.send(DeviceRequest(method: "GET", path: "home", query: [URLQueryItem(name: "locale", value: locale)]))
        return try decode(WatchHome.self, data)
    }

    public static func newActionRequestId() -> String {
        "act_" + OutgoingMessage.newId()
    }

    public func act(on item: HomeItem, action: HomeAction, requestId: String) async throws {
        try await act(key: item.key, action: action, requestId: requestId)
    }

    public func act(key: String, action: HomeAction, requestId: String) async throws {
        struct Body: Encodable {
            let key: String
            let action: String
            let binding: String?
            let requestId: String
        }
        let body = try JSONEncoder().encode(Body(key: key, action: action.action, binding: action.binding, requestId: requestId))
        _ = try await http.send(DeviceRequest(method: "POST", path: "home/act", body: body))
    }
}

public struct ChangeRow: Codable, Sendable, Equatable, Identifiable {
    public let icon: String?
    public let text: String
    public let note: String?
    public var id: String { text }

    public init(icon: String?, text: String, note: String?) {
        self.icon = icon
        self.text = text
        self.note = note
    }
}

public struct ChangeList: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let rows: [ChangeRow]
    public let items: [String]

    public init(id: String, title: String, rows: [ChangeRow], items: [String]) {
        self.id = id
        self.title = title
        self.rows = rows
        self.items = items
    }
}
