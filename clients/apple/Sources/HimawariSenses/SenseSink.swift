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
    private let problems: ReadProblems
    private var flushing: Task<Void, Never>?
    private var retrying: Task<Void, Never>?
    private var waitingMirrors: [String: WaitingMirror] = [:]
    public private(set) var lastReport: SenseUploadReport?

    private struct WaitingMirror {
        let entries: [MirrorEntry]
        let forceFull: Bool
    }

    public init(queue: PerceptionQueue, mirror: MirrorSync, store: LocalStore, deletions: PerceptionDeletionSync? = nil, problems: ReadProblems = ReadProblems(transport: nil), configuration: @escaping () -> DeviceConfiguration?) {
        self.queue = queue
        self.mirror = mirror
        self.store = store
        self.deletions = deletions
        self.problems = problems
        self.configuration = configuration
    }

    public var readProblems: ReadProblems { problems }

    public var retryScheduled: Bool { retrying != nil }

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
        do {
            _ = try await mirror.sync(kind: kind, entries: fitted, batchSize: batch, forceFull: forceFull)
            waitingMirrors[kind] = nil
            if waitingMirrors.isEmpty { await problems.succeeded(.mirrorUpload) }
        } catch {
            waitingMirrors[kind] = WaitingMirror(entries: entries, forceFull: forceFull)
            scheduleRetry(after: await problems.failed(.mirrorUpload, code: ReadRetry.code(error)))
        }
    }

    public func retryWaiting() async {
        retrying?.cancel()
        retrying = nil
        let records = await queue.pendingRecords.count + queue.pendingPoints.count
        if records > 0 { await flush() }
        for (kind, waiting) in waitingMirrors.sorted(by: { $0.key < $1.key }) {
            await mirror(kind: kind, entries: waiting.entries, forceFull: waiting.forceFull)
        }
    }

    private func scheduleRetry(after failures: Int) {
        guard retrying == nil else { return }
        let delay = ReadRetry.delay(afterFailures: failures)
        retrying = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.retrying = nil
            await self.retryWaiting()
        }
    }

    public func clearMirror(kind: String) async throws {
        waitingMirrors[kind] = nil
        try await mirror.clear(kind: kind)
    }

    public func mirrorCount(kind: String) async -> Int? {
        await mirror.activeCount(kind: kind)
    }

    public func discard(_ item: SenseItem) async {
        try? await queue.discard(types: Set(item.recordTypes))
        if item == .location { try? await queue.discardTrack() }
        if let kind = item.mirrorKind { waitingMirrors[kind] = nil }
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
        let report = await queue.flush(configuration: configuration, today: Self.today())
        lastReport = report
        if let stopped = report.stoppedBy {
            scheduleRetry(after: await problems.failed(.perceptionUpload, code: ReadRetry.code(stopped)))
        } else {
            await problems.succeeded(.perceptionUpload)
        }
    }

    static func today() -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
}
