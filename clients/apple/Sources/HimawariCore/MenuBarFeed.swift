import Foundation

public struct HomeAction: Codable, Sendable, Equatable {
    public let action: String
    public let label: String
    public let polarity: String
    public let ownerPresence: Bool
    public let binding: String?
}

public struct HomeItem: Codable, Sendable, Equatable, Identifiable {
    public let key: String
    public let kind: String
    public let awaitsOwner: Bool
    public let sentence: String?
    public let actions: [HomeAction]
    public var id: String { key }

    public var shownActions: [HomeAction] { Array(actions.prefix(2)) }
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

    public func confirmChallenge() async throws -> String {
        struct Reply: Decodable { let challenge: String }
        let data = try await http.send(DeviceRequest(method: "POST", path: "approvals/challenge", body: Data("{}".utf8)))
        return try decode(Reply.self, data).challenge
    }

    public func act(on item: HomeItem, action: HomeAction, requestId: String, presence: OwnerPresenceSigner? = nil) async throws {
        struct Body: Encodable {
            let key: String
            let action: String
            let binding: String?
            let requestId: String
        }
        let body = try JSONEncoder().encode(Body(key: item.key, action: action.action, binding: action.binding, requestId: requestId))
        guard action.ownerPresence else {
            _ = try await http.send(DeviceRequest(method: "POST", path: "home/act", body: body))
            return
        }
        guard let presence else { throw OwnerPresenceError.unavailable }
        let challenge = try await confirmChallenge()
        _ = try await http.send(DeviceRequest(
            method: "POST",
            path: "home/act",
            body: body,
            nonce: challenge,
            confirmSigner: presence,
            confirmReason: presence.reason
        ))
    }
}

public enum OwnerPresenceError: Error, Equatable, Sendable {
    case unavailable
    case declined
}

public struct OwnerPresenceSigner: DeviceKeySigner {
    public let key: DeviceKeySigner
    public let reason: String

    public init(key: DeviceKeySigner, reason: String) {
        self.key = key
        self.reason = reason
    }

    public func publicKeySPKI() throws -> Data {
        try key.publicKeySPKI()
    }

    public func sign(_ message: Data, reason: String?) async throws -> Data {
        do {
            return try await key.sign(message, reason: reason ?? self.reason)
        } catch let error as DeviceKeyError {
            throw error
        } catch {
            throw OwnerPresenceError.declined
        }
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
