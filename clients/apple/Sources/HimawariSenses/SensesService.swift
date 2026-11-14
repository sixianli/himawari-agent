import Foundation
import HimawariCore

public enum SenseOperation {
    public static let deleteRecords = "perception.records.delete"
}

@MainActor
public protocol SensesService: AnyObject {
    var server: SenseServerView? { get }
    var deviceId: String? { get }
    var operations: Set<String> { get }
    func configuredRetention(_ key: String) -> Int?
    func authorization(_ item: SenseItem) async -> SenseAuthorization
    func requestAuthorization(_ item: SenseItem) async -> SenseAuthorization
    func alwaysAllowed(_ item: SenseItem) -> Bool?
    func requestAlways(_ item: SenseItem) async -> Bool
    func start(_ item: SenseItem)
    func stop(_ item: SenseItem) async
    func status() async throws -> PerceptionStatusSnapshot
    func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot
    func setSense(_ sense: String, enabled: Bool, revision: Int, reason: String) async throws
    func refreshServer() async
    func setRetention(key: String, days: Int?, revision: Int, reason: String) async throws
    func deleteRecords(_ item: SenseItem, reason: String) async throws -> PerceptionDeleteResult
    func mirrorCount(_ item: SenseItem) async -> Int?
    func clearMirror(_ item: SenseItem) async throws
}

@MainActor
public protocol AlwaysCollecting: SenseCollector {
    var alwaysAllowed: Bool { get }
    func requestAlways() async -> Bool
}

@MainActor
public final class LiveSensesService: SensesService {
    private let gateway: SensesGateway
    private let sink: SenseSink
    private let collectors: [SenseItem: SenseCollector]
    private let configuration: () -> DeviceConfiguration?
    private let refreshConfiguration: () async -> Void
    private var running: Set<SenseItem> = []
    public let deviceId: String?
    public let operations: Set<String>

    public init(
        api: DeviceAPI,
        store: LocalStore,
        deviceId: String?,
        confirmation: ConfirmationSigner?,
        operations: Set<String>,
        configuration: @escaping () -> DeviceConfiguration?,
        refreshConfiguration: @escaping () async -> Void
    ) {
        gateway = SensesGateway(api: api, confirmation: confirmation)
        sink = SenseSink(
            queue: PerceptionQueue(store: store, transport: api),
            mirror: MirrorSync(store: store, transport: api),
            store: store,
            configuration: configuration
        )
        collectors = SenseCollectors.all()
        self.configuration = configuration
        self.refreshConfiguration = refreshConfiguration
        self.deviceId = deviceId
        self.operations = operations
    }

    public var server: SenseServerView? { SenseServerView.from(configuration()) }

    public func configuredRetention(_ key: String) -> Int? {
        configuration()?.perception?.retentionDays?[key]
    }

    public func authorization(_ item: SenseItem) async -> SenseAuthorization {
        await collectors[item]?.authorization() ?? .unavailable
    }

    public func requestAuthorization(_ item: SenseItem) async -> SenseAuthorization {
        await collectors[item]?.requestAuthorization() ?? .unavailable
    }

    public func alwaysAllowed(_ item: SenseItem) -> Bool? {
        (collectors[item] as? AlwaysCollecting)?.alwaysAllowed
    }

    public func requestAlways(_ item: SenseItem) async -> Bool {
        await (collectors[item] as? AlwaysCollecting)?.requestAlways() ?? false
    }

    public func start(_ item: SenseItem) {
        guard let collector = collectors[item], !running.contains(item) else { return }
        running.insert(item)
        collector.start(sink)
    }

    public func stop(_ item: SenseItem) async {
        collectors[item]?.stop()
        running.remove(item)
        await sink.discard(item)
    }

    public func status() async throws -> PerceptionStatusSnapshot {
        try await gateway.status()
    }

    public func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot {
        try await gateway.day(types: item.recordTypes)
    }

    public func setSense(_ sense: String, enabled: Bool, revision: Int, reason: String) async throws {
        try await gateway.setSense(sense, enabled: enabled, expectedRevision: revision, reason: reason)
    }

    public func refreshServer() async {
        await refreshConfiguration()
    }

    public func setRetention(key: String, days: Int?, revision: Int, reason: String) async throws {
        try await gateway.setRetention(key: key, days: days, expectedRevision: revision, reason: reason)
    }

    public func deleteRecords(_ item: SenseItem, reason: String) async throws -> PerceptionDeleteResult {
        try await gateway.deleteRecords(types: item.recordTypes, deviceId: deviceId, reason: reason)
    }

    public func mirrorCount(_ item: SenseItem) async -> Int? {
        guard let kind = item.mirrorKind else { return nil }
        return await sink.mirrorCount(kind: kind)
    }

    public func clearMirror(_ item: SenseItem) async throws {
        guard let kind = item.mirrorKind else { return }
        try await sink.clearMirror(kind: kind)
    }

    public func flush() async {
        await sink.flush()
    }
}

@MainActor
enum SenseCollectors {
    static func all() -> [SenseItem: SenseCollector] {
        #if os(iOS)
        let list: [SenseCollector] = [
            LocationCollector(),
            CalendarCollector(),
            HealthCollector(),
            ContactsCollector(),
            PhotosCollector(),
            ClipboardCollector(),
        ]
        return Dictionary(uniqueKeysWithValues: list.map { ($0.item, $0) })
        #else
        return [:]
        #endif
    }
}
