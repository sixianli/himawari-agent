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
    public var updatedAt: Date
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

    func load() throws -> DeviceActionJournalFile {
        try lock.withLock {
            guard let data = store.read(Self.fileName) else {
                if store.contains(Self.fileName) { throw LocalStoreError.unreadable(Self.fileName) }
                return DeviceActionJournalFile()
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            guard let file = try? decoder.decode(DeviceActionJournalFile.self, from: data) else {
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
