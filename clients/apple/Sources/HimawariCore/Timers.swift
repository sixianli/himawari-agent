import Foundation

public struct OwnerTimer: Decodable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Decodable, Sendable, CaseIterable {
        case reminder
        case recurring
        case followUp = "follow_up"
    }

    public enum CreatedBy: String, Decodable, Sendable {
        case owner, agreed
        case her = "self"
    }

    public enum Status: String, Decodable, Sendable {
        case active, paused, cancelled, finished
    }

    public enum Action: String, Sendable {
        case pause, resume, cancel
    }

    public struct LastResult: Decodable, Sendable, Equatable {
        public let text: String
        public let at: Date

        public init(text: String, at: Date) {
            self.text = text
            self.at = at
        }
    }

    public let timerId: String
    public let kind: Kind
    public let title: String?
    public let task: String
    public let ownerWords: String?
    public let schedule: String
    public let createdBy: CreatedBy
    public var status: Status
    public let nextAt: Date?
    public let lastAt: Date?
    public let runCount: Int
    public let spentMicros: Int
    public let runBudgetMicros: Int?
    public let lastResult: LastResult?
    public let createdAt: Date
    public var id: String { timerId }

    public init(
        timerId: String,
        kind: Kind,
        title: String? = nil,
        task: String,
        ownerWords: String? = nil,
        schedule: String,
        createdBy: CreatedBy,
        status: Status = .active,
        nextAt: Date? = nil,
        lastAt: Date? = nil,
        runCount: Int = 0,
        spentMicros: Int = 0,
        runBudgetMicros: Int? = nil,
        lastResult: LastResult? = nil,
        createdAt: Date
    ) {
        self.timerId = timerId
        self.kind = kind
        self.title = title
        self.task = task
        self.ownerWords = ownerWords
        self.schedule = schedule
        self.createdBy = createdBy
        self.status = status
        self.nextAt = nextAt
        self.lastAt = lastAt
        self.runCount = runCount
        self.spentMicros = spentMicros
        self.runBudgetMicros = runBudgetMicros
        self.lastResult = lastResult
        self.createdAt = createdAt
    }

    public static let nameLimit = 20

    public var name: String {
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        let first = task.split(whereSeparator: \.isNewline).lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        return first.count > Self.nameLimit ? String(first.prefix(Self.nameLimit)) + "…" : first
    }

    public var ownerWordLines: [String] {
        guard let ownerWords else { return [] }
        return ownerWords.split(whereSeparator: \.isNewline).compactMap { line in
            var text = line.trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("- ") { text.removeFirst(2) } else if text.hasPrefix("-") { text.removeFirst() }
            text = text.trimmingCharacters(in: .whitespaces)
            return text.isEmpty ? nil : text
        }
    }

    public var canPause: Bool { kind != .reminder }
    public var isShown: Bool { status == .active || status == .paused }
}

public struct TimersSnapshot: Decodable, Sendable, Equatable {
    public let timers: [OwnerTimer]
    public let generatedAt: Date

    public init(timers: [OwnerTimer], generatedAt: Date) {
        self.timers = timers
        self.generatedAt = generatedAt
    }

    public static func decode(_ data: Data) throws -> TimersSnapshot {
        struct Envelope: Decodable { let payload: TimersSnapshot }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom(DeviceAPI.timestamp)
        return try decoder.decode(Envelope.self, from: data).payload
    }
}

public struct TimerGroup: Sendable, Equatable, Identifiable {
    public let kind: OwnerTimer.Kind
    public let timers: [OwnerTimer]
    public var id: OwnerTimer.Kind { kind }
}

public enum TimerList {
    public static func groups(_ timers: [OwnerTimer]) -> [TimerGroup] {
        OwnerTimer.Kind.allCases.compactMap { kind in
            let shown = timers.filter { $0.kind == kind && $0.isShown }
            guard !shown.isEmpty else { return nil }
            return TimerGroup(kind: kind, timers: ordered(shown))
        }
    }

    public static func ordered(_ timers: [OwnerTimer]) -> [OwnerTimer] {
        let active = timers.filter { $0.status == .active }.sorted { left, right in
            switch (left.nextAt, right.nextAt) {
            case let (l?, r?): l < r
            case (.some, nil): true
            case (nil, .some): false
            case (nil, nil): left.createdAt > right.createdAt
            }
        }
        let paused = timers.filter { $0.status == .paused }.sorted { $0.createdAt > $1.createdAt }
        return active + paused
    }

    public static func counts(_ timers: [OwnerTimer]) -> (active: Int, paused: Int) {
        (timers.filter { $0.status == .active }.count, timers.filter { $0.status == .paused }.count)
    }
}

public enum TimerWhen: Equatable, Sendable {
    case today(hour: Int, minute: Int)
    case tomorrow(hour: Int, minute: Int)
    case weekday(Int, hour: Int, minute: Int)
    case day(month: Int, day: Int, hour: Int, minute: Int)

    public init(_ date: Date, now: Date, calendar: Calendar = .current) {
        let time = calendar.dateComponents([.hour, .minute, .month, .day, .weekday], from: date)
        let hour = time.hour ?? 0
        let minute = time.minute ?? 0
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        switch days {
        case 0: self = .today(hour: hour, minute: minute)
        case 1: self = .tomorrow(hour: hour, minute: minute)
        case 2...6: self = .weekday(time.weekday ?? 1, hour: hour, minute: minute)
        default: self = .day(month: time.month ?? 1, day: time.day ?? 1, hour: hour, minute: minute)
        }
    }
}
