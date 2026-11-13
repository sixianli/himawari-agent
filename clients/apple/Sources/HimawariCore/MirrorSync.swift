import Foundation

public protocol MirrorTransport: Sendable {
    func mirror(kind: String, mode: String, syncId: String, final: Bool, items: [MirrorItemUpload]) async throws -> MirrorSyncResult
}

extension DeviceAPI: MirrorTransport {}

public struct MirrorEntry: Sendable, Equatable {
    public let externalId: String
    public let data: [String: JSONScalar]

    public init(externalId: String, data: [String: JSONScalar]) {
        self.externalId = externalId
        self.data = data
    }
}

struct MirrorLedger: Codable, Equatable {
    struct Known: Codable, Equatable {
        var digest: String
        var version: Int
    }

    var items: [String: Known] = [:]
    var lastFullSyncMs: Int64 = 0
    var active: Int?
}

public enum MirrorFields {
    public static func fit(_ data: [String: JSONScalar], rules: [String: PerceptionFieldRule]) -> [String: JSONScalar]? {
        var fitted: [String: JSONScalar] = [:]
        for (key, value) in data {
            guard let rule = rules[key], let kept = try? SenseRecordBuilder.fit(value, field: rule, key: key) else { continue }
            fitted[key] = kept
        }
        for (key, rule) in rules where rule.optional != true && fitted[key] == nil {
            return nil
        }
        return fitted
    }
}

public actor MirrorSync {
    private let store: LocalStore
    private let transport: MirrorTransport
    private let now: @Sendable () -> Date
    private let fullEvery: TimeInterval

    public init(store: LocalStore, transport: MirrorTransport, fullEvery: TimeInterval = 86_400, now: @escaping @Sendable () -> Date = Date.init) {
        self.store = store
        self.transport = transport
        self.fullEvery = fullEvery
        self.now = now
    }

    public func activeCount(kind: String) -> Int? {
        ledger(kind).active
    }

    @discardableResult
    public func sync(kind: String, entries: [MirrorEntry], batchSize: Int, forceFull: Bool = false) async throws -> MirrorSyncResult? {
        guard batchSize > 0 else { return nil }
        var ledger = ledger(kind)
        let nowMs = Int64((now().timeIntervalSince1970 * 1000).rounded())
        let full = forceFull || ledger.items.isEmpty || Double(nowMs - ledger.lastFullSyncMs) >= fullEvery * 1000
        var next: [String: MirrorLedger.Known] = [:]
        var changed: [MirrorItemUpload] = []
        var all: [MirrorItemUpload] = []
        let ordered = entries.sorted { $0.externalId < $1.externalId }
        for entry in ordered {
            let digest = Self.digest(entry.data)
            let known = ledger.items[entry.externalId]
            let version = known?.digest == digest ? known!.version : Self.nextVersion(after: known?.version, nowMs: nowMs)
            next[entry.externalId] = MirrorLedger.Known(digest: digest, version: version)
            let upload = MirrorItemUpload.present(entry.externalId, version: version, data: entry.data)
            all.append(upload)
            if known?.digest != digest { changed.append(upload) }
        }
        let gone = ledger.items.keys.filter { next[$0] == nil }.sorted()
        if !full {
            for externalId in gone {
                changed.append(.removed(externalId, version: Self.nextVersion(after: ledger.items[externalId]?.version, nowMs: nowMs)))
            }
            if changed.isEmpty { return nil }
        }
        let items = full ? all : changed
        let result = try await send(kind: kind, mode: full ? "full" : "delta", items: items, batchSize: batchSize)
        ledger.items = next
        if full { ledger.lastFullSyncMs = nowMs }
        ledger.active = result.active ?? ledger.active
        try save(kind, ledger)
        return result
    }

    @discardableResult
    public func clear(kind: String) async throws -> MirrorSyncResult {
        let result = try await send(kind: kind, mode: "full", items: [], batchSize: 1)
        try save(kind, MirrorLedger(items: [:], lastFullSyncMs: 0, active: result.active ?? 0))
        return result
    }

    private func send(kind: String, mode: String, items: [MirrorItemUpload], batchSize: Int) async throws -> MirrorSyncResult {
        let syncId = RandomToken.base64URL(byteCount: 18)
        let batches = items.isEmpty ? [[]] : stride(from: 0, to: items.count, by: batchSize).map { Array(items[$0..<min($0 + batchSize, items.count)]) }
        var last: MirrorSyncResult?
        for (index, batch) in batches.enumerated() {
            last = try await transport.mirror(kind: kind, mode: mode, syncId: syncId, final: index == batches.count - 1, items: batch)
        }
        guard let last else { throw DeviceAPIError.invalidResponse }
        return last
    }

    static func nextVersion(after previous: Int?, nowMs: Int64) -> Int {
        max((previous ?? 0) + 1, Int(nowMs))
    }

    static func digest(_ data: [String: JSONScalar]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bytes = (try? encoder.encode(data)) ?? Data()
        return Hashing.sha256(bytes).base64URLEncodedString()
    }

    private func ledger(_ kind: String) -> MirrorLedger {
        store.read(Self.name(kind)).flatMap { try? JSONDecoder().decode(MirrorLedger.self, from: $0) } ?? MirrorLedger()
    }

    private func save(_ kind: String, _ ledger: MirrorLedger) throws {
        try store.write(Self.name(kind), try JSONEncoder().encode(ledger))
    }

    static func name(_ kind: String) -> String { "mirror-\(kind).json" }
}
