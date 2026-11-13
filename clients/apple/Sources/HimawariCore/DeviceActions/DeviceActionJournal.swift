import Foundation

public enum DeviceActionStage: String, Codable, Sendable {
    case received
    case started
    case finished
}

public struct DeviceActionJournalEntry: Codable, Sendable, Equatable {
    public let id: String
    public let action: String
    public var stage: DeviceActionStage
    public var before: JSONObject?
    public var made: JSONObject?
    public var report: DeviceActionReport?
    public var refused = false
    public var keepUntil: Date?
    public var updatedAt: Date

    init(id: String, action: String, stage: DeviceActionStage, before: JSONObject?, made: JSONObject?, report: DeviceActionReport?, updatedAt: Date) {
        self.id = id
        self.action = action
        self.stage = stage
        self.before = before
        self.made = made
        self.report = report
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, action, stage, before, made, report, refused, keepUntil, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        action = try container.decode(String.self, forKey: .action)
        stage = try container.decode(DeviceActionStage.self, forKey: .stage)
        before = try container.decodeIfPresent(JSONObject.self, forKey: .before)
        made = try container.decodeIfPresent(JSONObject.self, forKey: .made)
        report = try container.decodeIfPresent(DeviceActionReport.self, forKey: .report)
        refused = try container.decodeIfPresent(Bool.self, forKey: .refused) ?? false
        keepUntil = try container.decodeIfPresent(Date.self, forKey: .keepUntil)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }
}

struct DeviceActionJournalFile: Codable, Sendable {
    var entries: [String: DeviceActionJournalEntry] = [:]
    var blocked: [String]?
    var reportedSupported: [String]?
}

public final class DeviceActionJournal: @unchecked Sendable {
    public static let fileName = "device-actions-journal"

    private let store: LocalStore
    private let lock = NSLock()

    public init(store: LocalStore) {
        self.store = store
    }

    public var exists: Bool { store.contains(Self.fileName) }

    public var lost: Bool {
        lock.withLock {
            guard let data = store.read(Self.fileName) else { return !store.contains(Self.fileName) }
            return (try? Self.decoder.decode(DeviceActionJournalFile.self, from: data)) == nil
        }
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }

    func load() throws -> DeviceActionJournalFile {
        try lock.withLock {
            guard let data = store.read(Self.fileName) else {
                if store.contains(Self.fileName) { throw LocalStoreError.unreadable(Self.fileName) }
                return DeviceActionJournalFile()
            }
            guard let file = try? Self.decoder.decode(DeviceActionJournalFile.self, from: data) else {
                throw LocalStoreError.unreadable(Self.fileName)
            }
            return file
        }
    }

    func save(_ file: DeviceActionJournalFile) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(file)
        try lock.withLock { try store.write(Self.fileName, data) }
    }

    func update(_ change: (inout DeviceActionJournalFile) -> Void) throws {
        var file = try load()
        change(&file)
        try save(file)
    }

    public func entry(_ id: String) throws -> DeviceActionJournalEntry? {
        try load().entries[id]
    }

    public func entries() throws -> [DeviceActionJournalEntry] {
        try load().entries.values.sorted { $0.updatedAt < $1.updatedAt }
    }
}
