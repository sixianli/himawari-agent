#if DEBUG
import Foundation
import HimawariCore

public enum DemoSensesScene: Int, CaseIterable, Sendable {
    case overview = 1
    case intro
    case systemPrompt
    case detail
    case denied
}

@MainActor
public final class DemoSensesService: SensesService {
    private var authorizations: [SenseItem: SenseAuthorization]
    private let prompt: SenseCollector?
    private let now: Date
    public let deviceId: String? = "demo-iphone"
    public let operations: Set<String> = [SenseOperation.deleteRecords]
    public let server: SenseServerView? = SenseServerView(
        state: "active",
        enabledSenses: Set(SenseItem.allCases.compactMap(\.serverSense)),
        knownTypes: nil
    )

    init(authorizations: [SenseItem: SenseAuthorization], prompt: SenseCollector?, now: Date) {
        self.authorizations = authorizations
        self.prompt = prompt
        self.now = now
    }

    public static func scene(_ scene: DemoSensesScene, now: Date = Date()) -> (model: SensesModel, opening: SenseItem?, opensAutomatically: Bool) {
        let store = MemoryLocalStore()
        let switches = SenseSwitches(store: store)
        var authorizations: [SenseItem: SenseAuthorization] = [
            .location: .allowed, .calendar: .allowed, .health: .allowed,
            .contacts: .notAsked, .photos: .denied, .clipboard: .allowed,
        ]
        let on: Set<SenseItem>
        var opening: SenseItem?
        var prompt: SenseCollector?
        switch scene {
        case .overview, .detail:
            on = [.location, .calendar, .health, .photos]
            if scene == .detail { opening = .location }
        case .intro, .systemPrompt:
            on = [.calendar, .health, .photos]
            authorizations[.location] = .notAsked
            opening = .location
            #if os(iOS)
            if scene == .systemPrompt { prompt = LocationCollector() }
            #endif
        case .denied:
            on = [.location, .calendar, .health, .photos]
            opening = .photos
        }
        for item in SenseItem.allCases {
            let seen = on.contains(item) || item == .clipboard
            try? switches.update(item) {
                $0.on = on.contains(item)
                $0.introSeen = seen
            }
        }
        let service = DemoSensesService(authorizations: authorizations, prompt: prompt, now: now)
        return (SensesModel(service: service, store: store), opening, scene == .systemPrompt)
    }

    public func configuredRetention(_ key: String) -> Int? { key == "track" ? 90 : nil }

    public func authorization(_ item: SenseItem) async -> SenseAuthorization {
        authorizations[item] ?? .notAsked
    }

    public func requestAuthorization(_ item: SenseItem) async -> SenseAuthorization {
        if let prompt, prompt.item == item {
            authorizations[item] = await prompt.requestAuthorization()
        } else if authorizations[item] == .notAsked {
            authorizations[item] = .allowed
        }
        return authorizations[item] ?? .notAsked
    }

    public func alwaysAllowed(_ item: SenseItem) -> Bool? { item == .location ? false : nil }

    public func requestAlways(_ item: SenseItem) async -> Bool { false }

    public func start(_ item: SenseItem) {}

    public func stop(_ item: SenseItem) async {}

    public func status() async throws -> PerceptionStatusSnapshot {
        try Self.decode([
            "state": "active", "pausedUntil": nil, "senses": ["location", "body", "vision"], "day": Self.dayString(now),
            "todayCount": 3, "availableSenses": ["hearing", "location", "body", "vision", "reading", "surroundings", "presence"],
            "retention": [["key": "track", "days": 90, "defaultDays": 90], ["key": "surroundings", "days": 30, "defaultDays": 30]],
            "revision": 4,
        ])
    }

    public func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot {
        let rows: [[String: Any?]] = item == .location ? [
            visit("v1", at: (8, 12), until: (12, 5), place: L.text("demo.office")),
            visit("v2", at: (12, 20), until: (12, 50), place: L.text("demo.lunch")),
            visit("v3", at: (12, 58), until: nil, place: L.text("demo.office")),
        ] : []
        return try Self.decode(["day": Self.dayString(now), "total": rows.count, "rows": rows, "nextCursor": nil])
    }

    private func visit(_ id: String, at start: (Int, Int), until end: (Int, Int)?, place: String) -> [String: Any?] {
        let arrived = time(start)
        var evidence: [[String: String]] = [
            ["name": "placeName", "value": place],
            ["name": "arrivedAtMs", "value": String(Int64(arrived.timeIntervalSince1970 * 1000))],
            ["name": "latitude", "value": "34.70240"],
            ["name": "longitude", "value": "135.49590"],
            ["name": "accuracyMeters", "value": "35"],
        ]
        if let end { evidence.append(["name": "departedAtMs", "value": String(Int64(time(end).timeIntervalSince1970 * 1000))]) }
        let record: [String: Any?] = [
            "id": id, "type": "location.visit", "sense": "location", "occurredAt": ISO8601DateFormatter().string(from: arrived),
            "deviceId": "demo-iphone", "text": nil, "textTruncated": false, "evidence": evidence,
        ]
        return ["kind": "record", "at": ISO8601DateFormatter().string(from: arrived), "record": record]
    }

    private func time(_ clock: (Int, Int), daysAgo: Int = 0) -> Date {
        let day = Calendar.current.date(byAdding: .day, value: -daysAgo, to: now) ?? now
        return Calendar.current.date(bySettingHour: clock.0, minute: clock.1, second: 0, of: day) ?? day
    }

    public func setSense(_ sense: String, enabled: Bool, revision: Int, reason: String) async throws {}

    public func refreshServer() async {}

    public func setRetention(key: String, days: Int?, revision: Int, reason: String) async throws {}

    public func deleteRecords(_ item: SenseItem, reason: String) async throws -> PerceptionDeletionSnapshot {
        try Self.deletion(records: 3)
    }

    public func dayPage(_ day: String?, cursor: String?) async throws -> PerceptionDaySnapshot {
        let today = Self.dayString(now)
        let yesterday = PerceptionTime.shift(day: today, by: -1)
        let asked = day ?? today
        var rows: [[String: Any?]] = []
        var total = 0
        if asked == today {
            rows = [
                episode("episode:00000000000000000000000000000003", from: (14, 5), to: (14, 40), senses: ["location", "body"], count: 4, preview: L.text("demo.lunch")),
                episode("episode:00000000000000000000000000000002", from: (10, 0), to: (10, 45), senses: ["hearing"], count: 1, summary: L.text("demo.meeting")),
                clipboard("perception:demo-clipboard-000001", at: (9, 12), text: L.text("demo.clipboard")),
            ]
            total = 6
        } else if asked == yesterday {
            rows = [episode("episode:00000000000000000000000000000001", from: (19, 30), to: (20, 10), senses: ["hearing", "location"], count: 3, summary: L.text("demo.dinner"), daysAgo: 1)]
            total = 3
        } else if asked == PerceptionTime.shift(day: today, by: -3) {
            total = 2
        }
        return try Self.decode(["day": day ?? today, "total": total, "rows": rows, "nextCursor": nil])
    }

    public func episode(_ episodeId: String, cursor: String?) async throws -> PerceptionEpisodeSnapshot {
        let view = episode(episodeId, from: (10, 0), to: (10, 45), senses: ["hearing", "location"], count: 2, summary: L.text("demo.meeting"))["episode"] ?? nil
        let records: [[String: Any?]] = [
            record("perception:demo-heard-0000000001", type: "hearing.utterance", sense: "hearing", at: (10, 3), text: L.text("demo.heard")),
            record("perception:demo-place-0000000001", type: "location.visit", sense: "location", at: (10, 0), text: nil, place: L.text("demo.office")),
        ]
        return try Self.decode(["episode": view, "records": records, "nextCursor": nil])
    }

    public func delete(_ target: PerceptionDeletionTarget, reason: String) async throws -> PerceptionDeletionSnapshot {
        try Self.deletion(records: 1)
    }

    static func deletion(records: Int) throws -> PerceptionDeletionSnapshot {
        let counts: [String: Any] = ["records": records, "trackPoints": 0, "media": 0]
        return try decode(["planId": "demo", "status": "verified", "plan": counts, "deleted": counts, "pendingPayloads": 0, "deletionRevision": 1])
    }

    private func episode(_ id: String, from start: (Int, Int), to end: (Int, Int), senses: [String], count: Int, summary: String? = nil, preview: String? = nil, daysAgo: Int = 0) -> [String: Any?] {
        let started = time(start, daysAgo: daysAgo)
        let view: [String: Any?] = [
            "id": id, "startedAt": ISO8601DateFormatter().string(from: started), "endedAt": ISO8601DateFormatter().string(from: time(end, daysAgo: daysAgo)),
            "recordCount": count, "senses": senses, "types": [String](), "preview": preview, "summary": summary,
        ]
        return ["kind": "episode", "at": ISO8601DateFormatter().string(from: started), "episode": view.mapValues { $0 ?? NSNull() }, "record": nil]
    }

    private func clipboard(_ id: String, at clock: (Int, Int), text: String) -> [String: Any?] {
        let row = record(id, type: "clipboard.item", sense: "reading", at: clock, text: text)
        return ["kind": "record", "at": row["occurredAt"] ?? nil, "episode": nil, "record": row.mapValues { $0 ?? NSNull() }]
    }

    private func record(_ id: String, type: String, sense: String, at clock: (Int, Int), text: String?, place: String? = nil) -> [String: Any?] {
        [
            "id": id, "type": type, "sense": sense, "occurredAt": ISO8601DateFormatter().string(from: time(clock)),
            "deviceId": "demo-iphone", "text": text, "textTruncated": false,
            "evidence": place.map { [["name": "placeName", "value": $0]] } ?? [[String: String]](),
        ]
    }

    public func mirrorCount(_ item: SenseItem) async -> Int? {
        switch item {
        case .calendar: 128
        case .contacts: 0
        default: nil
        }
    }

    public func clearMirror(_ item: SenseItem) async throws {}

    static func dayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func decode<T: Decodable>(_ object: [String: Any?]) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object.mapValues { $0 ?? NSNull() })
        return try JSONDecoder().decode(T.self, from: data)
    }
}
#endif
