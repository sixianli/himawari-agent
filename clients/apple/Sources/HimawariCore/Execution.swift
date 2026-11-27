import Foundation

public enum ExecutionRecordKind: String, Codable, Sendable {
    case message
    case tool
    case status
    case unrecognized
}

public enum ExecutionPhase: String, Codable, Sendable {
    case started
    case updated
    case completed
    case failed
    case waiting
    case stopped
    case unavailable
    case unrecognized
}

public struct ExecutionRecord: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let sequence: Int
    public let itemId: String
    public let kind: ExecutionRecordKind
    public let phase: ExecutionPhase
    public let name: String
    public let text: String
    public let occurredAt: Date
    public let activity: String?
    public let activityIcon: String?

    public init(
        id: String,
        sequence: Int,
        itemId: String,
        kind: ExecutionRecordKind,
        phase: ExecutionPhase,
        name: String,
        text: String = "",
        occurredAt: Date,
        activity: String? = nil,
        activityIcon: String? = nil
    ) {
        self.id = id
        self.sequence = sequence
        self.itemId = itemId
        self.kind = kind
        self.phase = phase
        self.name = name
        self.text = text
        self.occurredAt = occurredAt
        self.activity = activity
        self.activityIcon = activityIcon
    }
}

public struct ExecutionPage: Codable, Sendable, Equatable {
    public let records: [ExecutionRecord]
    public let nextSequence: Int?
}

public enum ProcessIcon: String, CaseIterable, Sendable {
    case bulb, affiliate, pencilPlus = "pencil-plus", listCheck = "list-check", history, stack2 = "stack-2"
    case calendar, bell, mail, message2 = "message-2", phone, clipboardList = "clipboard-list"
    case train, car, walk, plane, mapPin = "map-pin", cloud
    case worldSearch = "world-search", world, fileText = "file-text", filePencil = "file-pencil", table, photo
    case terminal2 = "terminal-2", calculator, creditCard = "credit-card", download, users, puzzle
    case ear, eye, currentLocation = "current-location", heartbeat, deviceMobile = "device-mobile", homeBolt = "home-bolt"
    case handStop = "hand-stop", alertCircle = "alert-circle", playerStop = "player-stop", check

    public static let outcomes: Set<ProcessIcon> = [.handStop, .alertCircle, .playerStop, .check]

    public static func chosen(_ name: String?) -> ProcessIcon {
        guard let name, let icon = ProcessIcon(rawValue: name), !outcomes.contains(icon) else { return .puzzle }
        return icon
    }
}

public struct ProcessStep: Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let icon: ProcessIcon
    public let phase: ExecutionPhase
    public let startedAt: Date
    public let endedAt: Date
}

public enum ProcessLine: Sendable, Equatable {
    case thinking
    case working(current: ProcessStep, setback: ProcessStep?)
    case waiting(ProcessStep)
    case finished(steps: [ProcessStep], seconds: Int)
    case failed(steps: [ProcessStep], seconds: Int)
    case stopped(steps: [ProcessStep], seconds: Int)

    public static let terminalRunStatuses: Set<String> = ["completed", "failed", "cancelled"]

    public static func steps(from records: [ExecutionRecord]) -> [ProcessStep] {
        var order: [String] = []
        var latest: [String: ExecutionRecord] = [:]
        var first: [String: ExecutionRecord] = [:]
        for record in records.sorted(by: { $0.sequence < $1.sequence }) where record.kind == .tool || record.kind == .unrecognized {
            if latest[record.itemId] == nil {
                order.append(record.itemId)
                first[record.itemId] = record
            }
            let previous = latest[record.itemId]
            latest[record.itemId] = ExecutionRecord(
                id: record.id,
                sequence: record.sequence,
                itemId: record.itemId,
                kind: record.kind,
                phase: record.phase,
                name: record.name,
                text: record.text,
                occurredAt: record.occurredAt,
                activity: Self.present(record.activity) ?? previous?.activity,
                activityIcon: Self.present(record.activityIcon) ?? previous?.activityIcon
            )
        }
        return order.compactMap { itemId in
            guard let last = latest[itemId], let start = first[itemId] else { return nil }
            return ProcessStep(
                id: itemId,
                title: last.activity ?? last.name,
                icon: last.kind == .unrecognized ? .puzzle : ProcessIcon.chosen(last.activityIcon),
                phase: last.kind == .unrecognized ? .unrecognized : last.phase,
                startedAt: start.occurredAt,
                endedAt: last.occurredAt
            )
        }
    }

    static func present(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    public static func make(records: [ExecutionRecord], runStatus: String) -> ProcessLine {
        let steps = steps(from: records)
        let sorted = records.sorted { $0.sequence < $1.sequence }
        let seconds: Int = {
            guard let start = sorted.first?.occurredAt, let end = sorted.last?.occurredAt else { return 0 }
            return max(0, Int(end.timeIntervalSince(start).rounded()))
        }()
        if terminalRunStatuses.contains(runStatus) {
            switch runStatus {
            case "cancelled": return .stopped(steps: steps, seconds: seconds)
            case "failed": return .failed(steps: steps, seconds: seconds)
            default: return .finished(steps: steps, seconds: seconds)
            }
        }
        if let latest = sorted.last, latest.phase == .waiting, latest.kind == .tool || latest.kind == .status {
            let step = (latest.kind == .tool ? steps.first(where: { $0.id == latest.itemId }) : steps.last)
                ?? ProcessStep(id: latest.itemId, title: Self.present(latest.activity) ?? "", icon: ProcessIcon.chosen(latest.activityIcon), phase: .waiting, startedAt: latest.occurredAt, endedAt: latest.occurredAt)
            return .waiting(ProcessStep(id: step.id, title: step.title, icon: step.icon, phase: .waiting, startedAt: step.startedAt, endedAt: latest.occurredAt))
        }
        let latestUnknownStatus = sorted.last(where: { $0.kind == .status && $0.phase == .unrecognized })
        if let unknown = latestUnknownStatus, unknown == sorted.last || steps.isEmpty {
            return .working(current: ProcessStep(id: unknown.itemId, title: Self.present(unknown.activity) ?? unknown.name, icon: .puzzle, phase: .unrecognized, startedAt: unknown.occurredAt, endedAt: unknown.occurredAt), setback: nil)
        }
        guard let current = steps.last else { return .thinking }
        let setback = steps.dropLast().last.flatMap { $0.phase == .failed || $0.phase == .unavailable ? $0 : nil }
        if current.phase == .failed || current.phase == .unavailable {
            return .working(current: current, setback: nil)
        }
        return .working(current: current, setback: setback)
    }
}

public extension ProcessLine {
    var hasNothingToShow: Bool {
        if case let .finished(steps, _) = self { return steps.isEmpty }
        return false
    }

    public var showsInTranscript: Bool {
        if case .finished = self { return false }
        return true
    }

    public var finishedSteps: [ProcessStep]? {
        if case let .finished(steps, _) = self, !steps.isEmpty { return steps }
        return nil
    }
}

public enum ExecutionRefresh {
    public static func needed(loaded: Bool, runStatus: String?) -> Bool {
        guard loaded, let runStatus else { return true }
        return !ProcessLine.terminalRunStatuses.contains(runStatus)
    }
}
