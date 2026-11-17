import Foundation

public struct TrackPointUpload: Codable, Sendable, Equatable {
    public let occurredAt: String
    public let latitude: Double
    public let longitude: Double
    public let accuracyMeters: Double?
    public let speedMetersPerSecond: Double?

    public init(at date: Date, latitude: Double, longitude: Double, accuracyMeters: Double?, speedMetersPerSecond: Double?) {
        occurredAt = HandoverPlanner.timestamp(date)
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters.flatMap { $0 >= 0 ? $0 : nil }
        self.speedMetersPerSecond = speedMetersPerSecond.flatMap { $0 >= 0 ? $0 : nil }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(occurredAt, forKey: .occurredAt)
        try container.encode(latitude, forKey: .latitude)
        try container.encode(longitude, forKey: .longitude)
        try container.encodeIfPresent(accuracyMeters, forKey: .accuracyMeters)
        try container.encodeIfPresent(speedMetersPerSecond, forKey: .speedMetersPerSecond)
    }

    var key: String { "\(occurredAt)|\(latitude)|\(longitude)" }
}

public struct TrackIngestResult: Codable, Sendable, Equatable {
    public let stored: Int
    public let duplicates: Int
    public let limitReached: Int
}

public struct MirrorItemUpload: Codable, Sendable, Equatable {
    public let externalId: String
    public let version: Int
    public let deleted: Bool?
    public let data: [String: JSONScalar]?

    public static func present(_ externalId: String, version: Int, data: [String: JSONScalar]) -> MirrorItemUpload {
        MirrorItemUpload(externalId: externalId, version: version, deleted: nil, data: data)
    }

    public static func removed(_ externalId: String, version: Int) -> MirrorItemUpload {
        MirrorItemUpload(externalId: externalId, version: version, deleted: true, data: nil)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(externalId, forKey: .externalId)
        try container.encode(version, forKey: .version)
        if deleted == true { try container.encode(true, forKey: .deleted) }
        try container.encodeIfPresent(data, forKey: .data)
    }
}

public struct MirrorSyncResult: Codable, Sendable, Equatable {
    public let applied: Int
    public let stale: Int
    public let removed: Int
    public let active: Int?
}

extension DeviceAPI {
    public func track(_ points: [TrackPointUpload]) async throws -> TrackIngestResult {
        struct Body: Encodable { let points: [TrackPointUpload] }
        let data = try await http.send(DeviceRequest(method: "POST", path: "track", body: try JSONEncoder().encode(Body(points: points))))
        return try decode(TrackIngestResult.self, data)
    }

    public func mirror(kind: String, mode: String, syncId: String, final: Bool, items: [MirrorItemUpload]) async throws -> MirrorSyncResult {
        struct Body: Encodable {
            let kind: String
            let mode: String
            let syncId: String
            let final: Bool
            let items: [MirrorItemUpload]
        }
        let body = try JSONEncoder().encode(Body(kind: kind, mode: mode, syncId: syncId, final: final, items: items))
        return try decode(MirrorSyncResult.self, try await http.send(DeviceRequest(method: "POST", path: "mirror", body: body)))
    }
}

public protocol PerceptionTransport: Sendable {
    func ingest(_ records: [PerceptionRecordUpload]) async throws -> [String: PerceptionIngestOutcome]
    func track(_ points: [TrackPointUpload]) async throws -> TrackIngestResult
}

extension DeviceAPI: PerceptionTransport {}

public struct SenseUploadReport: Sendable, Equatable {
    public var stored = 0
    public var duplicates = 0
    public var turnedAway = 0
    public var malformed = 0
    public var limitReached = false
    public var waiting = 0
    public var stoppedBy: DeviceAPIError?

    public init() {}
}

public actor PerceptionQueue {
    private let store: LocalStore
    private let transport: PerceptionTransport
    private let recordsName: String
    private let trackName: String
    private let pauseName: String
    private var records: [PerceptionRecordUpload]
    private var points: [TrackPointUpload]

    public init(store: LocalStore, transport: PerceptionTransport, name: String = "perception-queue") {
        self.store = store
        self.transport = transport
        recordsName = name + ".records.json"
        trackName = name + ".track.json"
        pauseName = name + ".limit-day"
        records = store.read(recordsName).flatMap { try? JSONDecoder().decode([PerceptionRecordUpload].self, from: $0) } ?? []
        points = store.read(trackName).flatMap { try? JSONDecoder().decode([TrackPointUpload].self, from: $0) } ?? []
    }

    public var pendingRecords: [PerceptionRecordUpload] { records }
    public var pendingPoints: [TrackPointUpload] { points }

    public func add(_ upload: PerceptionRecordUpload) throws {
        guard !records.contains(where: { $0.id == upload.id }) else { return }
        records.append(upload)
        try save()
    }

    public func add(_ point: TrackPointUpload) throws {
        guard !points.contains(where: { $0.key == point.key }) else { return }
        points.append(point)
        try save()
    }

    public func discard(types: Set<String>) throws {
        records.removeAll { types.contains($0.type) }
        try save()
    }

    public func discardTrack() throws {
        points.removeAll()
        try save()
    }

    public func flush(configuration: DeviceConfiguration, today: String) async -> SenseUploadReport {
        var report = SenseUploadReport()
        if let blocked = store.read(pauseName).flatMap({ String(data: $0, encoding: .utf8) }), blocked == today {
            report.limitReached = true
            report.waiting = records.count
            return report
        }
        if let size = configuration.limit("device.perception.batch_records").map(Int.init), size > 0 {
            await flushRecords(batchSize: size, today: today, report: &report)
        }
        if report.stoppedBy == nil, let size = configuration.limit("device.track.batch_points").map(Int.init), size > 0 {
            await flushTrack(batchSize: size, report: &report)
        }
        report.waiting = records.count + points.count
        return report
    }

    private func flushRecords(batchSize: Int, today: String, report: inout SenseUploadReport) async {
        var pending = Array(records.prefix(batchSize))
        while !pending.isEmpty {
            do {
                let outcomes = try await transport.ingest(pending)
                var settled = Set<String>()
                for record in pending {
                    switch outcomes[record.id] {
                    case .stored: report.stored += 1; settled.insert(record.id)
                    case .duplicate: report.duplicates += 1; settled.insert(record.id)
                    case .senseOff, .paused: report.turnedAway += 1; settled.insert(record.id)
                    case .limitReached: report.limitReached = true
                    case nil: break
                    }
                }
                records.removeAll { settled.contains($0.id) }
                try? save()
                if report.limitReached {
                    try? store.write(pauseName, Data(today.utf8))
                    return
                }
                if settled.isEmpty { return }
                pending = Array(records.prefix(batchSize))
            } catch let error as DeviceAPIError {
                if case let .server(status, _, _, _) = error, status == 400 || status == 422 {
                    if pending.count == 1 {
                        records.removeAll { $0.id == pending[0].id }
                        report.malformed += 1
                        try? save()
                        pending = Array(records.prefix(batchSize))
                    } else {
                        pending = Array(pending.prefix(pending.count / 2))
                    }
                    continue
                }
                report.stoppedBy = error
                return
            } catch {
                report.stoppedBy = .invalidResponse
                return
            }
        }
    }

    private func flushTrack(batchSize: Int, report: inout SenseUploadReport) async {
        var size = batchSize
        while !points.isEmpty {
            let batch = Array(points.prefix(size))
            do {
                let result = try await transport.track(batch)
                points.removeFirst(batch.count)
                try? save()
                report.stored += result.stored
                report.duplicates += result.duplicates
                if result.limitReached > 0 {
                    report.limitReached = true
                    return
                }
                size = batchSize
            } catch let error as DeviceAPIError {
                if case let .server(status, _, _, _) = error, status == 400 || status == 422 {
                    if batch.count == 1 {
                        points.removeFirst()
                        report.malformed += 1
                        try? save()
                        size = batchSize
                    } else {
                        size = batch.count / 2
                    }
                    continue
                }
                report.stoppedBy = error
                return
            } catch {
                report.stoppedBy = .invalidResponse
                return
            }
        }
    }

    private func save() throws {
        try store.write(recordsName, records.isEmpty ? nil : try JSONEncoder().encode(records))
        try store.write(trackName, points.isEmpty ? nil : try JSONEncoder().encode(points))
    }
}
