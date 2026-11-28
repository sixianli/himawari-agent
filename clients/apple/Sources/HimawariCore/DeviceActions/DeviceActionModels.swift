import Foundation

public typealias LocalizedLine = [String: String]

public extension Dictionary where Key == String, Value == String {
    func localized(_ locale: AnswerLocale = .matching(preferredLanguages: Locale.preferredLanguages)) -> String {
        if let line = self[locale.rawValue], !line.isEmpty { return line }
        for fallback in AnswerLocale.allCases {
            if let line = self[fallback.rawValue], !line.isEmpty { return line }
        }
        return ""
    }
}

public enum DeviceActionMode: String, Codable, Sendable {
    case perform
    case verify
}

public enum DeviceActionReadBackKind: String, Codable, Sendable {
    case none
    case readItem = "read_item"
    case confirmAbsent = "confirm_absent"
    case readState = "read_state"
}

public struct DeviceActionDelivery: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let mode: DeviceActionMode
    public let action: String
    public let schemaVersion: Int
    public let arguments: JSONObject
    public let ownerPresence: Bool
    public let readBack: DeviceActionReadBackKind
    public let snapshotBefore: Bool
    public let reversible: Bool
    public let risk: String
    public let expiresAt: String
    public let detail: LocalizedLine
    public let confirmLabel: LocalizedLine?
    public let declineLabel: LocalizedLine?
    public let resultMaximumBytes: Int?

    public init(
        id: String,
        mode: DeviceActionMode,
        action: String,
        schemaVersion: Int,
        arguments: JSONObject,
        ownerPresence: Bool,
        readBack: DeviceActionReadBackKind,
        snapshotBefore: Bool,
        reversible: Bool,
        risk: String,
        expiresAt: String,
        detail: LocalizedLine,
        confirmLabel: LocalizedLine? = nil,
        declineLabel: LocalizedLine? = nil,
        resultMaximumBytes: Int? = nil
    ) {
        self.id = id
        self.mode = mode
        self.action = action
        self.schemaVersion = schemaVersion
        self.arguments = arguments
        self.ownerPresence = ownerPresence
        self.readBack = readBack
        self.snapshotBefore = snapshotBefore
        self.reversible = reversible
        self.risk = risk
        self.expiresAt = expiresAt
        self.detail = detail
        self.confirmLabel = confirmLabel
        self.declineLabel = declineLabel
        self.resultMaximumBytes = resultMaximumBytes
    }

    public var expiry: Date? { DeviceActionTime.parse(expiresAt) }

    public var checkingOnly: DeviceActionDelivery {
        DeviceActionDelivery(
            id: id, mode: .verify, action: action, schemaVersion: schemaVersion, arguments: arguments,
            ownerPresence: ownerPresence, readBack: readBack, snapshotBefore: snapshotBefore, reversible: reversible,
            risk: risk, expiresAt: expiresAt, detail: detail, confirmLabel: confirmLabel, declineLabel: declineLabel,
            resultMaximumBytes: resultMaximumBytes
        )
    }
}

public enum DeviceActionOutcome: String, Codable, Sendable {
    case succeeded
    case failed
    case resultUnknown = "result_unknown"
}

public struct DeviceActionReport: Codable, Sendable, Equatable {
    public let id: String
    public let outcome: DeviceActionOutcome
    public let readBack: Bool
    public let evidence: JSONObject?
    public let reason: String?

    public init(id: String, outcome: DeviceActionOutcome, readBack: Bool, evidence: JSONObject?, reason: String?) {
        self.id = id
        self.outcome = outcome
        self.readBack = readBack
        self.evidence = evidence
        self.reason = outcome == .succeeded ? nil : reason
    }
}

public enum DeviceActionState: String, Codable, Sendable, CaseIterable {
    case waitingOwner = "waiting_owner"
    case queued
    case delivered
    case succeeded
    case failed
    case resultUnknown = "result_unknown"
    case expired
    case rejected

    public var isOpen: Bool {
        switch self {
        case .waitingOwner, .queued, .delivered, .resultUnknown: true
        default: false
        }
    }
}

public enum DeviceActionUndoState: String, Codable, Sendable, Equatable {
    case none
    case available
    case pending
    case done
    case failed
}

public struct DeviceActionView: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let deviceId: String
    public let state: DeviceActionState?
    public let rawState: String
    public let detail: LocalizedLine
    public let risk: String
    public let ownerPresence: Bool
    public let reversible: Bool
    public let reasonCode: String?
    public let reason: String?
    public let createdAt: String
    public let updatedAt: String
    public let confirmLabel: LocalizedLine?
    public let declineLabel: LocalizedLine?
    public let action: String?
    public let runId: String?
    public let threadId: String?
    public let undo: DeviceActionUndoState

    enum CodingKeys: String, CodingKey {
        case id, deviceId, state, detail, risk, ownerPresence, reversible, reasonCode, reason, createdAt, updatedAt, confirmLabel, declineLabel, action, runId, threadId, undo
    }

    public init(
        id: String,
        deviceId: String,
        rawState: String,
        detail: LocalizedLine,
        risk: String,
        ownerPresence: Bool,
        reversible: Bool,
        reasonCode: String?,
        reason: String?,
        createdAt: String,
        updatedAt: String,
        confirmLabel: LocalizedLine? = nil,
        declineLabel: LocalizedLine? = nil,
        action: String? = nil,
        runId: String? = nil,
        threadId: String? = nil,
        undo: DeviceActionUndoState = .none
    ) {
        self.id = id
        self.deviceId = deviceId
        self.rawState = rawState
        state = DeviceActionState(rawValue: rawState)
        self.detail = detail
        self.risk = risk
        self.ownerPresence = ownerPresence
        self.reversible = reversible
        self.reasonCode = reasonCode
        self.reason = reason
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.confirmLabel = confirmLabel
        self.declineLabel = declineLabel
        self.action = action
        self.runId = runId
        self.threadId = threadId
        self.undo = undo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            deviceId: try container.decode(String.self, forKey: .deviceId),
            rawState: try container.decode(String.self, forKey: .state),
            detail: try container.decode(LocalizedLine.self, forKey: .detail),
            risk: try container.decode(String.self, forKey: .risk),
            ownerPresence: try container.decode(Bool.self, forKey: .ownerPresence),
            reversible: try container.decode(Bool.self, forKey: .reversible),
            reasonCode: try container.decodeIfPresent(String.self, forKey: .reasonCode),
            reason: try container.decodeIfPresent(String.self, forKey: .reason),
            createdAt: try container.decode(String.self, forKey: .createdAt),
            updatedAt: try container.decode(String.self, forKey: .updatedAt),
            confirmLabel: try container.decodeIfPresent(LocalizedLine.self, forKey: .confirmLabel),
            declineLabel: try container.decodeIfPresent(LocalizedLine.self, forKey: .declineLabel),
            action: try container.decodeIfPresent(String.self, forKey: .action),
            runId: try container.decodeIfPresent(String.self, forKey: .runId),
            threadId: try container.decodeIfPresent(String.self, forKey: .threadId),
            undo: (try container.decodeIfPresent(String.self, forKey: .undo)).flatMap(DeviceActionUndoState.init(rawValue:)) ?? .none
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(rawState, forKey: .state)
        try container.encode(detail, forKey: .detail)
        try container.encode(risk, forKey: .risk)
        try container.encode(ownerPresence, forKey: .ownerPresence)
        try container.encode(reversible, forKey: .reversible)
        try container.encodeIfPresent(reasonCode, forKey: .reasonCode)
        try container.encodeIfPresent(reason, forKey: .reason)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(confirmLabel, forKey: .confirmLabel)
        try container.encodeIfPresent(declineLabel, forKey: .declineLabel)
        try container.encodeIfPresent(action, forKey: .action)
        try container.encodeIfPresent(runId, forKey: .runId)
        try container.encodeIfPresent(threadId, forKey: .threadId)
        try container.encode(undo, forKey: .undo)
    }

    public var updated: Date? { DeviceActionTime.parse(updatedAt) }
}

public struct DevicePolicyEntry: Codable, Sendable, Equatable, Identifiable {
    public let name: String
    public let allowed: Bool
    public let title: LocalizedLine?
    public var id: String { name }

    public init(name: String, allowed: Bool, title: LocalizedLine? = nil) {
        self.name = name
        self.allowed = allowed
        self.title = title
    }

    public var shownTitle: String {
        let line = title?.localized() ?? ""
        return line.isEmpty ? name : line
    }
}

public struct DevicePolicyView: Codable, Sendable, Equatable {
    public let revision: Int
    public let actions: [DevicePolicyEntry]

    public init(revision: Int, actions: [DevicePolicyEntry]) {
        self.revision = revision
        self.actions = actions
    }

    public var blocked: Set<String> { Set(actions.filter { !$0.allowed }.map(\.name)) }
}

public enum DevicePolicyChange: Sendable, Equatable {
    case written(DevicePolicyView)
    case conflict(DevicePolicyView)
    case ownerPresenceRequired
}

public enum DeviceActionReportReply: Sendable, Equatable {
    case recorded(state: String, replayed: Bool)
    case refused(status: Int, code: String?)
}

public enum DeviceActionUndoReply: Sendable, Equatable {
    case recorded(state: String)
    case notFound
    case notUndoable
}

public enum DeviceActionTime {
    public static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    public static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    public static func localDate(_ text: String, in timeZone: TimeZone = .current) -> Date? {
        guard text.wholeMatch(of: /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/) != nil else { return nil }
        let parts = text.split(separator: "T")
        guard let day = parts.first else { return nil }
        let dayParts = day.split(separator: "-").compactMap { Int($0) }
        guard dayParts.count == 3 else { return nil }
        var components = DateComponents()
        components.timeZone = timeZone
        components.year = dayParts[0]
        components.month = dayParts[1]
        components.day = dayParts[2]
        if parts.count == 2 {
            let clock = parts[1].split(separator: ":").compactMap { Int($0) }
            guard clock.count == 2 else { return nil }
            components.hour = clock[0]
            components.minute = clock[1]
        } else {
            components.hour = 0
            components.minute = 0
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let date = calendar.date(from: components) else { return nil }
        let back = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        guard back.year == components.year, back.month == components.month, back.day == components.day,
              back.hour == components.hour, back.minute == components.minute else { return nil }
        return date
    }

    public static func localText(_ date: Date, in timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(format: "%04d-%02d-%02dT%02d:%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }
}

public enum DeviceActionResultKind: Equatable, Sendable {
    case done
    case undone
    case notDone
    case checking
    case waiting
    case other

    public init(_ view: DeviceActionView) {
        switch view.state {
        case .succeeded: self = view.undo == .done ? .undone : .done
        case .failed, .expired, .rejected: self = .notDone
        case .resultUnknown, .delivered, .queued: self = .checking
        case .waitingOwner: self = .waiting
        case nil: self = .other
        }
    }
}
