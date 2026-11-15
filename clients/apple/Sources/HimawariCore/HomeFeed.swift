import Foundation

public enum HomeLocale: String, Codable, Sendable, CaseIterable {
    case chinese = "zh-CN"
    case english = "en"
    case japanese = "ja"

    public static func matching(_ preferred: [String]) -> HomeLocale {
        for identifier in preferred {
            let language = Locale(identifier: identifier).language.languageCode?.identifier
            switch language {
            case "zh": return .chinese
            case "ja": return .japanese
            case "en": return .english
            default: continue
            }
        }
        return .chinese
    }
}

public struct HomeFeedAction: Codable, Sendable, Equatable, Hashable {
    public enum Polarity: String, Codable, Sendable {
        case positive
        case negative
        case neutral
    }

    public let action: String
    public let label: String
    public let labelBasis: String
    public let polarity: Polarity
    public let ownerPresence: Bool
    public let reviewLabel: String?
    public let binding: String?

    public init(action: String, label: String, labelBasis: String = "catalog", polarity: Polarity, ownerPresence: Bool = false, reviewLabel: String? = nil, binding: String? = nil) {
        self.action = action
        self.label = label
        self.labelBasis = labelBasis
        self.polarity = polarity
        self.ownerPresence = ownerPresence
        self.reviewLabel = reviewLabel
        self.binding = binding
    }

    public var buttonLabel: String {
        if ownerPresence, let reviewLabel, !reviewLabel.isEmpty { return reviewLabel }
        return label
    }
}

public struct HomeFeedItem: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: Equatable, Sendable {
        case headsUp
        case approval
        case memoryConfirm
        case done
        case running
        case problem
        case other(String)

        init(_ raw: String) {
            switch raw {
            case "heads_up": self = .headsUp
            case "approval": self = .approval
            case "memory_confirm": self = .memoryConfirm
            case "done": self = .done
            case "running": self = .running
            case "problem": self = .problem
            default: self = .other(raw)
            }
        }
    }

    public struct Target: Codable, Sendable, Equatable {
        public let type: String
        public let id: String?
        public let threadId: String?
        public let link: String?

        public init(type: String, id: String?, threadId: String?, link: String? = nil) {
            self.type = type
            self.id = id
            self.threadId = threadId
            self.link = link
        }
    }

    public struct Source: Codable, Sendable, Equatable {
        public let type: String
        public let from: String?
        public let label: String?
        public let threadId: String?
        public let decisionId: String?
        public let at: String

        public init(type: String, from: String?, label: String?, threadId: String?, decisionId: String? = nil, at: String) {
            self.type = type
            self.from = from
            self.label = label
            self.threadId = threadId
            self.decisionId = decisionId
            self.at = at
        }
    }

    public let key: String
    public let kind: String
    public let awaitsOwner: Bool
    public let sentence: String?
    public let sentenceBasis: String
    public let target: Target
    public let source: Source
    public let deadline: String?
    public let createdAt: String
    public let actions: [HomeFeedAction]
    public let rank: String
    public let dataClassification: String

    public var id: String { key }
    public var itemKind: Kind { Kind(kind) }

    public init(
        key: String,
        kind: String,
        awaitsOwner: Bool,
        sentence: String?,
        sentenceBasis: String = "recorded",
        target: Target,
        source: Source,
        deadline: String? = nil,
        createdAt: String,
        actions: [HomeFeedAction] = [],
        rank: String = "unscored",
        dataClassification: String = "personal"
    ) {
        self.key = key
        self.kind = kind
        self.awaitsOwner = awaitsOwner
        self.sentence = sentence
        self.sentenceBasis = sentenceBasis
        self.target = target
        self.source = source
        self.deadline = deadline
        self.createdAt = createdAt
        self.actions = actions
        self.rank = rank
        self.dataClassification = dataClassification
    }

    public var threadId: String? { target.threadId ?? source.threadId }

    public var approvalId: String? {
        target.type == "approval" ? target.id : nil
    }

    public var subtitle: String? {
        let label = source.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty { return label }
        let from = source.from?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let from, !from.isEmpty { return from }
        return nil
    }

    public var choice: HomeChoice? {
        HomeChoice(actions.filter { $0.binding != nil || approvalId != nil })
    }
}

public struct HomeChoice: Sendable, Equatable {
    public let decline: HomeFeedAction?
    public let confirm: HomeFeedAction

    init?(_ actions: [HomeFeedAction]) {
        let positive = actions.first { $0.polarity == .positive }
        let negative = actions.first { $0.polarity == .negative }
        let neutral = actions.first { $0.polarity == .neutral }
        if let positive {
            confirm = positive
            decline = negative ?? neutral
        } else if let neutral {
            confirm = neutral
            decline = negative
        } else if let negative {
            confirm = negative
            decline = nil
        } else {
            return nil
        }
    }
}

public struct HomeUpcoming: Codable, Sendable, Equatable, Identifiable {
    public let reminderId: String
    public let memoryId: String
    public let text: String
    public let dueAt: String
    public let `repeat`: String
    public let sourceThreadId: String?
    public let dataClassification: String

    public var id: String { reminderId }

    public init(reminderId: String, memoryId: String, text: String, dueAt: String, repeat: String = "none", sourceThreadId: String? = nil, dataClassification: String = "personal") {
        self.reminderId = reminderId
        self.memoryId = memoryId
        self.text = text
        self.dueAt = dueAt
        self.repeat = `repeat`
        self.sourceThreadId = sourceThreadId
        self.dataClassification = dataClassification
    }

    public var due: Date? { HomeTimestamp.parse(dueAt) }
}

public struct HomeFeedSnapshot: Codable, Sendable, Equatable {
    public let items: [HomeFeedItem]
    public let awaitingCount: Int
    public let awaitingTruncated: Bool
    public let incompleteSources: [String]
    public let upcoming: [HomeUpcoming]
    public let revision: String
    public let generatedAt: String

    public init(items: [HomeFeedItem], awaitingCount: Int, awaitingTruncated: Bool = false, incompleteSources: [String] = [], upcoming: [HomeUpcoming], revision: String, generatedAt: String) {
        self.items = items
        self.awaitingCount = awaitingCount
        self.awaitingTruncated = awaitingTruncated
        self.incompleteSources = incompleteSources
        self.upcoming = upcoming
        self.revision = revision
        self.generatedAt = generatedAt
    }

    public static func decode(_ data: Data) throws -> HomeFeedSnapshot {
        try JSONDecoder().decode(HomeFeedSnapshot.self, from: data)
    }
}

public enum HomeRequestId {
    public static func make() -> String {
        "home-\(OutgoingMessage.newId())"
    }
}

extension DeviceAPI {
    public func homeFeed(locale: HomeLocale) async throws -> HomeFeedSnapshot {
        let data = try await http.send(DeviceRequest(method: "GET", path: "home", query: [URLQueryItem(name: "locale", value: locale.rawValue)]))
        return try decode(HomeFeedSnapshot.self, data)
    }

    public func act(on item: HomeFeedItem, action: HomeFeedAction, requestId: String, presence: OwnerPresenceSigner? = nil) async throws {
        try await act(key: item.key, action: action.action, binding: action.binding, ownerPresence: action.ownerPresence, requestId: requestId, presence: presence)
    }
}

public struct HomeLayout: Sendable, Equatable {
    public let lead: HomeFeedItem?
    public let rows: [HomeFeedItem]
    public let badge: Int?
    public let upcoming: [HomeUpcoming]

    public var isQuiet: Bool { lead == nil && rows.isEmpty }

    public init(_ snapshot: HomeFeedSnapshot, settled: Set<String> = []) {
        let items = snapshot.items.filter { !settled.contains($0.key) }
        let leadIndex = items.firstIndex { $0.awaitsOwner && $0.choice != nil }
        lead = leadIndex.map { items[$0] }
        var rest = items
        if let leadIndex { rest.remove(at: leadIndex) }
        rows = rest
        upcoming = snapshot.upcoming
        badge = Self.badge(snapshot, settled: settled)
    }

    static func badge(_ snapshot: HomeFeedSnapshot, settled: Set<String>) -> Int? {
        guard snapshot.incompleteSources.isEmpty else { return nil }
        let settledAwaiting = snapshot.items.filter { $0.awaitsOwner && settled.contains($0.key) }.count
        let count = max(0, snapshot.awaitingCount - settledAwaiting)
        return count > 0 ? count : nil
    }
}

public enum HomeTimestamp {
    public static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

public enum UpcomingDay: Equatable, Sendable {
    case today
    case tonight
    case tomorrow
    case weekday(Int)
    case date(month: Int, day: Int)

    public static let eveningHour = 18
    public static let weekdayReach = 6

    public static func of(_ due: Date, now: Date, calendar: Calendar) -> UpcomingDay {
        let startToday = calendar.startOfDay(for: now)
        let startDue = calendar.startOfDay(for: due)
        let days = calendar.dateComponents([.day], from: startToday, to: startDue).day ?? 0
        switch days {
        case ...0:
            return calendar.component(.hour, from: due) >= eveningHour ? .tonight : .today
        case 1:
            return .tomorrow
        case 2...weekdayReach:
            return .weekday(calendar.component(.weekday, from: due))
        default:
            return .date(month: calendar.component(.month, from: due), day: calendar.component(.day, from: due))
        }
    }
}
