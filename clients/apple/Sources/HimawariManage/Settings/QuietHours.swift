import Foundation
import Observation

public struct QuietHours: Decodable, Sendable, Equatable {
    public struct Rule: Decodable, Sendable, Equatable {
        public let ruleId: String
        public let summary: String
    }

    public let version: String
    public let editable: Bool
    public let enabled: Bool
    public let start: String?
    public let end: String?
    public let classes: [String]
    public let rules: [Rule]
}

public struct ClockTime: Equatable, Sendable {
    public let hour: Int
    public let minute: Int

    public init?(_ text: String?) {
        guard let parts = text?.split(separator: ":"), parts.count == 2,
              let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0..<24).contains(hour), (0..<60).contains(minute)
        else { return nil }
        self.hour = hour
        self.minute = minute
    }

    public init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }

    public var text: String { String(format: "%02d:%02d", hour, minute) }

    public var shortText: String { String(format: "%d:%02d", hour, minute) }
}

@MainActor
@Observable
public final class QuietHoursStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case unavailable
    }

    public struct Choice: Equatable, Sendable {
        public var enabled: Bool
        public var start: ClockTime
        public var end: ClockTime

        public init(enabled: Bool, start: ClockTime, end: ClockTime) {
            self.enabled = enabled
            self.start = start
            self.end = end
        }
    }

    public static let suggestedStart = ClockTime(hour: 23, minute: 0)
    public static let suggestedEnd = ClockTime(hour: 7, minute: 0)

    public private(set) var phase: Phase = .loading
    public private(set) var hours: QuietHours?
    public private(set) var draft: Choice?

    public var shown: Choice? {
        draft ?? hours.map {
            Choice(enabled: $0.enabled, start: ClockTime($0.start) ?? Self.suggestedStart, end: ClockTime($0.end) ?? Self.suggestedEnd)
        }
    }

    @ObservationIgnored private let gateway: ManageGateway

    public init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func load() async {
        do {
            let data = try await gateway.read(.v2, "quiet_hours.read")
            hours = try JSONDecoder().decode(Snapshot<QuietHours>.self, from: data).payload
            phase = .loaded
        } catch {
            if hours == nil { phase = .unavailable }
        }
    }

    public func edit(_ change: (inout Choice) -> Void) {
        guard var next = shown else { return }
        change(&next)
        draft = next
    }

    public func saveDraft(reason: (Choice) -> String) async throws {
        guard let wanted = draft else { return }
        defer { if draft == wanted { draft = nil } }
        try await set(enabled: wanted.enabled, start: wanted.start, end: wanted.end, reason: reason(wanted))
    }

    public func set(enabled: Bool, start: ClockTime, end: ClockTime, reason: String) async throws {
        guard let hours else { return }
        do {
            _ = try await gateway.command(
                .v2,
                "quiet_hours.set",
                payload: [
                    "expectedVersion": .string(hours.version),
                    "enabled": .bool(enabled),
                    "start": .string(start.text),
                    "end": .string(end.text),
                ],
                options: ManageCommandOptions(confirmReason: reason)
            )
            await load()
        } catch {
            await load()
            throw error
        }
    }
}
