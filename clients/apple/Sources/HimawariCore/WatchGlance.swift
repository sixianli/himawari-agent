import Foundation

public struct WatchItem: Decodable, Sendable, Equatable, Identifiable {
    public let key: String
    public let awaitsOwner: Bool
    public let sentence: String?
    public let detail: String?
    public let deadline: Date?
    public let actions: [HomeAction]
    public var id: String { key }

    public init(key: String, awaitsOwner: Bool, sentence: String?, detail: String?, deadline: Date?, actions: [HomeAction]) {
        self.key = key
        self.awaitsOwner = awaitsOwner
        self.sentence = sentence
        self.detail = detail
        self.deadline = deadline
        self.actions = actions
    }

    private enum CodingKeys: String, CodingKey {
        case key, awaitsOwner, sentence, source, deadline, actions
    }

    private struct Source: Decodable {
        let label: String?
        let from: String?
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        awaitsOwner = try container.decode(Bool.self, forKey: .awaitsOwner)
        sentence = try container.decodeIfPresent(String.self, forKey: .sentence).flatMap(Self.visible)
        let source = try container.decodeIfPresent(Source.self, forKey: .source)
        detail = Self.visible(source?.label) ?? Self.visible(source?.from)
        deadline = try container.decodeIfPresent(String.self, forKey: .deadline).flatMap(ServerTime.parse)
        actions = try container.decodeIfPresent([HomeAction].self, forKey: .actions) ?? []
    }

    static func visible(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

public struct WatchUpcoming: Decodable, Sendable, Equatable, Identifiable {
    public let reminderId: String
    public let text: String
    public let due: Date
    public var id: String { reminderId }

    public init(reminderId: String, text: String, due: Date) {
        self.reminderId = reminderId
        self.text = text
        self.due = due
    }

    private enum CodingKeys: String, CodingKey {
        case reminderId, text, dueAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reminderId = try container.decode(String.self, forKey: .reminderId)
        text = try container.decode(String.self, forKey: .text)
        let raw = try container.decode(String.self, forKey: .dueAt)
        guard let due = ServerTime.parse(raw) else {
            throw DecodingError.dataCorruptedError(forKey: .dueAt, in: container, debugDescription: "dueAt")
        }
        self.due = due
    }
}

public struct WatchHome: Decodable, Sendable, Equatable {
    public let items: [WatchItem]
    public let awaitingCount: Int
    public let incompleteSources: [String]
    public let upcoming: [WatchUpcoming]
    public let revision: String

    public init(items: [WatchItem], awaitingCount: Int, incompleteSources: [String] = [], upcoming: [WatchUpcoming] = [], revision: String) {
        self.items = items
        self.awaitingCount = awaitingCount
        self.incompleteSources = incompleteSources
        self.upcoming = upcoming
        self.revision = revision
    }

    private enum CodingKeys: String, CodingKey {
        case items, awaitingCount, incompleteSources, upcoming, revision
    }

    private struct Lenient<Value: Decodable>: Decodable {
        let value: Value?
        init(from decoder: Decoder) throws {
            value = try? decoder.singleValueContainer().decode(Value.self)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([WatchItem].self, forKey: .items)
        awaitingCount = try container.decode(Int.self, forKey: .awaitingCount)
        incompleteSources = try container.decodeIfPresent([String].self, forKey: .incompleteSources) ?? []
        upcoming = (try container.decodeIfPresent([Lenient<WatchUpcoming>].self, forKey: .upcoming) ?? []).compactMap(\.value)
        revision = try container.decode(String.self, forKey: .revision)
    }

    public var pressing: WatchItem? {
        items.first { $0.awaitsOwner && $0.sentence != nil }
    }

    public var countedAwaiting: Int? {
        incompleteSources.isEmpty ? max(0, awaitingCount) : nil
    }
}

public enum ServerTime {
    public static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }
}

public struct WatchCard: Sendable, Equatable {
    public enum Choice: Sendable, Equatable {
        case decide([HomeAction])
        case handOff
    }

    public let key: String
    public let time: Date?
    public let sentence: String
    public let detail: String?
    public let choice: Choice

    public init?(_ item: WatchItem) {
        guard let sentence = item.sentence else { return nil }
        key = item.key
        time = item.deadline
        self.sentence = sentence
        detail = item.detail
        let shown = Self.ordered(Array(item.actions.prefix(HomeItem.shownActionLimit)))
        if shown.isEmpty || shown.contains(where: \.ownerPresence) {
            choice = .handOff
        } else {
            choice = .decide(shown)
        }
    }

    static func ordered(_ actions: [HomeAction]) -> [HomeAction] {
        let rank = ["positive": 0, "neutral": 1, "negative": 2]
        return actions.enumerated()
            .sorted { (rank[$0.element.polarity] ?? 1, $0.offset) < (rank[$1.element.polarity] ?? 1, $1.offset) }
            .map(\.element)
    }
}

public struct WatchComplicationState: Codable, Sendable, Equatable {
    public enum Display: Sendable, Equatable {
        case waiting(count: Int, latest: String?)
        case nothingWaiting
        case unknown
    }

    public let awaiting: Int?
    public let latest: String?
    public let updatedAt: Date

    public init(awaiting: Int?, latest: String?, updatedAt: Date) {
        self.awaiting = awaiting
        self.latest = latest
        self.updatedAt = updatedAt
    }

    public init(home: WatchHome, at now: Date) {
        self.init(awaiting: home.countedAwaiting, latest: home.pressing?.sentence, updatedAt: now)
    }

    public static let unknown = WatchComplicationState(awaiting: nil, latest: nil, updatedAt: .distantPast)

    public var display: Display {
        guard let awaiting else { return .unknown }
        return awaiting > 0 ? .waiting(count: awaiting, latest: latest) : .nothingWaiting
    }
}

public enum WatchReminderPlan {
    public static func due(_ upcoming: [WatchUpcoming], after now: Date, limit: Int) -> [WatchUpcoming] {
        let future = upcoming.filter { $0.due > now && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        var seen = Set<String>()
        let unique = future.sorted { ($0.due, $0.reminderId) < ($1.due, $1.reminderId) }.filter { seen.insert($0.reminderId).inserted }
        return Array(unique.prefix(max(0, limit)))
    }
}

public enum WatchReply {
    public enum State: Sendable, Equatable {
        case waiting
        case answered(contentRef: String)
        case failed
    }

    public static func state(in detail: ThreadDetail, after ownerMessageId: String) -> State {
        guard let owner = detail.messages.first(where: { $0.messageId == ownerMessageId }) else { return .waiting }
        let answers = detail.messages
            .filter { $0.role == .agent && $0.sequence > owner.sequence && $0.status != .partial }
            .sorted { $0.sequence < $1.sequence }
        guard let answer = answers.first else { return .waiting }
        return answer.status == .failed ? .failed : .answered(contentRef: answer.contentRef)
    }

    public static func firstSentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let enders: Set<Character> = ["。", "！", "？", "!", "?", "\n"]
        var sentence = ""
        var index = trimmed.startIndex
        while index < trimmed.endIndex {
            let character = trimmed[index]
            let next = trimmed.index(after: index)
            if character == "\n" { break }
            sentence.append(character)
            if enders.contains(character) { break }
            if character == ".", next == trimmed.endIndex || trimmed[next].isWhitespace { break }
            index = next
        }
        let result = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? trimmed : result
    }
}

public enum WatchPairingRelay {
    public static let key = "himawariPairingLink"

    public static func message(_ link: String) -> [String: String] {
        [key: link.trimmingCharacters(in: .whitespacesAndNewlines)]
    }

    public static func link(in message: [String: Any]) -> String? {
        guard let link = message[key] as? String, (try? PairingInvitation.parse(link)) != nil else { return nil }
        return link
    }
}
