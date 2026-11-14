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

    private func time(_ clock: (Int, Int)) -> Date {
        Calendar.current.date(bySettingHour: clock.0, minute: clock.1, second: 0, of: now) ?? now
    }

    public func setSense(_ sense: String, enabled: Bool, revision: Int, reason: String) async throws {}

    public func refreshServer() async {}

    public func setRetention(key: String, days: Int?, revision: Int, reason: String) async throws {}

    public func deleteRecords(_ item: SenseItem, reason: String) async throws -> PerceptionDeleteResult {
        try Self.decode(["deleted": ["records": 3, "trackPoints": 0, "media": 0], "decisionId": "demo"])
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
