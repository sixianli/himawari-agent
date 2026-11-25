import Foundation
import HimawariCore

@MainActor
public protocol SenseCollector: AnyObject {
    var item: SenseItem { get }
    func authorization() async -> SenseAuthorization
    func requestAuthorization() async -> SenseAuthorization
    func start(_ sink: SenseSink)
    func stop()
}

@MainActor
public final class SenseSink {
    private let queue: PerceptionQueue
    private let mirror: MirrorSync
    private let configuration: () -> DeviceConfiguration?
    private let store: LocalStore
    private let deletions: PerceptionDeletionSync?
    private var flushing: Task<Void, Never>?
    public private(set) var lastReport: SenseUploadReport?

    public init(queue: PerceptionQueue, mirror: MirrorSync, store: LocalStore, deletions: PerceptionDeletionSync? = nil, configuration: @escaping () -> DeviceConfiguration?) {
        self.queue = queue
        self.mirror = mirror
        self.store = store
        self.deletions = deletions
        self.configuration = configuration
    }

    public var localStore: LocalStore { store }

    public func record(_ observation: SenseObservation, id: String? = nil, captureSource: String = SenseRecordBuilder.captureSource) {
        guard let configuration = configuration(), let types = configuration.perception?.recordTypes else { return }
        guard let upload = try? SenseRecordBuilder.record(
            observation,
            id: id ?? SenseRecordBuilder.newId(),
            captureSource: captureSource,
            types: types,
            textLimit: configuration.perception?.recordTextCharacters
        ) else { return }
        let queue = queue
        Task {
            try? await queue.add(upload)
            self.scheduleFlush()
        }
    }

    public func point(_ point: TrackPointUpload) {
        let queue = queue
        Task {
            try? await queue.add(point)
            self.scheduleFlush()
        }
    }

    public func mirror(kind: String, entries: [MirrorEntry], forceFull: Bool = false) async {
        guard
            let configuration = configuration(),
            let rules = configuration.perception?.mirrorKinds?[kind],
            let batch = configuration.limit("device.mirror.batch_items").map(Int.init)
        else { return }
        let fitted = entries.compactMap { entry in
            MirrorFields.fit(entry.data, rules: rules).map { MirrorEntry(externalId: entry.externalId, data: $0) }
        }
        _ = try? await mirror.sync(kind: kind, entries: fitted, batchSize: batch, forceFull: forceFull)
    }

    public func clearMirror(kind: String) async throws {
        try await mirror.clear(kind: kind)
    }

    public func mirrorCount(kind: String) async -> Int? {
        await mirror.activeCount(kind: kind)
    }

    public func discard(_ item: SenseItem) async {
        try? await queue.discard(types: Set(item.recordTypes))
        if item == .location { try? await queue.discardTrack() }
    }

    public func scheduleFlush() {
        guard flushing == nil else { return }
        flushing = Task {
            try? await Task.sleep(for: .seconds(2))
            await self.flush()
            self.flushing = nil
        }
    }

    public func flush() async {
        guard let configuration = configuration() else { return }
        await deletions?.sync()
        lastReport = await queue.flush(configuration: configuration, today: Self.today())
    }

    static func today() -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
}
