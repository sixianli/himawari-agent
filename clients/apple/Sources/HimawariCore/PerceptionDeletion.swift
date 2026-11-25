import Foundation

public enum PerceptionDeletionTarget: Sendable, Equatable, Encodable {
    case records([String])
    case episode(String)
    case day(String, deviceId: String?)
    case types([String], deviceId: String?)

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        var ids: [String] = []
        var episodeId: String?
        var day: String?
        var deviceId: String?
        var types: [String] = []
        let kind: String
        switch self {
        case let .records(value):
            kind = "records"
            ids = value
        case let .episode(value):
            kind = "episode"
            episodeId = value
        case let .day(value, device):
            kind = "day"
            day = value
            deviceId = device
        case let .types(value, device):
            kind = "types"
            types = value
            deviceId = device
        }
        try container.encode(kind, forKey: .kind)
        try container.encode(ids, forKey: .ids)
        try container.encode(episodeId, forKey: .episodeId)
        try container.encode(day, forKey: .day)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(types, forKey: .types)
    }

    enum CodingKeys: String, CodingKey { case kind, ids, episodeId, day, deviceId, types }
}

public struct PerceptionDeletionCounts: Codable, Sendable, Equatable {
    public let records: Int
    public let trackPoints: Int
    public let media: Int

    public init(records: Int, trackPoints: Int, media: Int) {
        self.records = records
        self.trackPoints = trackPoints
        self.media = media
    }

    public var removed: Int { records + trackPoints }
}

public struct PerceptionDeletionSnapshot: Codable, Sendable, Equatable {
    public let planId: String?
    public let status: String?
    public let plan: PerceptionDeletionCounts?
    public let deleted: PerceptionDeletionCounts?
    public let pendingPayloads: Int
    public let deletionRevision: Int

    public var removed: Int { (deleted ?? plan)?.removed ?? 0 }
}

public struct PerceptionDeletionScope: Codable, Sendable, Equatable {
    public let revision: Int
    public let kind: String
    public let deviceId: String?
    public let day: String?
    public let types: [String]
    public let recordIds: [String]
    public let includesTrack: Bool
    public let through: String

    public init(revision: Int, kind: String, deviceId: String?, day: String?, types: [String], recordIds: [String], includesTrack: Bool, through: String) {
        self.revision = revision
        self.kind = kind
        self.deviceId = deviceId
        self.day = day
        self.types = types
        self.recordIds = recordIds
        self.includesTrack = includesTrack
        self.through = through
    }
}

public struct PerceptionDeletionFeed: Codable, Sendable, Equatable {
    public let revision: Int
    public let latest: Int
    public let scopes: [PerceptionDeletionScope]

    public init(revision: Int, latest: Int, scopes: [PerceptionDeletionScope]) {
        self.revision = revision
        self.latest = latest
        self.scopes = scopes
    }
}

public enum PerceptionDeletionMatch {
    public static func covers(_ scope: PerceptionDeletionScope, record: PerceptionRecordUpload, thisDevice: String?, timeZone: TimeZone) -> Bool {
        if scope.kind == "records" || scope.kind == "episode" { return scope.recordIds.contains(record.id) }
        guard onDevice(scope, thisDevice), let occurred = PerceptionTime.parse(record.occurredAt), before(scope, occurred) else { return false }
        switch scope.kind {
        case "day": return scope.day == PerceptionTime.day(occurred, timeZone: timeZone)
        case "types": return scope.types.contains(record.type)
        default: return false
        }
    }

    public static func covers(_ scope: PerceptionDeletionScope, point: TrackPointUpload, thisDevice: String?, timeZone: TimeZone) -> Bool {
        guard scope.includesTrack, onDevice(scope, thisDevice), let occurred = PerceptionTime.parse(point.occurredAt), before(scope, occurred) else { return false }
        switch scope.kind {
        case "day": return scope.day == PerceptionTime.day(occurred, timeZone: timeZone)
        case "types": return true
        default: return false
        }
    }

    static func onDevice(_ scope: PerceptionDeletionScope, _ thisDevice: String?) -> Bool {
        scope.deviceId == nil || scope.deviceId == thisDevice
    }

    static func before(_ scope: PerceptionDeletionScope, _ occurred: Date) -> Bool {
        guard let through = PerceptionTime.parse(scope.through) else { return false }
        return occurred <= through
    }
}

public enum PerceptionTime {
    public static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    public static func day(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public static func shift(day: String, by days: Int) -> String? {
        guard let date = noon(day) else { return nil }
        let utc = TimeZone(identifier: "UTC") ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar.date(byAdding: .day, value: days, to: date).map { Self.day($0, timeZone: utc) }
    }

    public static func noon(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}

public protocol PerceptionDeletionSource: Sendable {
    func perceptionDeletions(after revision: Int) async throws -> PerceptionDeletionFeed
}

extension DeviceAPI: PerceptionDeletionSource {
    public func perceptionDeletions(after revision: Int) async throws -> PerceptionDeletionFeed {
        try decode(PerceptionDeletionFeed.self, try await http.send(DeviceRequest(
            method: "GET",
            path: "perception/deletions",
            query: [URLQueryItem(name: "after", value: String(revision))]
        )))
    }
}

public actor PerceptionDeletionSync {
    private let store: LocalStore
    private let source: PerceptionDeletionSource
    private let queue: PerceptionQueue
    private let thisDevice: String?
    private let timeZone: TimeZone
    private let cursorName: String
    private let pageLimit: Int

    public init(store: LocalStore, source: PerceptionDeletionSource, queue: PerceptionQueue, thisDevice: String?, timeZone: TimeZone = .current, name: String = "perception-deletions", pageLimit: Int = 20) {
        self.store = store
        self.source = source
        self.queue = queue
        self.thisDevice = thisDevice
        self.timeZone = timeZone
        cursorName = name + ".revision"
        self.pageLimit = pageLimit
    }

    public var revision: Int {
        store.read(cursorName).flatMap { String(data: $0, encoding: .utf8) }.flatMap { Int($0) } ?? 0
    }

    @discardableResult
    public func sync() async -> Int {
        var removed = 0
        var after = revision
        for _ in 0..<pageLimit {
            guard let feed = try? await source.perceptionDeletions(after: after) else { break }
            if !feed.scopes.isEmpty {
                removed += (try? await queue.discard(covering: feed.scopes, thisDevice: thisDevice, timeZone: timeZone)) ?? 0
            }
            guard feed.revision > after else { break }
            after = feed.revision
            try? store.write(cursorName, Data(String(after).utf8))
            if feed.scopes.isEmpty || after >= feed.latest { break }
        }
        return removed
    }
}

extension PerceptionQueue {
    public func discard(covering scopes: [PerceptionDeletionScope], thisDevice: String?, timeZone: TimeZone) throws -> Int {
        try discard(
            records: { record in scopes.contains { PerceptionDeletionMatch.covers($0, record: record, thisDevice: thisDevice, timeZone: timeZone) } },
            points: { point in scopes.contains { PerceptionDeletionMatch.covers($0, point: point, thisDevice: thisDevice, timeZone: timeZone) } }
        )
    }
}
